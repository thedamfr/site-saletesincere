import { github, releaseForRun, status } from './github.mjs';
import { environments } from './policy.mjs';
import { smoke } from './smoke.mjs';
import fs from 'node:fs';

const runId = Number(process.env.DELIVERY_RUN_ID);
let release;
for (const environment of ['production', 'staging']) {
  release = await releaseForRun(runId, environment);
  if (release) break;
}
if (!release) throw new Error('No validated delivery manifest');
await status(release, 'pending', 'En attente de la version et de la recette OVH');
const deadline = Date.now() + 12 * 60 * 1000;
const started = Date.now();
function summarize(result, detail) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### OVH ${release.environment} — ${result}\n\nCommit évalué : ${release.assessedCommit}\n\nCommit image attendu : ${release.imageCommit}\n\nDigest : ${release.digest}\n\nDurée de vérification : ${Math.round((Date.now() - started) / 1000)} s\n\n${detail}\n\n[Run source](https://github.com/thedamfr/site-saletesincere/actions/runs/${release.runId})\n`);
}
let lastError;
while (Date.now() < deadline) {
  if (release.environment === 'production' && (await github('commits/main')).sha !== release.assessedCommit) {
    await status(release, 'error', 'Version dépassée : le nouveau main sera livré');
    summarize('version dépassée', 'Aucune activation attendue pour ce run.');
    console.log('Superseded by a newer main; no activation expected for this run.');
    process.exit(0);
  }
  try {
    await smoke(environments[release.environment].url, release.cssHash, release);
    // Verify again after the readiness and connection-drain windows.
    await new Promise(resolve => setTimeout(resolve, 30000));
    await smoke(environments[release.environment].url, release.cssHash, release);
    await status(release, 'success', 'Version attendue et recette du domaine public vérifiées');
    summarize('vérifié', 'Deux recettes réussies à 30 secondes d’intervalle : identité de version, santé normal/read_write/ready, accueil, podcast, épisode, laboratoire, hash CSS, redirections et indexation. Les imageID des pods et la fin du rollout sont également vérifiés dans le journal du service OVH.');
    console.log(JSON.stringify({ ...release, verified: true }));
    process.exit(0);
  } catch (error) { lastError = error; }
  await new Promise(resolve => setTimeout(resolve, 15000));
}
await status(release, 'failure', lastError?.message || 'OVH verification deadline exceeded');
summarize('échec', lastError?.message || 'Délai de vérification dépassé.');
throw lastError || new Error('OVH verification deadline exceeded');
