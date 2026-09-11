import { spawnSync } from 'node:child_process';
import { repository, validateRelease } from './policy.mjs';

export async function github(path, body) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`GitHub ${path.split('?')[0]}: HTTP ${response.status}`);
  return response.json();
}

export async function releaseForRun(runId, environment) {
  const { artifacts } = await github(`actions/runs/${runId}/artifacts`);
  const artifact = artifacts.find(item => item.name === `delivery-${environment}` && !item.expired);
  if (!artifact) return null;
  if (artifact.size_in_bytes > 100000) throw new Error('Release artifact exceeds size limit');
  // Node fetch removes Authorization when following a redirect to another origin.
  const response = await fetch(artifact.archive_download_url, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}` }, signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Artifact download: HTTP ${response.status}`);
  const zip = Buffer.from(await response.arrayBuffer());
  if (zip.length > 100000) throw new Error('Release archive exceeds size limit');
  const result = spawnSync('python3', ['-c', 'import io,sys,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); i=z.getinfo("release.json"); assert i.file_size < 20000; sys.stdout.buffer.write(z.read(i))'], { input: zip, maxBuffer: 20000 });
  if (result.status !== 0) throw new Error('Invalid release archive');
  const release = validateRelease(JSON.parse(result.stdout));
  if (release.runId !== Number(runId) || release.environment !== environment) throw new Error('Release provenance mismatch');
  return release;
}

export async function status(release, state, description) {
  await github(`statuses/${release.assessedCommit}`, {
    state, context: `OVH / ${release.environment}`, description: description.slice(0, 140),
    target_url: `https://github.com/${repository}/actions/runs/${release.runId}`
  });
}
