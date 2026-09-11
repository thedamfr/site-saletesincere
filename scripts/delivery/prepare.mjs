import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fingerprint, hash } from './policy.mjs';
import { github, releaseForRun } from './github.mjs';

const entries = execFileSync('git', ['ls-tree', '-r', 'HEAD'], { encoding: 'utf8' }).trim().split('\n');
const currentFingerprint = fingerprint(entries);
const schema = hash(entries.filter(entry => /\t(?:sql\/|scripts\/migrate.js$)/.test(entry)).join('\n'));
const assessedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const environment = process.env.DELIVERY_ENVIRONMENT || 'production';
if (environment === 'production' && process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Production requires main');
let previous;
if (process.env.FORCE_BUILD !== 'true') {
  const { workflow_runs: runs } = await github('actions/workflows/publish-image.yml/runs?status=success&per_page=30');
  for (const run of runs) {
    if (!['push', 'workflow_dispatch'].includes(run.event)) continue;
    for (const env of ['production', 'staging']) {
      const candidate = await releaseForRun(run.id, env);
      if (candidate?.fingerprint === currentFingerprint) { previous = candidate; break; }
    }
    if (previous) break;
  }
}
const release = { environment, assessedCommit, imageCommit: previous?.imageCommit || assessedCommit,
  digest: previous?.digest, fingerprint: currentFingerprint, schema, runId: Number(process.env.GITHUB_RUN_ID) };
fs.writeFileSync('release.json', JSON.stringify(release, null, 2));
fs.appendFileSync(process.env.GITHUB_OUTPUT, `build=${!previous}\nimageCommit=${release.imageCommit}\n`);
