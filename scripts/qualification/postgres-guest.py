#!/usr/bin/env python3
"""Create the synthetic PostgreSQL workload only inside the disposable guest."""
import json
import os
from pathlib import Path
import socket
import subprocess


def main():
    if socket.gethostname() != 'site-issue56':
        raise RuntimeError('Disposable site-issue56 guest required')
    options_path = Path('/home/ubuntu/qualification/postgres-options.json')
    if options_path.is_symlink() or options_path.stat().st_mode & 0o077:
        raise RuntimeError('Private PostgreSQL options required')
    options = json.loads(options_path.read_text())
    if options['database'] != 'site_qualification' or options['user'] != 'site_qualification':
        raise RuntimeError('Synthetic qualification database required')
    namespace = 'site-issue56'
    common = {'namespace': namespace}
    labels = {'app': 'site-issue56-postgres'}
    objects = [
        {'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': namespace}},
        {'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': 'postgres-synthetic', **common},
         'stringData': {'password': options['password']}},
        {'apiVersion': 'v1', 'kind': 'PersistentVolume', 'metadata': {'name': 'site-issue56-postgres'},
         'spec': {'capacity': {'storage': '1Gi'}, 'accessModes': ['ReadWriteOnce'], 'persistentVolumeReclaimPolicy': 'Retain',
                  'storageClassName': '', 'hostPath': {'path': '/var/lib/site-issue56/postgres', 'type': 'DirectoryOrCreate'},
                  'claimRef': {'namespace': namespace, 'name': 'postgres'}}},
        {'apiVersion': 'v1', 'kind': 'PersistentVolumeClaim', 'metadata': {'name': 'postgres', **common},
         'spec': {'accessModes': ['ReadWriteOnce'], 'storageClassName': '', 'volumeName': 'site-issue56-postgres',
                  'resources': {'requests': {'storage': '1Gi'}}}},
        {'apiVersion': 'v1', 'kind': 'Service', 'metadata': {'name': 'postgres', **common},
         'spec': {'type': 'NodePort', 'selector': labels, 'ports': [{'name': 'postgres', 'port': 5432, 'targetPort': 5432, 'nodePort': 30432}]}},
        {'apiVersion': 'apps/v1', 'kind': 'StatefulSet', 'metadata': {'name': 'postgres', **common},
         'spec': {'serviceName': 'postgres', 'replicas': 1, 'selector': {'matchLabels': labels},
                  'template': {'metadata': {'labels': labels}, 'spec': {'terminationGracePeriodSeconds': 30,
                    'containers': [{'name': 'postgres', 'image': 'docker.io/library/postgres:17.6-alpine', 'imagePullPolicy': 'Never',
                     'ports': [{'containerPort': 5432}],
                     'env': [{'name': 'POSTGRES_DB', 'value': options['database']}, {'name': 'POSTGRES_USER', 'value': options['user']},
                             {'name': 'POSTGRES_PASSWORD', 'valueFrom': {'secretKeyRef': {'name': 'postgres-synthetic', 'key': 'password'}}}],
                     'resources': {'requests': {'cpu': '100m', 'memory': '256Mi'}, 'limits': {'cpu': '1', 'memory': '1Gi'}},
                     'readinessProbe': {'exec': {'command': ['pg_isready', '-U', options['user'], '-d', options['database']]},
                                        'periodSeconds': 5, 'timeoutSeconds': 5, 'failureThreshold': 12},
                     'volumeMounts': [{'name': 'data', 'mountPath': '/var/lib/postgresql/data'}]}],
                    'volumes': [{'name': 'data', 'persistentVolumeClaim': {'claimName': 'postgres'}}]}}}}
    ]
    subprocess.run(['sudo', '-n', '/usr/local/bin/k3s', 'kubectl', 'apply', '-f', '-'],
                   input=json.dumps({'apiVersion': 'v1', 'kind': 'List', 'items': objects}), text=True, check=True)


if __name__ == '__main__':
    main()
