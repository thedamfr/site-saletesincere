import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPodcastApp } from '../helpers/podcastApp.js';

test('health exposes validated release identity while retaining degraded liveness', async t => {
  const originalCommit = process.env.RELEASE_COMMIT;
  const originalDigest = process.env.RELEASE_DIGEST;
  t.after(() => {
    if (originalCommit === undefined) delete process.env.RELEASE_COMMIT;
    else process.env.RELEASE_COMMIT = originalCommit;
    if (originalDigest === undefined) delete process.env.RELEASE_DIGEST;
    else process.env.RELEASE_DIGEST = originalDigest;
  });
  process.env.RELEASE_COMMIT = 'a'.repeat(40);
  process.env.RELEASE_DIGEST = `sha256:${'b'.repeat(64)}`;
  const app = await buildPodcastApp();
  t.after(() => app.close());
  const response = await app.inject('/health');
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mode, 'degraded');
  assert.deepEqual(response.json().release, {
    sourceCommit: process.env.RELEASE_COMMIT, digest: process.env.RELEASE_DIGEST
  });
});
