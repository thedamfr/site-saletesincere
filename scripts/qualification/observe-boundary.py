#!/usr/bin/env python3
"""Observe only the disposable guest; signal its exact app from an ancestor PID namespace."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import select
import signal
import socket
import subprocess
import sys
import time
import uuid

K3S = '/usr/local/bin/k3s'
NAMESPACE = 'site-issue56'
APPLICATION_NAME = 'qualification-boundary-observer'


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def validate_spec(spec):
    require(isinstance(spec, dict), 'invalid_spec')
    require(re.fullmatch(r'[a-f0-9]{64}', str(spec.get('containerId', ''))) is not None, 'invalid_container_id')
    require(re.fullmatch(r'web-[a-z0-9-]{1,240}', str(spec.get('podName', ''))) is not None, 'invalid_pod_name')
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', str(spec.get('imageDigest', ''))) is not None, 'invalid_image_digest')
    options = spec.get('dbOptions')
    require(isinstance(options, dict), 'invalid_database_options')
    require(options.get('host') == '127.0.0.1' and options.get('port') == 25456, 'invalid_database_target')
    require(re.fullmatch(r'site_qualification(?:_[a-z0-9]{1,24})?', str(options.get('database', ''))) is not None,
            'invalid_database_name')
    condition = spec.get('condition')
    require(isinstance(condition, dict), 'invalid_condition')
    if condition.get('kind') == 'sql-lock':
        require(type(condition.get('key')) is int and 0 < condition['key'] < 2**31, 'invalid_lock_key')
    elif condition.get('kind') == 'job-active':
        value = condition.get('jobId')
        require(isinstance(value, str) and str(uuid.UUID(value)) == value, 'invalid_job_id')
        require(type(condition.get('minRetryCount')) is int and 0 <= condition['minRetryCount'] < 2**31,
                'invalid_retry_count')
    else:
        raise RuntimeError('unsupported_condition')
    if 'expectedBootId' in spec:
        require(str(uuid.UUID(spec['expectedBootId'])) == spec['expectedBootId'], 'invalid_boot_id')
    return spec


def read_boot_id():
    return str(uuid.UUID(Path('/proc/sys/kernel/random/boot_id').read_text().strip()))


def validate_container(spec, inspected):
    status = inspected.get('status', {})
    labels = status.get('labels', {})
    require(status.get('id') == spec['containerId'], 'container_identity_changed')
    require(status.get('state') == 'CONTAINER_RUNNING', 'container_not_running')
    require(labels.get('io.kubernetes.pod.namespace') == NAMESPACE, 'wrong_container_namespace')
    require(labels.get('io.kubernetes.pod.name') == spec['podName'], 'wrong_container_pod')
    require(status.get('metadata', {}).get('name') == 'web'
            and labels.get('io.kubernetes.container.name') == 'web', 'wrong_container_name')
    require(bool(labels.get('io.kubernetes.pod.uid')), 'missing_pod_identity')
    require(status.get('imageRef', '').split('@')[-1] == spec['imageDigest'], 'wrong_container_image')
    pid = inspected.get('info', {}).get('pid')
    require(type(pid) is int and pid > 1, 'invalid_container_pid')
    return pid


def validate_process(spec, pid):
    cgroup = Path(f'/proc/{pid}/cgroup').read_text()
    require(re.search(r'(?:^|[/:-])' + spec['containerId'] + r'(?:[/.:\n]|$)', cgroup) is not None,
            'wrong_process_cgroup')
    status = Path(f'/proc/{pid}/status').read_text()
    line = next((line for line in status.splitlines() if line.startswith('NSpid:')), '')
    pids = line.split()[1:]
    require(len(pids) >= 2 and pids[0] == str(pid) and pids[-1] == '1', 'process_is_not_container_init')
    require(os.readlink('/proc/self/ns/pid') != os.readlink(f'/proc/{pid}/ns/pid'), 'observer_inside_app_namespace')


def prepare_target(spec):
    require(os.geteuid() == 0 and socket.gethostname() == NAMESPACE, 'wrong_guest_identity')
    boot_id = read_boot_id()
    require(spec.get('expectedBootId', boot_id) == boot_id, 'guest_boot_changed')
    # Never print inspect output: runtimeSpec may contain private environment values.
    result = subprocess.run([K3S, 'crictl', 'inspect', spec['containerId']],
                            capture_output=True, check=True, timeout=15)
    pid = validate_container(spec, json.loads(result.stdout))
    validate_process(spec, pid)
    descriptor = os.pidfd_open(pid)
    try:
        validate_process(spec, pid)
        require(not select.select([descriptor], [], [], 0)[0], 'app_already_exited')
    except BaseException:
        os.close(descriptor)
        raise
    return pid, descriptor, boot_id


def observer_sql(condition, token):
    duration = 180 if condition['kind'] == 'job-active' else 55
    if condition['kind'] == 'sql-lock':
        predicate = ("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=0 "
                     f"AND objid={condition['key']} AND objsubid=1 AND NOT granted "
                     "AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")
    else:
        predicate = ("SELECT 1 FROM pgboss.job WHERE name='resolve-episode' "
                     f"AND id='{condition['jobId']}'::uuid AND state='active' "
                     f"AND retry_count>={condition['minRetryCount']} "
                     "AND started_on>=armed_at-interval '1 second'")
    # DO is volatile: each SPI SELECT obtains a fresh READ COMMITTED snapshot.
    # Explicit read-only mode makes this observer incapable of changing jobs.
    return f"""BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY;
