#!/usr/bin/env python3
"""Freeze local source, build an identified QA image, and import only into our guest."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('recovery_vm', HERE / 'recovery-vm.py')
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)

RUNTIME_PATHS = ('Dockerfile', '.dockerignore', 'package.json', 'package-lock.json',
                 'server.js', 'style.css', 'postcss.config.js', 'content', 'server',
                 'public', 'sql', 'scripts/build-author.mjs', 'scripts/lib',
                 'scripts/migrate.js', 'scripts/delivery/readiness.mjs')


def is_runtime_path(name):
    return any(name == prefix or name.startswith(prefix + '/') for prefix in RUNTIME_PATHS)


def digest_bytes(value):
    return hashlib.sha256(value).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def git(repository, *args):
    return subprocess.run(['git', '-C', str(repository), *args], check=True, capture_output=True).stdout


def source_manifest(repository):
    names = sorted(set(git(repository, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').decode().split('\0')) - {''})
    entries = []
    for name in names:
        if not is_runtime_path(name):
            continue
        path = repository / name
        if any(part == '.git' or part.startswith('.env') for part in Path(name).parts):
            continue
        if not path.exists():
            continue
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(f'Only regular source files are accepted: {name}')
        content = path.read_bytes()
        entries.append({'path': name, 'sha256': digest_bytes(content), 'mode': path.stat().st_mode & 0o777})
    return entries


def full_patch(repository):
    patch = bytearray(git(repository, 'diff', '--binary', 'HEAD', '--', *RUNTIME_PATHS))
    for name in sorted(git(repository, 'ls-files', '-z', '--others', '--exclude-standard').decode().split('\0')):
        if not name or not is_runtime_path(name) or any(part.startswith('.env') for part in Path(name).parts):
            continue
        result = subprocess.run(['git', '-C', str(repository), 'diff', '--no-index', '--binary', '--', '/dev/null', name], capture_output=True)
        if result.returncode not in (0, 1):
            raise RuntimeError(f'Cannot capture untracked patch: {name}')
        patch.extend(result.stdout)
    return bytes(patch)


def archive_file_digest(archive, digest):
    if not digest.startswith('sha256:') or len(digest) != 71:
        raise RuntimeError('Expected OCI SHA-256 digest')
    content = archive.extractfile('blobs/sha256/' + digest.split(':')[1]).read()
    if digest_bytes(content) != digest.split(':')[1]:
        raise RuntimeError('OCI content digest mismatch')
    return json.loads(content)


def platform_digest(archive_path, index_digest):
    with tarfile.open(archive_path) as archive:
        digest = index_digest
        for _ in range(4):
            value = archive_file_digest(archive, digest)
            if 'config' in value and 'layers' in value:
                return digest
            manifests = value.get('manifests', [])
            matches = [item for item in manifests if item.get('platform', {}).get('os') == 'linux'
                       and item.get('platform', {}).get('architecture') == 'amd64']
            if len(matches) != 1:
                raise RuntimeError('Exactly one linux/amd64 manifest required')
            digest = matches[0]['digest']
    raise RuntimeError('Too many OCI index levels')


def platform_archive(original, target, digest, image_tag):
    """Point OCI layout directly at the platform manifest, never mislabel an index."""
    with tarfile.open(original) as source, tarfile.open(target, 'w') as output:
        manifest_data = source.extractfile('blobs/sha256/' + digest.split(':')[1]).read()
        manifest = json.loads(manifest_data)
        index = {'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json', 'manifests': [{
            'mediaType': manifest['mediaType'], 'digest': digest, 'size': len(manifest_data),
            'platform': {'os': 'linux', 'architecture': 'amd64'},
            'annotations': {'io.containerd.image.name': 'docker.io/library/' + image_tag,
                            'org.opencontainers.image.ref.name': image_tag.split(':')[1]}}]}
        for name, content in [('index.json', canonical(index)), ('oci-layout', canonical({'imageLayoutVersion': '1.0.0'}))]:
            info = tarfile.TarInfo(name)
            info.size = len(content)
            info.mode = 0o644
            output.addfile(info, io.BytesIO(content))
        for member in source:
            if member.name.startswith('blobs/') and member.isfile():
                output.addfile(member, source.extractfile(member))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', required=True)
    parser.add_argument('--repository', default=str(HERE.parent.parent))
    args = parser.parse_args()
    state = vm.private_state(args.state)
    identity = vm.identity_at(state)
    if not vm.owned_pid(state, identity):
        raise RuntimeError('Owned qualification VM must already be running')
    boot_id = vm.guest_identity(state)
    repository = Path(args.repository).resolve()
    if json.loads((repository / 'package.json').read_text())['name'] != 'salete-sincere-api':
        raise RuntimeError('Site source repository required')
    base_commit = git(repository, 'rev-parse', 'HEAD').decode().strip()
    source_epoch = int(git(repository, 'show', '-s', '--format=%ct', 'HEAD').decode().strip())
    initial = source_manifest(repository)
    tree_hash = digest_bytes(canonical(initial))
    patch = full_patch(repository)
    patch_hash = digest_bytes(patch)
    dirty = bool(patch)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    output = state / 'builds' / f'{stamp}-{tree_hash[:12]}'
    context = output / 'context'
    context.mkdir(parents=True, mode=0o700)
    for entry in initial:
        target = context / entry['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(repository / entry['path'], target)
        if digest_bytes(target.read_bytes()) != entry['sha256']:
            raise RuntimeError('Source changed while freezing context')
    if source_manifest(repository) != initial:
        raise RuntimeError('Source changed while freezing context')
    (output / 'source-manifest.json').write_bytes(canonical(initial) + b'\n')
    (output / 'working-tree.patch').write_bytes(patch)
    with tarfile.open(output / 'source.tar', 'w') as archive:
        for entry in initial:
            target = context / entry['path']
            info = archive.gettarinfo(str(target), arcname=entry['path'])
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            info.mtime = source_epoch
            with target.open('rb') as content:
                archive.addfile(info, content)
    print(json.dumps({'phase': 'frozen', 'baseCommit': base_commit, 'sourceTreeSha256': tree_hash,
                      'patchSha256': patch_hash, 'workingTreeDirty': dirty}), flush=True)
    metadata_path = output / 'buildx-metadata.json'
    image_tag = 'site-issue56:candidate-' + tree_hash[:12]
    # An uncommitted source hash deliberately fails the app's commit-SHA matcher.
    revision = f'uncommitted-source-{tree_hash}' if dirty else base_commit
    command = ['sudo', '-n', 'env', 'BUILDX_METADATA_PROVENANCE=max', 'docker', 'buildx', 'build', '--platform', 'linux/amd64', '--load',
               '--metadata-file', str(metadata_path), '--tag', image_tag,
               '--build-arg', 'SOURCE_COMMIT=' + revision,
               '--build-arg', 'SOURCE_DATE_EPOCH=' + str(source_epoch),
               '--label', 'org.saletesincere.qualification.base-commit=' + base_commit,
               '--label', 'org.saletesincere.qualification.source-sha256=' + tree_hash,
               '--label', 'org.saletesincere.qualification.patch-sha256=' + patch_hash,
               str(context)]
    with (output / 'build.log').open('w') as log:
        subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True,
                       env={**os.environ, 'BUILDX_METADATA_PROVENANCE': 'max'})
    subprocess.run(['sudo', '-n', 'chown', str(os.getuid()) + ':' + str(os.getgid()), str(metadata_path)], check=True)
    metadata_path.chmod(0o600)
    metadata = json.loads(metadata_path.read_text())
    index_digest = metadata['containerimage.digest']
    image_tar = output / 'candidate.tar'
    subprocess.run(['sudo', '-n', 'docker', 'save', '-o', str(image_tar), image_tag], check=True)
    # Docker may create the archive as root. Only change this newly created file.
    subprocess.run(['sudo', '-n', 'chown', str(os.getuid()) + ':' + str(os.getgid()), str(image_tar)], check=True)
    image_tar.chmod(0o600)
    manifest_digest = platform_digest(image_tar, index_digest)
    import_tar = output / 'candidate-platform.tar'
    platform_archive(image_tar, import_tar, manifest_digest, image_tag)
    with import_tar.open('rb') as content:
        archive_digest = hashlib.file_digest(content, 'sha256').hexdigest()
    print(json.dumps({'phase': 'built', 'indexDigest': index_digest, 'platformDigest': manifest_digest}), flush=True)
    if source_manifest(repository) != initial or git(repository, 'rev-parse', 'HEAD').decode().strip() != base_commit:
        raise RuntimeError('Source changed during build; archive kept but candidate not qualified')
    if vm.guest_identity(state) != boot_id:
        raise RuntimeError('Guest rebooted during build; refusing automatic import')
    guest_tar = '/home/ubuntu/qualification/imports/candidate-' + tree_hash[:12] + '.tar'
    subprocess.run(['scp', '-P', str(vm.SSH_PORT), '-i', str(state / 'ssh-key'), '-o', 'BatchMode=yes',
                    '-o', 'StrictHostKeyChecking=yes', '-o', f'UserKnownHostsFile={state / "known_hosts"}',
                    str(import_tar), 'ubuntu@127.0.0.1:' + guest_tar], check=True)
    # All shell words below are fixed or validated SHA-256 digests/hash-derived paths.
    guest_command = f'test "$(hostname)" = site-issue56 && sudo -n k3s ctr images import {guest_tar}'
    subprocess.run([*vm.ssh_args(state), guest_command], check=True)
    image = 'docker.io/library/site-issue56@' + manifest_digest
    guest_command = (f'test "$(hostname)" = site-issue56 && sudo -n k3s ctr images tag '
                     f'docker.io/library/{image_tag} {image}')
    subprocess.run([*vm.ssh_args(state), guest_command], check=True)
    if source_manifest(repository) != initial:
        raise RuntimeError('Source changed during import; candidate not qualified')
    candidate = {
        'kind': 'site-issue56-uncommitted-candidate' if dirty else 'site-issue56-committed-candidate',
        'baseCommit': base_commit, 'sourceCommit': None if dirty else base_commit, 'workingTreeDirty': dirty,
        'sourceScope': 'docker-runtime-inputs', 'sourcePaths': list(RUNTIME_PATHS),
        'sourceTreeSha256': tree_hash, 'patchSha256': patch_hash, 'sourceDateEpoch': source_epoch,
        'image': image, 'indexDigest': index_digest, 'platformDigest': manifest_digest,
        'imageArchiveSha256': archive_digest, 'buildDirectory': str(output),
        'buildStartedAt': stamp, 'completedAt': datetime.now(timezone.utc).isoformat(),
        'guestBootId': boot_id, 'builderMetadata': str(metadata_path),
    }
    (output / 'candidate.json').write_bytes(canonical(candidate) + b'\n')
    temporary = state / 'candidate.json.new'
    temporary.write_bytes(canonical(candidate) + b'\n')
    temporary.replace(state / 'candidate.json')
    print(json.dumps({'phase': 'ready', 'image': image, 'candidateFile': str(state / 'candidate.json')}), flush=True)


if __name__ == '__main__':
    main()
