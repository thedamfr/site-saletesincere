#!/usr/bin/env bash
set -euo pipefail

# This script is transferred into the disposable guest and never run on the host.
if [[ $(hostname) != site-issue56 ]]; then
  printf '%s\n' 'Refusing: disposable site-issue56 guest required' >&2
  exit 1
fi
if [[ ${1:-} != /home/ubuntu/qualification/imports ]]; then
  printf '%s\n' 'Refusing: explicit guest import directory required' >&2
  exit 1
fi
imports=$1
test -f "$imports/k3s"
test -f "$imports/k3s-airgap-images-amd64.tar.zst"
sudo -n install -m 0755 "$imports/k3s" /usr/local/bin/k3s
sudo -n install -d -m 0755 /var/lib/rancher/k3s/agent/images
sudo -n install -m 0644 "$imports/k3s-airgap-images-amd64.tar.zst" /var/lib/rancher/k3s/agent/images/
networkInterface=$(ip -o -4 addr show | awk '$4 ~ /^10\.0\.2\.15\// {print $2}')
if [[ ! $networkInterface =~ ^[a-zA-Z0-9]+$ ]]; then
  printf '%s\n' 'Refusing: expected isolated guest interface not found' >&2
  exit 1
fi
sudo -n tee /etc/systemd/system/k3s.service >/dev/null <<UNIT
[Unit]
Description=Site issue 56 isolated qualification Kubernetes
Wants=network-online.target
After=network-online.target
[Service]
Type=notify
ExecStart=/usr/local/bin/k3s server --node-name site-issue56 --node-ip 10.0.2.15 --advertise-address 10.0.2.15 --flannel-iface $networkInterface --disable traefik --disable servicelb --disable metrics-server --write-kubeconfig-mode 600
KillMode=process
Delegate=yes
LimitNOFILE=1048576
TasksMax=infinity
TimeoutStartSec=0
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
# Only this restricted guest exposes the fixture tunnel to its pod network.
sudo -n tee /etc/ssh/sshd_config.d/90-site-qualification.conf >/dev/null <<'SSH'
GatewayPorts clientspecified
SSH
sudo -n sshd -t
sudo -n systemctl reload ssh
sudo -n systemctl daemon-reload
sudo -n systemctl enable k3s
sudo -n systemctl restart k3s
sudo -n /usr/local/bin/k3s --version
