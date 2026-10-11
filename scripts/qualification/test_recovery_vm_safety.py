"""Destructive guest controls reject a wrong identity even with Python optimization."""
import contextlib
import importlib.util
import io
import itertools
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
import uuid


class GuestSafety(unittest.TestCase):
    def test_wrong_identity_or_process_is_never_signalled(self):
        script = Path(__file__).with_name('recovery-vm.py')
        for optimized, action, scenario in itertools.product((False, True), ('crash', 'crash-when'), ('identity', 'pid', 'directory')):
            with self.subTest(optimized=optimized, action=action, scenario=scenario), tempfile.TemporaryDirectory() as temporary:
                state = Path(temporary)
                identity = {'kind': 'site-issue56-qualification', 'hostname': 'site-issue56',
                            'uuid': str(uuid.uuid4()), 'sshPort': 22856}
                if scenario == 'identity':
                    identity['kind'] = 'another-project'
                if scenario == 'directory':
                    state.chmod(0o755)
                (state / 'identity.json').write_text(json.dumps(identity))
                (state / 'qemu.pid').write_text(str(os.getpid()))
                command = [sys.executable] + (['-O'] if optimized else [])
                result = subprocess.run([*command, str(script), action, '--state', str(state)],
                                        capture_output=True, text=True, timeout=5)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn({'identity': 'Wrong guest identity', 'pid': 'PID belongs to another process',
                               'directory': 'Private owned state directory required'}[scenario], result.stderr)
                self.assertFalse((state / 'operations.jsonl').exists())


sys.dont_write_bytecode = True
module_spec = importlib.util.spec_from_file_location('recovery_vm', Path(__file__).with_name('recovery-vm.py'))
vm = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(vm)


