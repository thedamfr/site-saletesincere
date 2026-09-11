import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { namespace, imageRepository, environments, assertCurrentRelease, assertCapacity, selectCandidate } from './policy.mjs';
import { github, releaseForRun, status } from './github.mjs';
import { smoke } from './smoke.mjs';

const config = JSON.parse(fs.readFileSync('/etc/site-saletesincere-delivery/config.json', 'utf8'));
process.env.GH_TOKEN = fs.readFileSync(`${process.env.CREDENTIALS_DIRECTORY}/github-token`, 'utf8').trim();
process.env.KUBECONFIG = `${process.env.CREDENTIALS_DIRECTORY}/kubeconfig`;
if (os.hostname() !== 'game-prod-ovh-gra') throw new Error('Unexpected deployment host');
const kubectl = (...args) => execFileSync('/snap/microk8s/current/kubectl', ['--context=site-delivery', '-n', namespace, ...args], {
  encoding: 'utf8', timeout: 35000, maxBuffer: 3e6, stdio: ['ignore', 'pipe', 'pipe']
});
const get = (kind, name) => JSON.parse(kubectl('get', kind, name, '-o', 'json'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const head = async branch => (await github(`commits/${encodeURIComponent(branch)}`)).sha;
const stateDirectory = '/var/lib/site-saletesincere-delivery';

async function reconcile(environment) {
  const target = environments[environment];
  const query = environment === 'production' ? 'branch=main' : 'event=workflow_dispatch';
  const { workflow_runs: runs } = await github(`actions/workflows/publish-image.yml/runs?${query}&per_page=30`);
  const run = selectCandidate(runs, environment, environment === 'production' ? await head('main') : undefined);
  if (!run || run.conclusion !== 'success') return;
  const release = await releaseForRun(run.id, environment);
  if (!release) return;
  if (release.assessedCommit !== run.head_sha) throw new Error('Run source and manifest disagree');
  const statePath = `${stateDirectory}/${environment}.json`;
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
  if (state.runId > release.runId) return;
  const image = `${imageRepository}@${release.digest}`;
  let deployment = get('deployment', target.deployment);
  const web = deployment.spec.template.spec.containers.find(container => container.name === 'web');
  if (state.runId === release.runId && state.success && web.image === image) return;
  if (state.runId === release.runId && state.retryAfter > Date.now()) return;
  const started = Date.now();
  try {
    assertCurrentRelease(release, await head(target.branch || run.head_branch), config.schema[environment]);
    if (deployment.spec.strategy?.rollingUpdate?.maxUnavailable !== 0 || deployment.spec.strategy?.rollingUpdate?.maxSurge !== 1) throw new Error('Unsafe rollout strategy');
    if ((deployment.status.availableReplicas || 0) < 1) throw new Error('Existing deployment is not available');
    await status(release, 'pending', 'Activation et recette OVH en cours');
    if (web.image !== image) {
      assertCapacity(get('resourcequota', namespace).status, web.resources);
      assertCurrentRelease(release, await head(target.branch || run.head_branch), config.schema[environment]);
      // resourceVersion also refuses a concurrent operator mutation after our read.
      kubectl('patch', 'deployment', target.deployment, '--type=strategic', '-p', JSON.stringify({
        metadata: { resourceVersion: deployment.metadata.resourceVersion },
        spec: { template: { metadata: { annotations: { 'delivery.saletesincere.fr/source': release.imageCommit } },
          spec: { containers: [{ name: 'web', image,
            readinessProbe: { httpGet: null, exec: { command: ['node', 'scripts/delivery/readiness.mjs'] }, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 3 },
            lifecycle: { preStop: { exec: { command: ['node', '-e', 'setTimeout(() => {}, 5000)'] } } }
          }] } } }
      }));
    }
    const deadline = Date.now() + 240000;
    let lastError;
    while (Date.now() < deadline) {
      deployment = get('deployment', target.deployment);
      const pods = get('pods', '-l=' + Object.entries(deployment.spec.selector.matchLabels).map(([key, value]) => `${key}=${value}`).join(',')).items;
      const ready = deployment.status.observedGeneration >= deployment.metadata.generation
        && deployment.status.updatedReplicas === deployment.spec.replicas
        && deployment.status.readyReplicas === deployment.spec.replicas
        && deployment.status.replicas === deployment.spec.replicas
        && pods.filter(pod => !pod.metadata.deletionTimestamp).every(pod => pod.status.containerStatuses?.some(container => container.name === 'web' && container.ready && container.imageID?.endsWith(release.digest)));
      if (ready) {
        try { await smoke(target.url, release.cssHash); lastError = null; break; }
        catch (error) { lastError = error; }
      }
      await pause(5000);
    }
    if (Date.now() >= deadline) throw lastError || new Error('Rollout deadline exceeded');
    assertCurrentRelease(release, await head(target.branch || run.head_branch), config.schema[environment]);
    const result = { ...release, success: true, previousImage: web.image, activeImage: image, durationSeconds: Math.round((Date.now() - started) / 1000), verifiedAt: new Date().toISOString() };
    fs.writeFileSync(statePath, JSON.stringify(result, null, 2));
    await status(release, 'success', `Digest actif et recette réussie (${result.durationSeconds}s)`);
    console.log(JSON.stringify(result));
  } catch (error) {
    // Never report raw subprocess output: Kubernetes configuration may contain secrets.
    const message = error.code || error.status ? 'Kubernetes operation failed; inspect namespace events' : error.message;
    fs.writeFileSync(statePath, JSON.stringify({ ...release, success: false, error: message, retryAfter: Date.now() + 300000 }));
    await status(release, 'failure', message);
    console.error(JSON.stringify({ environment, runId: release.runId, error: message }));
  }
}

// systemd and flock serialize every activation, including manual invocations.
for (const environment of ['staging', 'production']) {
  try { await reconcile(environment); }
  catch { console.error(`Unable to reconcile ${environment}; check GitHub access and namespace prerequisites`); process.exitCode = 1; }
}
