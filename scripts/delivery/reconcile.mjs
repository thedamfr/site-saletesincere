import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { namespace, imageRepository, environments, assertCurrentRelease, assertCapacity, selectCandidate, validateRelease } from './policy.mjs';
import { github } from './github.mjs';
import { smoke } from './smoke.mjs';

const config = JSON.parse(fs.readFileSync('/etc/site-saletesincere-delivery/config.json', 'utf8'));
process.env.KUBECONFIG = `${process.env.CREDENTIALS_DIRECTORY}/kubeconfig`;
if (os.hostname() !== 'game-prod-ovh-gra') throw new Error('Unexpected deployment host');
const kubectl = (...args) => execFileSync('/snap/microk8s/current/kubectl', ['--context=site-delivery', '-n', namespace, ...args], {
  encoding: 'utf8', timeout: 35000, maxBuffer: 3e6, stdio: ['ignore', 'pipe', 'pipe']
});
const get = (kind, name) => JSON.parse(kubectl('get', kind, name, '-o', 'json'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const head = async branch => {
  const output = execFileSync('git', ['-c', 'credential.helper=', 'ls-remote', 'https://github.com/thedamfr/site-saletesincere.git', `refs/heads/${branch}`], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  return output.trim().split(/\s+/)[0];
};
const stateDirectory = '/var/lib/site-saletesincere-delivery';

async function reconcile(environment) {
  const target = environments[environment];
  const desiredResponse = await fetch(`https://raw.githubusercontent.com/thedamfr/site-saletesincere/codex/delivery-state/${environment}.json?poll=${Date.now()}`, { signal: AbortSignal.timeout(20000) });
  if (desiredResponse.status === 404) return;
  if (!desiredResponse.ok) throw new Error('Cannot read public delivery state');
  const desiredText = await desiredResponse.text();
  if (desiredText.length > 20000) throw new Error('Delivery state exceeds size limit');
  const release = validateRelease(JSON.parse(desiredText));
  if (release.environment !== environment) throw new Error('Environment mismatch');
  const statePath = `${stateDirectory}/${environment}.json`;
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
  if (state.runId > release.runId) return;
  const image = `${imageRepository}@${release.digest}`;
  let deployment = get('deployment', target.deployment);
  const web = deployment.spec.template.spec.containers.find(container => container.name === 'web');
  if (state.runId === release.runId && state.success && web.image === image) return;
  if (state.runId === release.runId && state.retryAfter > Date.now()) return;
  // Authenticated credentials stay on GitHub. Public API calls occur only for a
  // changed delivery intent; unchanged timer ticks use raw GitHub and Kubernetes.
  const run = await github(`actions/runs/${release.runId}`);
  if (run.status !== 'completed') return;
  if (run.conclusion !== 'success' || run.head_sha !== release.assessedCommit
      || !selectCandidate([run], environment, release.assessedCommit)
      || run.path !== '.github/workflows/publish-image.yml') throw new Error('Unvalidated delivery provenance');
  if (environment === 'staging') {
    const { workflow_runs: runs } = await github('actions/workflows/publish-image.yml/runs?event=workflow_dispatch&per_page=30');
    if (selectCandidate(runs, environment)?.id !== run.id) return;
  }
  const started = Date.now();
  try {
    assertCurrentRelease(release, await head(target.branch || run.head_branch), config.schema[environment]);
    if (deployment.spec.strategy?.rollingUpdate?.maxUnavailable !== 0 || deployment.spec.strategy?.rollingUpdate?.maxSurge !== 1) throw new Error('Unsafe rollout strategy');
    if ((deployment.status.availableReplicas || 0) < 1) throw new Error('Existing deployment is not available');
    if (web.image !== image) {
      assertCapacity(get('resourcequota', namespace).status, web.resources);
      assertCurrentRelease(release, await head(target.branch || run.head_branch), config.schema[environment]);
      // resourceVersion also refuses a concurrent operator mutation after our read.
      kubectl('patch', 'deployment', target.deployment, '--type=strategic', '-p', JSON.stringify({
        metadata: { resourceVersion: deployment.metadata.resourceVersion },
        spec: { template: { metadata: { annotations: { 'delivery.saletesincere.fr/source': release.imageCommit } },
          spec: { containers: [{ name: 'web', image,
            env: [{ name: 'RELEASE_DIGEST', value: release.digest }],
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
        try { await smoke(target.url, release.cssHash, release); lastError = null; break; }
        catch (error) { lastError = error; }
      }
      await pause(5000);
    }
    if (Date.now() >= deadline) throw lastError || new Error('Rollout deadline exceeded');
    assertCurrentRelease(release, await head(target.branch || run.head_branch), config.schema[environment]);
    const result = { ...release, success: true, previousImage: web.image, activeImage: image, durationSeconds: Math.round((Date.now() - started) / 1000), verifiedAt: new Date().toISOString() };
    fs.writeFileSync(statePath, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } catch (error) {
    // Never report raw subprocess output: Kubernetes configuration may contain secrets.
    const message = error.code || error.status ? 'Kubernetes operation failed; inspect namespace events' : error.message;
    fs.writeFileSync(statePath, JSON.stringify({ ...release, success: false, error: message, retryAfter: Date.now() + 300000 }));
    console.error(JSON.stringify({ environment, runId: release.runId, error: message }));
    process.exitCode = 1;
  }
}

// systemd and flock serialize every activation, including manual invocations.
for (const environment of ['staging', 'production']) {
  try { await reconcile(environment); }
  catch { console.error(`Unable to reconcile ${environment}; check GitHub access and namespace prerequisites`); process.exitCode = 1; }
}
