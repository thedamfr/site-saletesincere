import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, validateRelease, assertCapacity, assertCurrentRelease, selectCandidate } from '../../scripts/delivery/policy.mjs';

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
