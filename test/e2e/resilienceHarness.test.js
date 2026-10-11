import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness } from './resilience-harness.mjs';
import * as harnessModule from './resilience-harness.mjs';
import { setupApplication } from './resilience-setup.mjs';

async function harnessFor(t) {
  const directory = await mkdtemp(join(tmpdir(), 'resilience-harness-'));
  const stateDir = join(directory, 'private');
  await mkdir(stateDir, { mode: 0o700 });
  await writeFile(join(stateDir, 'identity.json'), JSON.stringify({
    kind: 'site-issue56-qualification', hostname: 'site-issue56', sshPort: 22856
  }));
  await writeFile(join(stateDir, 'postgres-options.json'), JSON.stringify({
    host: '127.0.0.1', port: 25456, database: 'site_qualification'
  }));
  const harness = await createHarness({ stateDir, outputDir: join(directory, 'output') });
  t.after(async () => {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  });
  return harness;
}

test('qualification health requires boolean success and explicit dependencies', async t => {
  const harness = await harnessFor(t);
  let payload = { ok: 'true', mode: 'normal' };
  t.mock.method(globalThis, 'fetch', async () => Response.json(payload));
  assert.equal(await harness.health(false), false);
  payload = { ok: true, mode: 'normal', database: { state: 'read_write' }, episodeWorker: { state: 'starting' } };
  assert.equal(await harness.health(true), false);
  assert.deepEqual(await harness.health(false), payload);
  payload.episodeWorker.state = 'ready';
  assert.deepEqual(await harness.health(true), payload);
});

test('a successful observation beyond the recovery deadline is a failure', async t => {
  const harness = await harnessFor(t);
  await assert.rejects(harness.waitFor(async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
    return true;
  }, 'late recovery', 5), /late recovery exceeded 5ms/);
});

test('command timeout remains a failure when termination is ignored and nonzero exit is allowed', { timeout: 5000 }, async t => {
  const harness = await harnessFor(t);
  await assert.rejects(harness.run(process.execPath, ['-e',
    'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 3000)'
  ], { timeout: 250, allowFailure: true }), /timed out/);
});

const adminOptions = Object.freeze({
  host: '127.0.0.1', port: 25456, database: 'site_qualification', user: 'qualification_admin'
});
const guestStatus = { running: true, hostname: 'site-issue56', bootId: 'aabbccdd-1122-3344-5566-778899aabbcc' };

test('application signals use the ancestor container runtime and the exact owned container', () => {
  const containerId = 'd'.repeat(64);
  const pod = {
    metadata: { namespace: 'site-issue56', name: 'web-qualification', uid: 'owned-pod', labels: { app: 'site-issue56-web' } },
    status: { containerStatuses: [{ name: 'web', containerID: `containerd://${containerId}` }] }
  };
  assert.equal(harnessModule.applicationSignalCommand(pod, 'SIGKILL'),
    `sudo -n k3s ctr -n k8s.io tasks kill --signal SIGKILL ${containerId}`);
  assert.equal(harnessModule.applicationSignalCommand(pod, 'SIGTERM'),
    `sudo -n k3s ctr -n k8s.io tasks kill --signal SIGTERM ${containerId}`);
  assert.throws(() => harnessModule.applicationSignalCommand(pod, 'SIGSTOP'));
  for (const invalid of [
    { ...pod, metadata: { ...pod.metadata, namespace: 'default' } },
    { ...pod, metadata: { ...pod.metadata, labels: { app: 'postgres' } } },
    { ...pod, status: { containerStatuses: [{ name: 'web', containerID: 'containerd://unsafe;kill' }] } },
    { ...pod, status: { containerStatuses: [{ name: 'database', containerID: `containerd://${containerId}` }] } }
  ]) assert.throws(() => harnessModule.applicationSignalCommand(invalid, 'SIGKILL'));
});

test('replacement observation captures exit before Kubernetes discards lastState', async () => {
  const before = { metadata: { name: 'web-owned', uid: 'owned-uid' }, status: { containerStatuses: [
    { name: 'web', containerID: `containerd://${'a'.repeat(64)}`, restartCount: 0 }
  ] } };
  let reads = 0;
  const result = await harnessModule.waitForApplicationReplacement({ before, expectedExitCode: 0, timeoutMs: 1000,
    currentPod: async () => ({ ...before, status: { containerStatuses: [{ name: 'web',
      containerID: `containerd://${'b'.repeat(64)}`, restartCount: 1,
      lastState: reads++ === 0 ? { terminated: { exitCode: 0 } } : {}
    }] } }),
    waitFor: async predicate => assert.ok(await predicate())
  });
  assert.equal(reads, 1);
  assert.equal(result.exitCode, 0);
  assert.equal(result.containerId, 'b'.repeat(64));
});

