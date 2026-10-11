import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, validateRelease, assertCapacity, assertCurrentRelease, selectCandidate, rolloutReady } from '../../scripts/delivery/policy.mjs';

const sha = 'a'.repeat(40);
const release = { environment: 'production', assessedCommit: sha, imageCommit: sha,
  digest: `sha256:${'b'.repeat(64)}`, schema: 'c'.repeat(64), fingerprint: 'd'.repeat(64), runId: 123 };

test('documentation and tests do not alter the explicitly bounded image inputs', () => {
  const app = ['100644 blob abc\tserver.js'];
  assert.equal(fingerprint(app), fingerprint([...app, '100644 blob def\tdocumentation/new.md', '100644 blob ghi\ttest/new.test.js']));
});
test('all outstanding application changes affect the fingerprint despite a final documentation commit', () => {
  assert.notEqual(fingerprint(['100644 blob old\tserver.js']), fingerprint(['100644 blob new\tserver.js', '100644 blob doc\treadme.md']));
});
test('unknown inputs, removals, renames and build tooling invalidate the image', () => {
  const base = ['100644 blob abc\tserver.js'];
  for (const file of ['unknown.config', 'server/renamed.js', 'Dockerfile', '.dockerignore', '.github/workflows/publish-image.yml', 'scripts/delivery/policy.mjs']) {
    assert.notEqual(fingerprint(base), fingerprint([...base, `100644 blob def\t${file}`]));
  }
  assert.notEqual(fingerprint(base), fingerprint([]));
});
test('fingerprints are stable regardless of input ordering', () => {
  assert.equal(fingerprint(['b', 'a']), fingerprint(['a', 'b']));
});
test('release accepts only exact validated identities and immutable digests', () => {
  assert.doesNotThrow(() => validateRelease(release));
  for (const change of [{ digest: 'latest' }, { environment: 'other' }, { assessedCommit: 'main' }, { runId: '../escape' }]) {
    assert.throws(() => validateRelease({ ...release, ...change }));
  }
});
test('stale runs and unverified schema changes cannot activate', () => {
  assert.doesNotThrow(() => assertCurrentRelease(release, sha, release.schema));
  assert.throws(() => assertCurrentRelease(release, 'e'.repeat(40), release.schema), /superseded/);
  assert.throws(() => assertCurrentRelease(release, sha, 'f'.repeat(64)), /migration/);
});
test('quota must accommodate an extra pod without stopping staging', () => {
  const resources = { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '500m', memory: '512Mi' } };
  assert.doesNotThrow(() => assertCapacity({hard: {'limits.cpu': '4', 'limits.memory': '4Gi'}, used: {'limits.cpu': '2', 'limits.memory': '2Gi'}}, resources));
  assert.throws(() => assertCapacity({hard: {'limits.cpu': '2'}, used: {'limits.cpu': '2'}}, resources), /quota/);
  assert.throws(() => assertCapacity({hard: {'requests.memory': '768Mi'}, used: {'requests.memory': '640Mi'}}, resources), /quota/);
});

test('a newer failed or running staging request supersedes an older successful request', () => {
  const makeRun = (id, conclusion) => ({ id, conclusion, event: 'workflow_dispatch', display_title: 'staging · branch', head_repository: {full_name: 'thedamfr/site-saletesincere'} });
  assert.equal(selectCandidate([makeRun(3, 'failure'), makeRun(2, 'success')], 'staging').id, 3);
  assert.equal(selectCandidate([makeRun(3, null), makeRun(2, 'success')], 'staging').id, 3);
});

test("author Markdown changes require a new application artifact", () => {
  assert.notEqual(fingerprint(["100644 blob old\tcontent/damien-cavailles.md"]), fingerprint(["100644 blob new\tcontent/damien-cavailles.md"]));
});


