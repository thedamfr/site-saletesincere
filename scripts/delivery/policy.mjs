import { createHash } from 'node:crypto';

export const repository = 'thedamfr/site-saletesincere';
export const imageRepository = `ghcr.io/${repository}`;
export const namespace = 'site-saletesincere';
export const environments = {
  production: { deployment: namespace, url: 'https://saletesincere.fr', branch: 'main' },
  staging: { deployment: `${namespace}-staging`, url: 'https://staging.saletesincere.fr' }
};

// Docker copies only the runtime/build paths. Unknown paths conservatively rebuild.
export function fingerprint(entries) {
  return hash(entries.filter(entry => {
    const file = entry.split('\t').at(-1);
    return !/^(documentation|security|castopod|test|k8s)\//.test(file)
      && !/^[^/]+\.md$/i.test(file)
      && file !== 'server/views/README.md';
  }).sort().join('\n'));
}

export function hash(value) { return createHash('sha256').update(value).digest('hex'); }

export function selectCandidate(runs, environment, head) {
  return runs.filter(run => ['push', 'workflow_dispatch'].includes(run.event)
    && run.head_repository?.full_name === repository
    && run.display_title.startsWith(`${environment} ·`)
    && (environment !== 'production' || (run.head_branch === 'main' && run.head_sha === head)))
    .sort((a, b) => b.id - a.id)[0];
}

export function validateRelease(release) {
  if (!environments[release.environment]
      || !/^[a-f0-9]{40}$/.test(release.assessedCommit)
      || !/^[a-f0-9]{40}$/.test(release.imageCommit)
      || !/^sha256:[a-f0-9]{64}$/.test(release.digest)
      || !/^[a-f0-9]{64}$/.test(release.schema)
      || !/^[a-f0-9]{64}$/.test(release.fingerprint)
      || !Number.isSafeInteger(release.runId) || release.runId < 1) {
    throw new Error('Invalid release manifest');
  }
  return release;
}

export function assertCurrentRelease(release, head, verifiedSchema) {
  validateRelease(release);
  if (release.assessedCommit !== head) throw new Error('Release superseded by a newer branch head');
  if (release.schema !== verifiedSchema) throw new Error('Unverified migration: operator schema validation required');
}

function quantity(value) {
  const match = /^(\d+(?:\.\d+)?)(m|Ki|Mi|Gi|Ti|k|M|G)?$/.exec(value);
  if (!match) throw new Error('Unsupported resource quantity');
  const scale = { m: 0.001, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, k: 1000, M: 1e6, G: 1e9 };
  return Number(match[1]) * (scale[match[2]] ?? 1);
}

export function assertCapacity(quota, resources) {
  for (const kind of ['requests', 'limits']) {
    for (const resource of ['cpu', 'memory']) {
      const key = `${kind}.${resource}`;
      if (quota.hard[key] && quantity(quota.used[key] || '0') + quantity(resources[kind][resource]) > quantity(quota.hard[key])) {
        throw new Error(`Insufficient rollout quota: ${key}`);
      }
    }
  }
}
