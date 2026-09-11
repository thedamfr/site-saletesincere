import { github, releaseForRun, status } from './github.mjs';
import { environments } from './policy.mjs';
import { smoke } from './smoke.mjs';

const runId = Number(process.env.DELIVERY_RUN_ID);
let release;
for (const environment of ['production', 'staging']) {
  release = await releaseForRun(runId, environment);
  if (release) break;
}
if (!release) throw new Error('No validated delivery manifest');
await status(release, 'pending', 'En attente de la version et de la recette OVH');
const deadline = Date.now() + 12 * 60 * 1000;
let lastError;
while (Date.now() < deadline) {
  if (release.environment === 'production' && (await github('commits/main')).sha !== release.assessedCommit) {
    await status(release, 'error', 'Version dépassée : le nouveau main sera livré');
    console.log('Superseded by a newer main; no activation expected for this run.');
    process.exit(0);
  }
  try {
    await smoke(environments[release.environment].url, release.cssHash, release);
    await status(release, 'success', 'Version attendue et recette du domaine public vérifiées');
    console.log(JSON.stringify({ ...release, verified: true }));
    process.exit(0);
  } catch (error) { lastError = error; }
  await new Promise(resolve => setTimeout(resolve, 15000));
}
await status(release, 'failure', lastError?.message || 'OVH verification deadline exceeded');
throw lastError || new Error('OVH verification deadline exceeded');
