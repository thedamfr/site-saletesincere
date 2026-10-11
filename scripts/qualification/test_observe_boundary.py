import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

module_spec = importlib.util.spec_from_file_location('boundary', Path(__file__).with_name('observe-boundary.py'))
boundary = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(boundary)


def spec():
    return {'containerId': 'a' * 64, 'podName': 'web-abc-123', 'imageDigest': 'sha256:' + 'b' * 64,
            'dbOptions': {'host': '127.0.0.1', 'port': 25456, 'database': 'site_qualification_candidate3',
                          'password': 'must-never-appear'},
            'condition': {'kind': 'sql-lock', 'key': 560091}}


def inspected():
    return {'status': {'id': 'a' * 64, 'state': 'CONTAINER_RUNNING', 'metadata': {'name': 'web'},
                       'imageRef': 'docker.io/library/site-issue56@sha256:' + 'b' * 64,
                       'labels': {'io.kubernetes.pod.namespace': 'site-issue56',
                                  'io.kubernetes.pod.name': 'web-abc-123',
                                  'io.kubernetes.pod.uid': 'pod-unique', 'io.kubernetes.container.name': 'web'}},
            'info': {'pid': 1234}}


class ObserverSafety(unittest.TestCase):
    def test_rejects_other_databases_and_injected_conditions(self):
        for name in ['postgres', 'production', 'site_qualification_x;DROP DATABASE postgres']:
            value = spec()
            value['dbOptions']['database'] = name
            with self.assertRaises(RuntimeError):
                boundary.validate_spec(value)
        for key in [True, -1, '1; SELECT 1']:
            value = spec()
            value['condition']['key'] = key
            with self.assertRaises(RuntimeError):
                boundary.validate_spec(value)

    def test_accepts_job_uuid_and_rejects_sql_injection(self):
        value = spec()
        value['condition'] = {'kind': 'job-active', 'jobId': '11111111-2222-4333-8444-555555555555', 'minRetryCount': 1}
        self.assertEqual(boundary.validate_spec(value), value)
        value['condition']['jobId'] = "x'; DELETE FROM pgboss.job;--"
        with self.assertRaises((ValueError, RuntimeError)):
            boundary.validate_spec(value)

    def test_container_identity_guards_pid_selection(self):
        self.assertEqual(boundary.validate_container(spec(), inspected()), 1234)
        for key, value in [('id', 'c' * 64), ('state', 'CONTAINER_EXITED'), ('imageRef', 'sha256:' + 'c' * 64)]:
            status = inspected()
            status['status'][key] = value
            with self.assertRaises(RuntimeError):
                boundary.validate_container(spec(), status)
        for key, value in [('io.kubernetes.pod.namespace', 'production'), ('io.kubernetes.pod.name', 'web-other'),
                           ('io.kubernetes.container.name', 'postgres')]:
            status = inspected()
            status['status']['labels'][key] = value
            with self.assertRaises(RuntimeError):
                boundary.validate_container(spec(), status)

    def test_pid_must_be_owned_container_init_in_another_namespace(self):
        def read(path):
            return '0::/kubepods/cri-containerd-' + 'a' * 64 + '.scope\n' if path.name == 'cgroup' else 'NSpid:\t1234\t1\n'
        with patch.object(Path, 'read_text', read), patch.object(boundary.os, 'readlink', side_effect=['pid:[1]', 'pid:[2]']):
            boundary.validate_process(spec(), 1234)
        with patch.object(Path, 'read_text', read), patch.object(boundary.os, 'readlink', return_value='pid:[1]'):
            with self.assertRaisesRegex(RuntimeError, 'inside_app_namespace'):
                boundary.validate_process(spec(), 1234)
        with patch.object(Path, 'read_text', return_value='0::/other-container\n'):
            with self.assertRaisesRegex(RuntimeError, 'wrong_process_cgroup'):
                boundary.validate_process(spec(), 1234)

    def test_wrong_host_is_rejected_before_inspection_or_signals(self):
        with patch.object(boundary.os, 'geteuid', return_value=0), patch.object(boundary.socket, 'gethostname', return_value='production'), \
                patch.object(boundary.subprocess, 'run') as run, patch.object(boundary.signal, 'pidfd_send_signal') as kill:
            with self.assertRaisesRegex(RuntimeError, 'wrong_guest_identity'):
                boundary.prepare_target(spec())
            run.assert_not_called()
            kill.assert_not_called()

    def test_observer_query_is_read_only_and_excludes_old_attempts(self):
        condition = {'kind': 'job-active', 'jobId': '11111111-2222-4333-8444-555555555555', 'minRetryCount': 2}
        sql, duration = boundary.observer_sql(condition, 'nonce')
        self.assertEqual(duration, 180)
        self.assertIn('READ COMMITTED READ ONLY', sql)
        self.assertIn("started_on>=armed_at-interval '1 second'", sql)
        self.assertIn('retry_count>=2', sql)
        self.assertIn('pg_sleep(0.02)', sql)
        self.assertNotIn('UPDATE ', sql)
        self.assertNotIn('DELETE ', sql)
        command = boundary.observer_command('site_qualification_candidate3')
        self.assertNotIn('must-never-appear', ' '.join(command))
        self.assertIn('$POSTGRES_PASSWORD', ' '.join(command))
        self.assertIn('qualification-boundary-observer', ' '.join(command))

    def test_only_app_mode_signals_after_the_exact_database_confirmation(self):
        for mode in ['app', 'vm']:
            events = []
            ordering = []
            child = Mock()
            child.poll.return_value = 0
            child.stdout.fileno.return_value = 101
            boot = '11111111-2222-4333-8444-555555555555'
            def ready(readable, writable, exceptional, timeout):
                if readable == [child.stdout, 9]:
                    return [child.stdout], [], []
                if timeout == 0:
                    return [], [], []
                self.assertEqual(mode, 'app', 'VM confirmation must never wait for application exit')
                self.assertEqual(readable, [9])
                self.assertEqual(timeout, 10)
                self.assertEqual(ordering, ['signal'])
                self.assertFalse(any(event.get('conditionConfirmed') for event in events))
                ordering.append('kernel-exit')
                return [9], [], []
            def emit(event):
                if event.get('conditionConfirmed'):
                    ordering.append('confirmation')
                events.append(event)
            with patch.object(boundary, 'prepare_target', return_value=(1234, 9, boot)), \
                    patch.object(boundary, 'validate_process'), patch.object(boundary, 'read_boot_id', return_value=boot), \
                    patch.object(boundary.subprocess, 'Popen', return_value=child), \
                    patch.object(boundary.secrets, 'token_hex', return_value='nonce'), \
                    patch.object(boundary.select, 'select', side_effect=ready), \
                    patch.object(boundary.os, 'read', return_value=b'NOTICE:  qualification_armed_nonce\nNOTICE:  qualification_confirmed_nonce\n'), \
                    patch.object(boundary.os, 'close') as close, \
                    patch.object(boundary.signal, 'pidfd_send_signal', side_effect=lambda *args: ordering.append('signal')) as kill, \
                    patch.object(boundary, 'emit', side_effect=emit):
                boundary.observe(spec(), mode)
                if mode == 'app':
                    kill.assert_called_once_with(9, boundary.signal.SIGKILL)
                    self.assertEqual(ordering, ['signal', 'kernel-exit', 'confirmation'])
                else:
                    kill.assert_not_called()
                    self.assertEqual(ordering, ['confirmation'])
                close.assert_called_once_with(9)
            self.assertEqual(events[0], {'event': 'armed'})
            expected = {'conditionConfirmed': True, 'bootId': boot,
                                         'containerId': spec()['containerId'], 'podName': spec()['podName'],
                                         'imageDigest': spec()['imageDigest']}
            if mode == 'app':
                expected.update({'processExited': True, 'signal': 'SIGKILL'})
            self.assertEqual(events[1], expected)
            self.assertNotIn('must-never-appear', json.dumps(events))

    def test_app_refuses_confirmation_when_kernel_does_not_report_exit(self):
        events = []
        child = Mock()
        child.poll.return_value = 0
        child.stdout.fileno.return_value = 101
        boot = '11111111-2222-4333-8444-555555555555'
        with patch.object(boundary, 'prepare_target', return_value=(1234, 9, boot)), \
                patch.object(boundary, 'validate_process'), patch.object(boundary, 'read_boot_id', return_value=boot), \
                patch.object(boundary.subprocess, 'Popen', return_value=child), \
                patch.object(boundary.secrets, 'token_hex', return_value='nonce'), \
                patch.object(boundary.select, 'select', side_effect=[([child.stdout], [], []), ([], [], []), ([], [], [])]) as ready, \
                patch.object(boundary.os, 'read', return_value=b'NOTICE:  qualification_confirmed_nonce\n'), \
                patch.object(boundary.os, 'close'), \
                patch.object(boundary.signal, 'pidfd_send_signal') as kill, \
                patch.object(boundary, 'emit', side_effect=events.append):
            with self.assertRaisesRegex(RuntimeError, 'app_exit_not_observed'):
                boundary.observe(spec(), 'app')
            kill.assert_called_once_with(9, boundary.signal.SIGKILL)
            self.assertEqual(ready.call_args.args, ([9], [], [], 10))
            self.assertFalse(any(event.get('conditionConfirmed') for event in events))

    def test_exited_target_is_never_signalled_even_after_confirmation(self):
        child = Mock()
        child.poll.return_value = 0
        child.stdout.fileno.return_value = 101
        boot = '11111111-2222-4333-8444-555555555555'
        with patch.object(boundary, 'prepare_target', return_value=(1234, 9, boot)), \
                patch.object(boundary, 'validate_process'), patch.object(boundary, 'read_boot_id', return_value=boot), \
                patch.object(boundary.subprocess, 'Popen', return_value=child), \
                patch.object(boundary.secrets, 'token_hex', return_value='nonce'), \
                patch.object(boundary.select, 'select', side_effect=[([child.stdout], [], []), ([9], [], [])]), \
                patch.object(boundary.os, 'read', return_value=b'NOTICE:  qualification_confirmed_nonce\n'), \
                patch.object(boundary.os, 'close'), patch.object(boundary.signal, 'pidfd_send_signal') as kill:
            with self.assertRaisesRegex(RuntimeError, 'app_exited_before_boundary'):
                boundary.observe(spec(), 'app')
            kill.assert_not_called()

    def test_cli_refuses_an_invalid_spec_without_echoing_credentials(self):
        value = spec()
        value['containerId'] = 'invalid'
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('observe-boundary.py')), '--mode', 'vm'],
                                input=json.dumps(value), text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertEqual(json.loads(result.stderr), {'error': 'qualification_boundary_refused'})
        self.assertNotIn('must-never-appear', result.stderr)


if __name__ == '__main__':
    unittest.main()
