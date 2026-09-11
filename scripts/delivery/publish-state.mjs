import fs from 'node:fs';
import { github } from './github.mjs';
import { validateRelease } from './policy.mjs';

const release = validateRelease(JSON.parse(fs.readFileSync('release.json')));
const branch = 'codex/delivery-state';
const path = `contents/${release.environment}.json`;
if (release.environment === 'production' && (await github('commits/main')).sha !== release.assessedCommit) {
  console.log('Superseded main: release state is not changed.');
  process.exit(0);
}
let existing;
try { existing = await github(`${path}?ref=${encodeURIComponent(branch)}`); }
catch (error) { if (!error.message.endsWith('HTTP 404')) throw error; }
if (existing) {
  const previous = JSON.parse(Buffer.from(existing.content, 'base64'));
  if (previous.runId > release.runId) throw new Error('Newer delivery intent already exists');
}
await github(path, {
  message: `delivery: ${release.environment} run ${release.runId}`, branch,
  content: Buffer.from(JSON.stringify(release, null, 2)).toString('base64'),
  ...(existing ? { sha: existing.sha } : {})
}, 'PUT');