class ConditionalCrashSafety(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.state = Path(self.temporary.name)
        (self.state / 'disk.qcow2').write_bytes(b'qualification disk fixture')
        self.identity = {'kind': vm.KIND, 'hostname': vm.HOSTNAME, 'uuid': str(uuid.uuid4()), 'sshPort': vm.SSH_PORT}
        self.boot_id = str(uuid.uuid4())
        self.specification = {'containerId': 'a' * 64, 'podName': 'web-abc123-def45',
            'imageDigest': 'sha256:' + 'b' * 64,
            'dbOptions': {'host': 'postgres', 'port': 5432, 'database': 'site_qualification_run3',
                          'user': 'site_qualification', 'password': 'private-value-never-logged'},
            'condition': {'kind': 'job-active', 'jobId': str(uuid.uuid4()), 'minRetryCount': 1}}
        self.response = {'conditionConfirmed': True, 'bootId': self.boot_id,
            'containerId': self.specification['containerId'], 'podName': self.specification['podName'],
            'imageDigest': self.specification['imageDigest']}

    def test_identity_check_cannot_consume_controller_stdin(self):
        # A real child process models SSH eagerly forwarding its inherited stdin.
        # The controller must retain the entire private boundary specification.
        consumer = ('import sys; sys.stdin.buffer.read(); '
                    f'print("site-issue56"); print({self.boot_id!r})')
        payload = json.dumps(self.specification).encode()
        controller = '\n'.join([
            'import importlib.util,json,sys', 'from pathlib import Path',
            'sys.dont_write_bytecode=True',
            f'spec=importlib.util.spec_from_file_location("driver", {str(Path(vm.__file__))!r})',
            'driver=importlib.util.module_from_spec(spec); spec.loader.exec_module(driver)',
            f'driver.ssh_args=lambda _: [sys.executable,"-c",{consumer!r}]',
            'boot=driver.guest_identity(Path("/unused-qualification-state"))',
            f'print(json.dumps({{"bootId":boot,"payloadIntact":sys.stdin.buffer.read()=={payload!r}}}))'
        ])
        result = subprocess.run([sys.executable, '-c', controller], input=payload,
                                capture_output=True, check=True, timeout=5)
        observed = json.loads(result.stdout)
        self.assertEqual(observed['bootId'], self.boot_id)
        self.assertTrue(observed['payloadIntact'], 'Identity SSH consumed the pending boundary specification')

    def invoke(self, response=None, *, observer_error=None, changed_identity=False, changed_pid=False, replace_disk=False, dead_pidfd=False):
        if dead_pidfd:
            child = subprocess.Popen([sys.executable, '-c', 'pass'])
            descriptor = os.pidfd_open(child.pid)
            child.wait(timeout=5)
        else:
            descriptor = os.pidfd_open(os.getpid())
        signal_spy = mock.Mock()
        def observe(*args, **kwargs):
            if observer_error:
                raise observer_error
            if replace_disk:
                (self.state / 'new-disk').write_bytes(b'another disk')
                (self.state / 'new-disk').replace(self.state / 'disk.qcow2')
            return (response if response is not None else self.response), None
        with mock.patch.object(vm.os, 'pidfd_open', return_value=descriptor), \
             mock.patch.object(vm, 'identity_at', return_value={} if changed_identity else self.identity), \
             mock.patch.object(vm, 'owned_pid', side_effect=[os.getpid(), None] if changed_pid else None, return_value=os.getpid()), \
             mock.patch.object(vm, 'observe_boundary', side_effect=observe) as observer, \
             mock.patch.object(vm, 'guest_identity') as guest, \
             mock.patch.object(vm.signal, 'pidfd_send_signal', signal_spy), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            try:
                vm.crash_when(self.state, self.identity, os.getpid(), self.boot_id, self.specification)
                error = None
            except RuntimeError as failure:
                error = failure
        self.assertNotIn(self.specification['dbOptions']['password'], output.getvalue())
        self.assertNotIn(self.specification['dbOptions']['password'], (self.state / 'operations.jsonl').read_text())
        guest.assert_not_called()
        return error, signal_spy, observer

    def test_confirmation_signals_only_held_pidfd_without_second_ssh(self):
        error, sent, observer = self.invoke()
        self.assertIsNone(error)
        sent.assert_called_once()
        self.assertEqual(sent.call_args.args[1], vm.signal.SIGKILL)
        observer.assert_called_once()

    def test_exited_pidfd_is_refused_before_observer_starts(self):
        error, sent, observer = self.invoke(dead_pidfd=True)
        self.assertIsNotNone(error)
        sent.assert_not_called()
        observer.assert_not_called()

    def test_mismatch_timeout_and_local_identity_changes_refuse_signal(self):
        for scenario in ('timeout', 'confirmation', 'boot', 'container', 'pod', 'image', 'identity', 'pid', 'disk'):
            with self.subTest(scenario=scenario):
                response = dict(self.response)
                kwargs = {}
                if scenario == 'timeout': kwargs['observer_error'] = RuntimeError('Observer timed out')
                if scenario == 'confirmation': response['conditionConfirmed'] = False
                if scenario == 'boot': response['bootId'] = str(uuid.uuid4())
                if scenario == 'container': response['containerId'] = 'c' * 64
                if scenario == 'pod': response['podName'] = 'another-project'
                if scenario == 'image': response['imageDigest'] = 'sha256:' + 'c' * 64
                if scenario == 'identity': kwargs['changed_identity'] = True
                if scenario == 'pid': kwargs['changed_pid'] = True
                if scenario == 'disk': kwargs['replace_disk'] = True
                error, sent, _ = self.invoke(response, **kwargs)
                self.assertIsNotNone(error)
                sent.assert_not_called()

    def test_condition_rejects_arbitrary_command_or_database(self):
        for field, value in [('command', 'anything'), ('condition', {'kind': 'sql', 'query': 'SELECT 1'}),
                             ('dbOptions', {**self.specification['dbOptions'], 'database': 'production'})]:
            with self.subTest(field=field):
                with self.assertRaises(RuntimeError):
                    vm.validate_boundary_spec({**self.specification, field: value})

    def test_confirmation_is_read_before_observer_exits(self):
        command = ('import json,sys,time; spec=json.load(sys.stdin); '
                   'print(json.dumps({"event":"armed"}),flush=True); '
                   f'print({json.dumps(json.dumps(self.response))},flush=True); time.sleep(30)')
        with mock.patch.object(vm, 'ssh_args', return_value=[sys.executable, '-u', '-c', command]):
            started = time.monotonic()
            response, child = vm.observe_boundary(self.state, self.specification, self.boot_id)
            try:
                self.assertLess(time.monotonic() - started, 2)
                self.assertIsNone(child.poll(), 'confirmation must not wait for observer exit')
                self.assertEqual(response, self.response)
            finally:
                vm.close_observer(child)

    def test_observer_timeout_eof_malformed_and_oversized_output_fail_closed(self):
        commands = {
            'timeout': 'import json,sys,time; json.load(sys.stdin); time.sleep(30)',
            'eof': 'import json,sys; json.load(sys.stdin)',
            'malformed': 'import json,sys; json.load(sys.stdin); print("invalid",flush=True)',
            'oversized': 'import json,sys; json.load(sys.stdin); print("a"*17000,flush=True)'
        }
        for scenario, command in commands.items():
            with self.subTest(scenario=scenario), \
                 mock.patch.object(vm, 'ssh_args', return_value=[sys.executable, '-u', '-c', command]), \
                 mock.patch.object(vm, 'BOUNDARY_TIMEOUT', 0.2):
                with self.assertRaises(RuntimeError):
                    vm.observe_boundary(self.state, self.specification, self.boot_id)


if __name__ == '__main__':
    unittest.main()