SET LOCAL statement_timeout = '{duration + 2}s';
DO $observe$ DECLARE armed_at timestamptz := clock_timestamp();
BEGIN
  RAISE NOTICE 'qualification_armed_{token}';
  WHILE clock_timestamp() < armed_at + interval '{duration} seconds' LOOP
    IF EXISTS ({predicate}) THEN
      RAISE NOTICE 'qualification_confirmed_{token}';
      RETURN;
    END IF;
    PERFORM pg_sleep(0.02);
  END LOOP;
  RAISE EXCEPTION 'qualification_boundary_timeout';
END $observe$;
ROLLBACK;
""", duration


def observer_command(database):
    # The password stays inside the PostgreSQL pod environment, never argv/JSON output.
    return [K3S, 'kubectl', '-n', NAMESPACE, 'exec', '-i', 'postgres-0', '--', 'sh', '-c',
            f'PGPASSWORD="$POSTGRES_PASSWORD" PGAPPNAME={APPLICATION_NAME} '
            'exec psql -X -q -h 127.0.0.1 -U "$POSTGRES_USER" -d "$1" -v ON_ERROR_STOP=1',
            'qualification-observer', database]


def emit(event):
    print(json.dumps(event), flush=True)


def observe(spec, mode):
    validate_spec(spec)
    require(mode in ('app', 'vm'), 'invalid_mode')
    pid, descriptor, boot_id = prepare_target(spec)
    child = None
    token = secrets.token_hex(16)
    sql, duration = observer_sql(spec['condition'], token)
    try:
        child = subprocess.Popen(observer_command(spec['dbOptions']['database']),
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        child.stdin.write(sql.encode())
        child.stdin.close()
        deadline = time.monotonic() + duration + 5
        pending = b''
        while time.monotonic() < deadline:
            readable, _, _ = select.select([child.stdout, descriptor], [], [], min(1, deadline - time.monotonic()))
            require(descriptor not in readable, 'app_exited_before_boundary')
            if child.stdout not in readable:
                continue
            chunk = os.read(child.stdout.fileno(), 4096)
            require(bool(chunk), 'observer_finished_without_confirmation')
            pending += chunk
            require(len(pending) < 16384, 'observer_output_limit')
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                # Ignore diagnostics entirely; only our exact unpredictable NOTICE is a protocol event.
                if not line.startswith(b'NOTICE:'):
                    continue
                notice = line.split(b':', 1)[1].strip().decode('ascii', errors='replace')
                if notice == f'qualification_armed_{token}':
                    emit({'event': 'armed'})
                if notice != f'qualification_confirmed_{token}':
                    continue
                require(read_boot_id() == boot_id, 'guest_boot_changed')
                validate_process(spec, pid)
                require(not select.select([descriptor], [], [], 0)[0], 'app_exited_before_boundary')
                confirmation = {'conditionConfirmed': True, 'bootId': boot_id, 'containerId': spec['containerId'],
                                'podName': spec['podName'], 'imageDigest': spec['imageDigest']}
                if mode == 'app':
                    signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                    # Signal delivery alone does not prove exit. The held pidfd
                    # stays tied to this exact process even if CRI history is GC'd.
                    exited, _, _ = select.select([descriptor], [], [], 10)
                    require(descriptor in exited, 'app_exit_not_observed')
                    confirmation.update({'processExited': True, 'signal': 'SIGKILL'})
                emit(confirmation)
                return
        raise RuntimeError('observer_timeout')
    finally:
        os.close(descriptor)
        if child is not None:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=2)
            child.stdout.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['app', 'vm'], required=True)
    args = parser.parse_args()
    try:
        data = sys.stdin.buffer.read(16385)
        require(len(data) <= 16384, 'input_limit')
        observe(json.loads(data), args.mode)
    except Exception:
        # Exceptions from tools, SQL or malformed payloads can contain credentials.
        print(json.dumps({'error': 'qualification_boundary_refused'}), file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
