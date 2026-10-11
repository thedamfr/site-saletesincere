#!/usr/bin/env python3
"""Control only the disposable Site issue 56 guest; never the host or another VM."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import select
import selectors
import signal
import subprocess
import sys
import time
import uuid

KIND = 'site-issue56-qualification'
HOSTNAME = 'site-issue56'
SSH_PORT = 22856
HTTP_PORT = 31856
BOUNDARY_BYTES = 16384
# job-active may first wait for a previous 60-second lease and supervision.
BOUNDARY_TIMEOUT = 185
BOUNDARY_COMMAND = 'sudo -n python3 /home/ubuntu/qualification/observe-boundary.py --mode vm'


def private_state(value):
    path = Path(value)
    if path.is_symlink():
        raise RuntimeError('State directory must not be a symlink')
    path = path.resolve()
    if not path.is_dir() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
        raise RuntimeError('Private owned state directory required')
    return path


def identity_at(state):
    marker = state / 'identity.json'
    if marker.is_symlink():
        raise RuntimeError('Identity must not be a symlink')
    identity = json.loads(marker.read_text())
    if identity.get('kind') != KIND or identity.get('hostname') != HOSTNAME:
        raise RuntimeError('Wrong guest identity')
    uuid.UUID(identity['uuid'])
    if identity.get('sshPort') != SSH_PORT:
        raise RuntimeError('Wrong guest SSH port')
    if (state / 'disk.qcow2').is_symlink():
        raise RuntimeError('Guest disk must not be a symlink')
    return identity


def owned_pid(state, identity):
    pidfile = state / 'qemu.pid'
    if not pidfile.exists():
        return None
    if pidfile.is_symlink():
        raise RuntimeError('PID file must not be a symlink')
    pid = int(pidfile.read_text())
    if pid <= 1:
        raise RuntimeError('Unsafe PID')
    try:
        command = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
    except FileNotFoundError:
        return None
    expected = [b'-uuid', identity['uuid'].encode()]
    uuid_matches = any(command[i:i+2] == expected for i in range(len(command)-1))
    disk = f'file={state / "disk.qcow2"},format=qcow2,if=virtio'.encode()
    if not command or Path(os.fsdecode(command[0])).name != 'qemu-system-x86_64' or not uuid_matches or disk not in command:
        raise RuntimeError('PID belongs to another process')
    if Path(f'/proc/{pid}').stat().st_uid != os.getuid():
        raise RuntimeError('QEMU belongs to another user')
    return pid


def ssh_args(state):
    return ['ssh', '-p', str(SSH_PORT), '-i', str(state / 'ssh-key'),
            '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
            '-o', 'StrictHostKeyChecking=accept-new',
            '-o', f'UserKnownHostsFile={state / "known_hosts"}', 'ubuntu@127.0.0.1']


def guest_identity(state):
    result = subprocess.run([*ssh_args(state), 'hostname; cat /proc/sys/kernel/random/boot_id'],
                            stdin=subprocess.DEVNULL, text=True, capture_output=True, check=True, timeout=15)
    lines = result.stdout.strip().splitlines()
    if len(lines) != 2 or lines[0] != HOSTNAME:
        raise RuntimeError('Wrong guest hostname')
    uuid.UUID(lines[1])
    return lines[1]


def record(state, result):
    result = {'timestamp': time.time(), 'monotonicSeconds': time.monotonic(), **result}
    with (state / 'operations.jsonl').open('a') as output:
        output.write(json.dumps(result) + '\n')
        output.flush()
        os.fsync(output.fileno())
    print(json.dumps(result), flush=True)


def validate_boundary_spec(specification):
    required = {'containerId', 'podName', 'imageDigest', 'dbOptions', 'condition'}
    if not isinstance(specification, dict) or set(specification) != required:
        raise RuntimeError('Invalid boundary specification fields')
    patterns = {'containerId': r'[a-f0-9]{64}', 'podName': r'web-[a-z0-9]+-[a-z0-9]+',
                'imageDigest': r'sha256:[a-f0-9]{64}'}
    for key, pattern in patterns.items():
        if not isinstance(specification[key], str) or not re.fullmatch(pattern, specification[key]):
            raise RuntimeError('Invalid boundary target identity')
    condition = specification['condition']
    if not isinstance(condition, dict) or set(condition) != {'kind', 'jobId', 'minRetryCount'}:
        raise RuntimeError('Invalid boundary condition fields')
    if condition['kind'] != 'job-active' or type(condition['minRetryCount']) is not int or not 0 <= condition['minRetryCount'] <= 100:
        raise RuntimeError('Unsupported boundary condition')
    try:
        if str(uuid.UUID(condition['jobId'])) != condition['jobId']:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise RuntimeError('Invalid boundary job identity') from None
    options = specification['dbOptions']
    if not isinstance(options, dict) or set(options) != {'host', 'port', 'database', 'user', 'password'}:
        raise RuntimeError('Invalid qualification database fields')
    targets = {('postgres', 5432), ('127.0.0.1', 25456), ('127.0.0.1', 30432), ('10.0.2.15', 30432)}
    if not isinstance(options['host'], str) or type(options['port']) is not int or (options['host'], options['port']) not in targets:
        raise RuntimeError('Boundary database must belong to the qualification guest')
    if not isinstance(options['database'], str) or not re.fullmatch(r'site_qualification(?:_[a-z0-9]{1,24})?', options['database']):
        raise RuntimeError('Invalid qualification database name')
    if options['user'] not in ('site_qualification', 'site_issue56_app') or not isinstance(options['password'], str) or not 16 <= len(options['password']) <= 1024:
        raise RuntimeError('Invalid qualification database credentials')


def close_observer(child):
    if child is None:
        return
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=1)
    child.stdout.close()
    if not child.stdin.closed:
        child.stdin.close()


def observe_boundary(state, specification, boot_id):
    """Read one bounded confirmation from a fixed guest observer, never a shell argument."""
    request = {**specification, 'expectedBootId': boot_id}
    child = subprocess.Popen([*ssh_args(state), BOUNDARY_COMMAND], stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        child.stdin.write(json.dumps(request).encode() + b'\n')
        child.stdin.close()
        deadline = time.monotonic() + BOUNDARY_TIMEOUT
        pending = b''
        total = 0
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise RuntimeError('Boundary observer timed out')
                if time.monotonic() > deadline:
                    raise RuntimeError('Boundary observer timed out')
                chunk = os.read(child.stdout.fileno(), 4096)
                if not chunk:
                    raise RuntimeError('Boundary observer ended without confirmation')
                total += len(chunk)
                if total > BOUNDARY_BYTES:
                    raise RuntimeError('Boundary observer response exceeded limit')
                pending += chunk
                while b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    try:
                        result = json.loads(line)
                    except (ValueError, UnicodeError):
                        raise RuntimeError('Boundary observer returned invalid JSON') from None
                    if not isinstance(result, dict):
                        raise RuntimeError('Boundary observer returned invalid confirmation')
                    if result.get('event') == 'armed':
                        continue
                    return result, child
    except (BrokenPipeError, OSError):
        close_observer(child)
        raise RuntimeError('Boundary observer transport failed') from None
    except BaseException:
        close_observer(child)
        raise


def crash_when(state, identity, pid, boot_id, specification):
    validate_boundary_spec(specification)
    disk = (state / 'disk.qcow2').stat()
    disk_identity = (disk.st_dev, disk.st_ino)
    descriptor = os.pidfd_open(pid)
    observer = None
    try:
        poller = select.poll()
        poller.register(descriptor, select.POLLIN | select.POLLHUP | select.POLLERR)
        if poller.poll(0) or identity_at(state) != identity or owned_pid(state, identity) != pid:
            raise RuntimeError('Guest identity changed before arming')
        record(state, {'operation': 'crash-when-armed', 'previousBootId': boot_id, 'pid': pid,
                       'uuid': identity['uuid'], 'condition': specification['condition']})
        confirmation, observer = observe_boundary(state, specification, boot_id)
        confirmed_at = time.monotonic()
        expected = {'conditionConfirmed': True, 'bootId': boot_id,
                    **{key: specification[key] for key in ('containerId', 'podName', 'imageDigest')}}
        if any(type(confirmation.get(key)) is not type(value) or confirmation.get(key) != value for key, value in expected.items()):
            raise RuntimeError('Boundary confirmation does not match the armed guest')
        current_disk = (state / 'disk.qcow2').stat()
        if (poller.poll(0) or identity_at(state) != identity or owned_pid(state, identity) != pid
                or (current_disk.st_dev, current_disk.st_ino) != disk_identity):
            raise RuntimeError('Guest identity changed before conditional crash')
        # No SSH or fsync lies between this local revalidation and the signal.
        signal.pidfd_send_signal(descriptor, signal.SIGKILL)
        signal_at = time.monotonic()
        record(state, {'operation': 'crash-when-sent', 'previousBootId': boot_id, 'pid': pid,
                       'condition': specification['condition'], 'confirmedAtMonotonic': confirmed_at,
                       'signalAtMonotonic': signal_at, 'localSignalDelayMs': round((signal_at - confirmed_at) * 1000, 3)})
    except (RuntimeError, OSError):
        record(state, {'operation': 'crash-when-refused', 'previousBootId': boot_id, 'pid': pid})
        raise
    finally:
        os.close(descriptor)
        close_observer(observer)


def prepare(state, args):
    if (state / 'identity.json').exists() or (state / 'disk.qcow2').exists():
        raise RuntimeError('Existing guest is never overwritten')
    if not args.base_image or not args.checksums:
        raise RuntimeError('prepare requires --base-image and --checksums')
    expected = next(line.split()[0] for line in Path(args.checksums).read_text().splitlines()
                    if line.split()[-1].lstrip('*') == 'noble-server-cloudimg-amd64.img')
    image = Path(args.base_image).resolve()
    with image.open('rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    if digest != expected:
        raise RuntimeError('Ubuntu image checksum mismatch')
    subprocess.run(['cp', '--reflink=auto', str(image), str(state / 'ubuntu.img')], check=True)
    subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(state / 'ssh-key')], check=True)
    identity = {'kind': KIND, 'hostname': HOSTNAME, 'uuid': str(uuid.uuid4()),
                'imageSha256': digest, 'sshPort': SSH_PORT, 'httpPort': HTTP_PORT}
    public = (state / 'ssh-key.pub').read_text().strip()
    (state / 'user-data').write_text('#cloud-config\nhostname: site-issue56\n'
        'ssh_pwauth: false\npackage_update: false\npackage_upgrade: false\nusers:\n'
        '  - name: ubuntu\n    groups: sudo\n    sudo: ALL=(ALL) NOPASSWD:ALL\n'
        '    shell: /bin/bash\n    lock_passwd: true\n    ssh_authorized_keys:\n'
        f'      - {public}\n')
    (state / 'meta-data').write_text(f'instance-id: {identity["uuid"]}\nlocal-hostname: {HOSTNAME}\n')
    subprocess.run(['cloud-localds', str(state / 'seed.img'), str(state / 'user-data'), str(state / 'meta-data')], check=True)
    subprocess.run(['qemu-img', 'create', '-f', 'qcow2', '-F', 'qcow2', '-b', str(state / 'ubuntu.img'),
                    str(state / 'disk.qcow2'), '30G'], check=True)
    (state / 'identity.json').write_text(json.dumps(identity))
    record(state, {'operation': 'prepare', 'imageSha256': digest, 'uuid': identity['uuid']})


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'start', 'status', 'tunnel', 'shutdown', 'crash', 'crash-when', 'stop'])
    parser.add_argument('--state', required=True)
    parser.add_argument('--base-image')
    parser.add_argument('--checksums')
    args = parser.parse_args()
    state = private_state(args.state)
    if args.action == 'prepare':
        prepare(state, args)
        return
    identity = identity_at(state)
    pid = owned_pid(state, identity)
    if args.action == 'start':
        if pid:
            raise RuntimeError('Owned guest already running')
        record(state, {'operation': 'start', 'uuid': identity['uuid'], 'accelerator': 'tcg'})
        os.nice(10)
        os.execvp('qemu-system-x86_64', ['qemu-system-x86_64', '-name', HOSTNAME, '-uuid', identity['uuid'],
            '-accel', 'tcg,thread=multi', '-cpu', 'max', '-smp', '2', '-m', '6144', '-display', 'none',
            '-drive', f'file={state / "disk.qcow2"},format=qcow2,if=virtio',
            '-drive', f'file={state / "seed.img"},format=raw,if=virtio,readonly=on',
            '-netdev', f'user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:{SSH_PORT}-:22,hostfwd=tcp:127.0.0.1:{HTTP_PORT}-:30080',
            '-device', 'virtio-net-pci,netdev=net0', '-serial', f'file:{state / "console.log"}',
            '-pidfile', str(state / 'qemu.pid')])
    if not pid:
        if args.action == 'status':
            print(json.dumps({'running': False}))
            return
        raise RuntimeError('Owned guest is not running')
    before = guest_identity(state)
    if args.action == 'crash-when':
        content = sys.stdin.buffer.read(BOUNDARY_BYTES + 1)
        if len(content) > BOUNDARY_BYTES:
            raise RuntimeError('Boundary specification exceeded limit')
        try:
            specification = json.loads(content)
        except (ValueError, UnicodeError):
            raise RuntimeError('Invalid boundary specification JSON') from None
        crash_when(state, identity, pid, before, specification)
        return
    if args.action == 'status':
        print(json.dumps({'running': True, 'pid': pid, 'bootId': before, 'hostname': HOSTNAME}))
        return
    if args.action == 'tunnel':
        command = ssh_args(state)
        os.execvp('ssh', [*command[:-1], '-o', 'ExitOnForwardFailure=yes',
            '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3', '-N',
            '-L', '127.0.0.1:25456:10.0.2.15:30432',
            '-R', '10.0.2.15:31857:127.0.0.1:31857', command[-1]])
    if args.action == 'crash':
        # Recheck after SSH; signal only the same QEMU via a race-safe pidfd.
        descriptor = os.pidfd_open(pid)
        try:
            if owned_pid(state, identity) != pid:
                raise RuntimeError('Guest identity changed before crash')
            record(state, {'operation': 'crash-request', 'previousBootId': before, 'pid': pid})
            signal.pidfd_send_signal(descriptor, signal.SIGKILL)
        finally:
            os.close(descriptor)
        record(state, {'operation': 'crash-sent', 'previousBootId': before, 'pid': pid})
        return
    record(state, {'operation': 'shutdown-request', 'previousBootId': before, 'pid': pid})
    result = subprocess.run([*ssh_args(state), 'sudo -n systemctl poweroff'], capture_output=True, text=True, timeout=20)
    if result.returncode not in (0, 255):
        raise RuntimeError('Guest shutdown refused')
    record(state, {'operation': 'shutdown-sent', 'previousBootId': before, 'sshExit': result.returncode})


if __name__ == '__main__':
    main()