test('graceful replacement requires observed exit zero and rejects missing or forced exit', async () => {
  const before = { metadata: { name: 'web-owned', uid: 'owned-uid' }, status: { containerStatuses: [
    { name: 'web', containerID: `containerd://${'a'.repeat(64)}`, restartCount: 0 }
  ] } };
  for (const exitCode of [undefined, 137]) {
    await assert.rejects(harnessModule.waitForApplicationReplacement({ before, expectedExitCode: 0, timeoutMs: 1000,
      currentPod: async () => ({ ...before, status: { containerStatuses: [{ name: 'web',
        containerID: `containerd://${'b'.repeat(64)}`, restartCount: 1,
        lastState: exitCode === undefined ? {} : { terminated: { exitCode } }
      }] } }),
      waitFor: async predicate => assert.ok(await predicate())
    }), { code: 'ERR_ASSERTION' });
  }
});

test('termination before replacement is retained when the next status has already lost lastState', async () => {
  const before = { metadata: { name: 'web-owned', uid: 'owned-uid' }, status: { containerStatuses: [
    { name: 'web', containerID: `containerd://${'a'.repeat(64)}`, restartCount: 0 }
  ] } };
  let reads = 0;
  const result = await harnessModule.waitForApplicationReplacement({ before, expectedExitCode: 137, timeoutMs: 1000,
    currentPod: async () => ({ ...before, status: { containerStatuses: [reads++ === 0
      ? { ...before.status.containerStatuses[0], state: { terminated: { exitCode: 137 } } }
      : { name: 'web', containerID: `containerd://${'b'.repeat(64)}`, restartCount: 1, lastState: {} }
    ] } }),
    waitFor: async predicate => {
      assert.equal(await predicate(), false);
      assert.equal(await predicate(), true);
    }
  });
  assert.equal(result.exitCode, 137);
  assert.equal(reads, 2);
});

test('database selection defaults to the original database without an administration connection', async () => {
  const result = await harnessModule.prepareQualificationDatabase({ adminOptions });
  assert.deepEqual(result, { options: adminOptions, created: false });
});

test('database creation rejects unsafe names and wrong guest before connecting', async () => {
  const createClient = () => assert.fail('Must not connect before guards pass');
  for (const databaseName of ['postgres', 'site_qualification', 'site_qualification_',
    'site_qualification_candidate3;DROP DATABASE postgres', 'site_qualification_Candidate3',
    `site_qualification_${'a'.repeat(25)}`]) {
    await assert.rejects(harnessModule.prepareQualificationDatabase({
      adminOptions, databaseName, createClient, verifyGuest: () => assert.fail('Invalid names cannot reach the VM')
    }), /qualification database name/i);
  }
  await assert.rejects(harnessModule.prepareQualificationDatabase({
    adminOptions, databaseName: 'site_qualification_candidate3', createClient,
    verifyGuest: async () => ({ ...guestStatus, hostname: 'production' })
  }), /site-issue56/);
});

test('selected database is created only when absent, after identity check, without changing private options', async () => {
  for (const exists of [false, true]) {
    const operations = [];
    const result = await harnessModule.prepareQualificationDatabase({
      adminOptions, databaseName: 'site_qualification_candidate3',
      verifyGuest: async () => { operations.push('verify'); return guestStatus; },
      createClient: options => {
        assert.equal(options.database, 'site_qualification');
        assert.equal(options.user, adminOptions.user);
        return {
          async connect() { operations.push('connect'); },
          async query(sql, values) {
            if (sql.startsWith('SELECT')) {
              assert.deepEqual(values, ['site_qualification_candidate3']);
              operations.push('exists');
              return { rowCount: exists ? 1 : 0 };
            }
            assert.equal(sql, 'CREATE DATABASE "site_qualification_candidate3"');
            operations.push('create');
          },
          async end() { operations.push('end'); }
        };
      }
    });
    assert.deepEqual(operations, ['verify', 'connect', 'exists', ...exists ? [] : ['create'], 'end']);
    assert.equal(result.created, !exists);
    assert.equal(result.options.database, 'site_qualification_candidate3');
    assert.equal(adminOptions.database, 'site_qualification');
  }
});

test('setup uses the selected database despite saved application options and rolls the pod on database changes', async t => {
  const h = await harnessFor(t);
  const saved = JSON.stringify({ database: 'site_qualification', user: 'site_issue56_app', password: 'a'.repeat(48) });
  await writeFile(join(h.state, 'application-options.json'), saved);
  h.options.database = 'site_qualification_candidate3';
  const objects = [];
  const digest = `sha256:${'b'.repeat(64)}`;
  h.sql = async () => ({ rowCount: 1, rows: [{ rolsuper: false, rolcreatedb: false, rolcreaterole: false }] });
  h.apply = async values => { objects.push(...values); };
  h.guest = async () => ({ stdout: "" });
  h.kubectl = async () => ({ stdout: '' });
  h.waitFor = async () => {};
  h.health = async () => ({ release: { digest } });
  h.currentPod = async () => ({ status: { containerStatuses: [{ imageID: digest }] } });
  await setupApplication(h, { image: `docker.io/library/site-issue56@${digest}` });
  for (const secret of objects.filter(object => object.kind === 'Secret')) {
    assert.equal(new URL(secret.stringData.DATABASE_URL).pathname, '/site_qualification_candidate3');
  }
  const deployment = objects.find(object => object.kind === 'Deployment');
  assert.equal(deployment.spec.template.metadata.annotations['qualification/database'], h.options.database);
  assert.equal(await readFile(join(h.state, 'application-options.json'), 'utf8'), saved);
});
