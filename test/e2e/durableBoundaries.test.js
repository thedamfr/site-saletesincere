import assert from 'node:assert/strict';
import test from 'node:test';
import { crashOnBoundary } from './durable-boundaries.mjs';

const specification = {
  containerId: 'a'.repeat(64), podName: 'web-qualification', imageDigest: `sha256:${'b'.repeat(64)}`
};
const jobCondition = { kind: 'job-active', jobId: '11111111-2222-4333-8444-555555555555', minRetryCount: 0 };
const confirmation = overrides => ({ stdout: `${JSON.stringify({ event: 'armed' })}\n${JSON.stringify({
  conditionConfirmed: true, processExited: true, signal: 'SIGKILL', ...specification, ...overrides
})}\n` });

function harness({ result = Promise.resolve(confirmation()), sqlRows = 0, onProbe = () => {}, exitCode = 137,
  replacementId = 'c'.repeat(64), replacementPod = specification.podName } = {}) {
  let podReads = 0;
  return {
    events: [],
    boundarySpec: async condition => ({ ...specification, condition }),
    currentPod: async () => {
      const replaced = podReads++ > 0;
      return { metadata: { name: replaced ? replacementPod : specification.podName, uid: 'owned-pod' },
        status: { containerStatuses: [{ name: 'web',
          containerID: `containerd://${replaced ? replacementId : specification.containerId}`,
          restartCount: replaced ? 1 : 0,
          lastState: exitCode === null ? {} : { terminated: { exitCode } }
        }] } };
    },
    guest: () => result,
    sql: async () => { onProbe(); return { rowCount: sqlRows }; },
    health: async () => true,
    waitFor: async (predicate, label) => {
      // Let an already-completed SSH observer settle before the first SQL probe.
      await Promise.resolve();
      await Promise.resolve();
      if (!await predicate()) throw new Error(`test deadline: ${label}`);
    }
  };
}

test('completed exact confirmation survives disappearance before the first SQL arm probe', async () => {
  let opened = false, verified = false;
  const h = harness();
  await crashOnBoundary(h, jobCondition, async () => { opened = true; }, async () => { verified = true; });
  assert.equal(opened, true);
  assert.equal(verified, true);
  assert.equal(h.events.length, 1);
});

test('foreign completed confirmations cannot open the window or claim recovery', async t => {
  for (const overrides of [{ containerId: 'c'.repeat(64) }, { podName: 'web-other' }, { imageDigest: `sha256:${'c'.repeat(64)}` }]) {
    await t.test(Object.keys(overrides)[0], async () => {
      let opened = false, verified = false;
      const h = harness({ result: Promise.resolve(confirmation(overrides)) });
      await assert.rejects(crashOnBoundary(h, jobCondition,
        async () => { opened = true; }, async () => { verified = true; }), { code: 'ERR_ASSERTION' });
      assert.equal(opened, false);
      assert.equal(verified, false);
      assert.deepEqual(h.events, []);
    });
  }
});

test('truthy confirmation strings and mere armed events cannot prove a crash', async () => {
  for (const result of [confirmation({ conditionConfirmed: 'true' }), { stdout: '{"event":"armed"}\n' }]) {
    const h = harness({ result: Promise.resolve(result) });
    await assert.rejects(crashOnBoundary(h, jobCondition), /exact boundary/);
    assert.deepEqual(h.events, []);
  }
});

test('SQL lock window opens only after live arm evidence and before completed confirmation', async () => {
  const pending = Promise.withResolvers();
  const order = [];
  const h = harness({ result: pending.promise, sqlRows: 1, onProbe: () => order.push('sql armed') });
  await crashOnBoundary(h, { kind: 'sql-lock', key: 560091 }, async () => {
    assert.deepEqual(order, ['sql armed']);
    order.push('window opened');
    pending.resolve(confirmation());
  }, async () => { order.push('boundary verified'); });
  assert.deepEqual(order, ['sql armed', 'window opened', 'boundary verified']);
  assert.equal(h.events.length, 1);
});

test('premature SQL lock confirmation cannot replace the controlled window', async () => {
  let opened = false;
  const h = harness();
  await assert.rejects(crashOnBoundary(h, { kind: 'sql-lock', key: 560091 }, async () => { opened = true; }),
    /before.*window/i);
  assert.equal(opened, false);
  assert.deepEqual(h.events, []);
});

test('neither SQL activity nor observer confirmation means no accepted arm proof', async () => {
  let opened = false;
  const h = harness({ result: new Promise(() => {}) });
  await assert.rejects(crashOnBoundary(h, jobCondition, async () => { opened = true; }), /crash observer armed/);
  assert.equal(opened, false);
  assert.deepEqual(h.events, []);
});

test('a missing Kubernetes termination is accepted only with confirmed kernel process exit', async () => {
  const h = harness({ exitCode: null });
  await crashOnBoundary(h, jobCondition);
  assert.equal(h.events[0].exitCode, null);
  assert.equal(h.events[0].terminationSource, 'kernel-pidfd');
  assert.equal(h.events[0].replacementContainerId, 'c'.repeat(64));
});

test('missing or false kernel proof and wrong signal cannot prove process exit', async () => {
  for (const overrides of [{ processExited: undefined }, { processExited: false },
    { processExited: 'true' }, { signal: 'SIGTERM' }, { signal: undefined }]) {
    const h = harness({ result: Promise.resolve(confirmation(overrides)) });
    await assert.rejects(crashOnBoundary(h, jobCondition), { code: 'ERR_ASSERTION' });
    assert.deepEqual(h.events, []);
  }
});

test('contradictory termination, unchanged container and foreign pod cannot claim recovery', async () => {
  for (const options of [{ exitCode: 0 }, { replacementId: specification.containerId }, { replacementPod: 'web-other' }]) {
    const h = harness(options);
    await assert.rejects(crashOnBoundary(h, jobCondition));
    assert.deepEqual(h.events, []);
  }
});
