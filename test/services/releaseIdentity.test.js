import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getReleaseIdentity } from '../../server/services/releaseIdentity.js';

test('release identity exposes only validated source and digest metadata', () => {
  const sourceCommit = 'a'.repeat(40), digest = `sha256:${'b'.repeat(64)}`;
  assert.deepEqual(getReleaseIdentity({ RELEASE_COMMIT: sourceCommit, RELEASE_DIGEST: digest, SECRET_TOKEN: 'private' }), { sourceCommit, digest });
  assert.deepEqual(getReleaseIdentity({ RELEASE_COMMIT: 'private', RELEASE_DIGEST: 'wrong' }), {});
  assert.deepEqual(getReleaseIdentity({}), {});
});