function rolloutFixture() {
  return {
    deployment: { metadata: { generation: 9 }, spec: { replicas: 1 }, status: {
      observedGeneration: 9, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1, replicas: 1
    } },
    pod: { metadata: { name: 'current' }, status: { phase: 'Running', containerStatuses: [
      { name: 'web', ready: true, imageID: `ghcr.io/thedamfr/site-saletesincere@${release.digest}` }
    ] } }
  };
}

test('rollout accepts the available deployment with its ready pod at the expected digest', () => {
  const { deployment, pod } = rolloutFixture();
  assert.equal(rolloutReady(deployment, [pod], release.digest), true);
});

for (const phase of ['Succeeded', 'Failed']) {
  test(`rollout ignores a retained ${phase} pod without a deletion timestamp`, () => {
    const { deployment, pod } = rolloutFixture();
    const terminal = { metadata: { name: 'previous' }, status: { phase, containerStatuses: [
      { name: 'web', ready: false, imageID: `ghcr.io/thedamfr/site-saletesincere@sha256:${'e'.repeat(64)}` }
    ] } };
    assert.equal(rolloutReady(deployment, [terminal, pod], release.digest), true);
  });
}

test('rollout continues excluding a deleting pod while checking the active replacement', () => {
  const { deployment, pod } = rolloutFixture();
  const deleting = { metadata: { name: 'draining', deletionTimestamp: '2026-10-11T14:00:00Z' },
    status: { phase: 'Running', containerStatuses: [{ name: 'web', ready: false }] } };
  assert.equal(rolloutReady(deployment, [deleting, pod], release.digest), true);
});

for (const phase of ['Pending', 'Unknown']) {
  test(`rollout refuses an active ${phase} pod even with a stale ready container status`, () => {
    const { deployment, pod } = rolloutFixture();
    pod.status.phase = phase;
    assert.equal(rolloutReady(deployment, [pod], release.digest), false);
  });
}

test('rollout refuses an unready web container', () => {
  const { deployment, pod } = rolloutFixture();
  pod.status.containerStatuses[0].ready = false;
  assert.equal(rolloutReady(deployment, [pod], release.digest), false);
});

test('rollout refuses a missing container status or only a ready sidecar', () => {
  const { deployment, pod } = rolloutFixture();
  delete pod.status.containerStatuses;
  assert.equal(rolloutReady(deployment, [pod], release.digest), false);
  pod.status.containerStatuses = [{ name: 'sidecar', ready: true, imageID: release.digest }];
  assert.equal(rolloutReady(deployment, [pod], release.digest), false);
});

test('rollout refuses a ready pod running another digest', () => {
  const { deployment, pod } = rolloutFixture();
  pod.status.containerStatuses[0].imageID = `ghcr.io/thedamfr/site-saletesincere@sha256:${'f'.repeat(64)}`;
  assert.equal(rolloutReady(deployment, [pod], release.digest), false);
});

test('rollout requires an exact nonempty active pod count', () => {
  const { deployment, pod } = rolloutFixture();
  assert.equal(rolloutReady(deployment, [], release.digest), false);
  assert.equal(rolloutReady(deployment, [pod, { ...pod, metadata: { name: 'extra' } }], release.digest), false);
  deployment.spec.replicas = 0;
  Object.assign(deployment.status, { updatedReplicas: 0, readyReplicas: 0, availableReplicas: 0, replicas: 0 });
  assert.equal(rolloutReady(deployment, [], release.digest), false);
});

test('rollout refuses stale deployment generation and incomplete replica counters', () => {
  const { deployment, pod } = rolloutFixture();
  deployment.status.observedGeneration = 8;
  assert.equal(rolloutReady(deployment, [pod], release.digest), false);
  deployment.status.observedGeneration = 9;
  for (const key of ['updatedReplicas', 'readyReplicas', 'availableReplicas', 'replicas']) {
    deployment.status[key] = 0;
    assert.equal(rolloutReady(deployment, [pod], release.digest), false, key);
    deployment.status[key] = 1;
  }
});
