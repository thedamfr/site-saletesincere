#!/usr/bin/env python3
"""One-time OVH operator setup; never invoked by a release workflow.
Run as root with source directory, audited SQL fingerprint and tooling revision.
No GitHub credential is stored or used on OVH.
"""
import base64
import json
import os
from pathlib import Path
import pwd
import shutil
import socket
import subprocess
import sys
import re

source = Path(sys.argv[1]).resolve()
schema, revision = sys.argv[2:4]
assert os.getuid() == 0 and socket.gethostname() == 'game-prod-ovh-gra'
assert re.fullmatch('[a-f0-9]{64}', schema) and re.fullmatch('[a-f0-9]{40}', revision)
kubectl = ['/snap/bin/microk8s', 'kubectl', '-n', 'site-saletesincere']
assert subprocess.check_output(kubectl + ['config', 'current-context'], text=True).strip() == 'microk8s'
# Local references only: no new copy of the bot token and no GitHub secret.
# Credential-store identifiers are optional at service startup, so a missing
# Telegram credential cannot prevent the deployment reconciler from starting.
bot_dir = Path('/home/ubuntu/.local/state/infra-sincere/observability')
token = (bot_dir / 'telegram-bot-token').read_text().strip()
recipient = json.loads((bot_dir / 'telegram-recipient.json').read_text())
assert re.fullmatch('[0-9]+:[A-Za-z0-9_-]{20,}', token)
assert type(recipient['chat_id']) is int and recipient['chat_id'] > 0
assert str(recipient['bot_id']) == token.split(':')[0]
credstore = Path('/etc/credstore')
credstore.mkdir(mode=0o700, exist_ok=True)
for alias, filename in [('token', 'telegram-bot-token'), ('recipient', 'telegram-recipient.json')]:
    link = credstore / f'site-saletesincere-telegram-{alias}'
    origin = bot_dir / filename
    if link.exists() or link.is_symlink():
        assert link.is_symlink() and link.readlink() == origin
    else:
        link.symlink_to(origin)
config_dir = Path('/etc/site-saletesincere-delivery')
config_dir.mkdir(mode=0o700, exist_ok=True)
try:
    pwd.getpwnam('site-delivery')
except KeyError:
    subprocess.run(['useradd', '--system', '--home-dir', '/var/lib/site-saletesincere-delivery', '--shell', '/usr/sbin/nologin', 'site-delivery'], check=True)
secret = json.loads(subprocess.check_output(kubectl + ['get', 'secret', 'site-delivery-token', '-o', 'json']))['data']
kubeconfig = {
    'apiVersion': 'v1', 'kind': 'Config',
    'clusters': [{'name': 'site-cluster', 'cluster': {'server': 'https://127.0.0.1:16443', 'certificate-authority-data': secret['ca.crt']}}],
    'users': [{'name': 'site-delivery', 'user': {'token': base64.b64decode(secret['token']).decode()}}],
    'contexts': [{'name': 'site-delivery', 'context': {'cluster': 'site-cluster', 'user': 'site-delivery', 'namespace': 'site-saletesincere'}}],
    'current-context': 'site-delivery'
}
(config_dir / 'kubeconfig').write_text(json.dumps(kubeconfig))
os.chmod(config_dir / 'kubeconfig', 0o600)
# Config contains no secret. The service may read it, but cannot change schema approval.
os.chmod(config_dir, 0o755)
(config_dir / 'config.json').write_text(json.dumps({'schema': {'production': schema, 'staging': schema}, 'toolingRevision': revision}, indent=2))
os.chmod(config_dir / 'config.json', 0o644)
target = Path('/opt/site-saletesincere-delivery')
target.mkdir(mode=0o755, exist_ok=True)
for filename in ['policy.mjs', 'github.mjs', 'smoke.mjs', 'reconcile.mjs', 'notifications.mjs', 'notify.mjs']:
    shutil.copyfile(source / filename, target / filename)
    os.chmod(target / filename, 0o644)
for suffix in ['service', 'timer']:
    filename = f'site-saletesincere-delivery.{suffix}'
    shutil.copyfile(source / filename, Path('/etc/systemd/system') / filename)
subprocess.run(['systemctl', 'daemon-reload'], check=True)
print('Delivery service installed; activation of its timer is an explicit bootstrap step.')
