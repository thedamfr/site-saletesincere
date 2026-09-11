export function getReleaseIdentity(env = process.env) {
  const identity = {};
  if (/^[a-f0-9]{40}$/.test(env.RELEASE_COMMIT || '')) identity.sourceCommit = env.RELEASE_COMMIT;
  if (/^sha256:[a-f0-9]{64}$/.test(env.RELEASE_DIGEST || '')) identity.digest = env.RELEASE_DIGEST;
  return identity;
}
