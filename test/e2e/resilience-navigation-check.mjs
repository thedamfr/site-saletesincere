import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { chromium } from 'playwright';
import { startFixture, fixtureEpisodes } from './resilience-fixture.mjs';
import { navigation } from './resilience-navigation.mjs';

// Requalify only the browser assertion on the persisted post-cut candidate.
// This path does not prepare a database, migrate, deploy or inject a fault.
export async function checkNavigationAfterCampaign() {
  const stateDir = process.env.RESILIENCE_VM_STATE;
  const outputDir = process.env.RESILIENCE_OUTPUT;
  const previousDir = process.env.RESILIENCE_PREVIOUS_OUTPUT;
  assert.ok(stateDir && outputDir && previousDir, 'Explicit state, new output and previous evidence required');
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  assert.deepEqual(await readdir(outputDir), []);
  const previousEnvironment = await readFile(`${previousDir}/environment.json`);
  const previousResults = await readFile(`${previousDir}/results.json`);
  const prior = JSON.parse(previousResults);
  const environment = JSON.parse(previousEnvironment);
  assert.equal(prior.results.length, 20);
  assert.ok(prior.results.slice(0, 19).every(result => result.result === 'passed'));
  assert.equal(prior.results[19].name, 'Navigation et lecture audio après coupures réelles');
  assert.equal(prior.results[19].result, 'failed');
  const candidate = JSON.parse(await readFile(`${stateDir}/candidate.json`, 'utf8'));
  for (const key of ['image', 'sourceTreeSha256', 'patchSha256']) assert.equal(candidate[key], environment.candidate[key]);
  assert.equal(process.env.RESILIENCE_DATABASE, environment.database);
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  const files = ['test/e2e/resilience.test.mjs', 'test/e2e/resilience-navigation-check.mjs',
    'test/e2e/resilience-navigation.mjs', 'test/e2e/resilience-fixture.mjs'];
  const hashes = Object.fromEntries(await Promise.all(files.map(async name => [name, sha256(await readFile(name))])));
  const execute = promisify(execFile);
  const waitFor = async (check, label) => {
    const since = performance.now();
    while (performance.now() - since < 300_000) {
      try { const result = await check(); if (result && performance.now() - since < 300_000) return result; } catch { /* transient boot dependency */ }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`${label} exceeded 300000 ms`);
  };
  const status = await waitFor(async () => {
    const { stdout } = await execute('python3', ['scripts/qualification/recovery-vm.py', 'status', '--state', stateDir], { timeout: 20_000 });
    const value = JSON.parse(stdout);
    return value.running && value.hostname === 'site-issue56' && value;
  }, 'owned guest boot');
  const options = JSON.parse(await readFile(`${stateDir}/application-options.json`, 'utf8'));
  assert.equal(options.host, '127.0.0.1');
  assert.equal(options.port, 25456);
  assert.equal(options.user, 'site_issue56_app');
  const pool = new pg.Pool({ ...options, database: environment.database, max: 1,
    options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 3000, query_timeout: 5000 });
  pool.on('error', () => {});
  let fixture, browser;
  const proof = { startedAt: new Date().toISOString(), command: 'npm run test:e2e:resilience -- --navigation-only',
    phase: 'navigation-only', candidate, database: environment.database, bootId: status.bootId,
    previousEnvironmentSha256: sha256(previousEnvironment), previousResultsSha256: sha256(previousResults),
    previousPassedScenarios: 19, harness: hashes, results: [] };
  const started = performance.now();
  try {
    await waitFor(async () => (await pool.query('SELECT 1')).rowCount === 1, 'existing PostgreSQL');
    const identity = (await pool.query("SELECT current_database() AS database, current_user AS role, current_setting('transaction_read_only') AS read_only")).rows[0];
    assert.deepEqual(identity, { database: environment.database, role: 'site_issue56_app', read_only: 'on' });
    const { stdout } = await execute('ssh', ['-p', '22856', '-i', `${stateDir}/ssh-key`, '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${stateDir}/known_hosts`,
      'ubuntu@127.0.0.1', 'sudo -n k3s kubectl -n site-issue56 get pods -l app=site-issue56-web -o json'], { timeout: 20_000 });
    const pod = JSON.parse(stdout).items.find(item => !item.metadata.deletionTimestamp);
    assert.equal(pod.metadata.annotations['qualification/database'], environment.database);
    assert.equal(pod.spec.containers[0].image, candidate.image);
    assert.ok(pod.status.containerStatuses[0].imageID.includes(candidate.image.split('@')[1]));
    proof.containerId = pod.status.containerStatuses[0].containerID;
    const rows = (await pool.query('SELECT episode FROM episode_links WHERE season=91 ORDER BY episode')).rows;
    assert.deepEqual(rows.map(row => row.episode), [0, 1, 2, 3, 4, 5, 6, 7], 'Persisted post-cut catalogue required');
    const ledger = async () => (await pool.query('SELECT id, request_id, phase, attempted_at::text FROM newsletter_attempts ORDER BY id')).rows;
    const before = await ledger();
    fixture = await startFixture({ output: `${stateDir}/provider-journal.json` });
    while (fixtureEpisodes.at(-1).episode < rows.at(-1).episode) fixture.addEpisode();
    proof.catalogueEpisodes = fixtureEpisodes.map(item => item.episode);
    const beforeEffects = await fixture.snapshot();
    await waitFor(async () => {
      const response = await fetch('http://127.0.0.1:31856/health', { signal: AbortSignal.timeout(3000) });
      const value = await response.json();
      return response.status === 200 && value.ok === true && value.mode === 'normal' && value.database?.state === 'read_write'
        && value.episodeWorker?.state === 'ready' && value.release?.digest === candidate.image.split('@')[1];
    }, 'same candidate nominal health');
    browser = await chromium.launch({ chromiumSandbox: true, executablePath: process.env.E2E_BROWSER_EXECUTABLE || undefined });
    const navigationStarted = performance.now();
    await navigation({ browser, stateDir, outputDir, episodes: fixtureEpisodes, suffix: 'after' });
    assert.deepEqual(await ledger(), before, 'Browser requalification must preserve the attempt journal');
    const afterEffects = await fixture.snapshot();
    assert.equal(afterEffects.effects, beforeEffects.effects);
    assert.equal(afterEffects.mutationsAttempted, beforeEffects.mutationsAttempted);
    proof.results.push({ name: 'Navigation et lecture audio après coupures réelles', result: 'passed',
      episode: 7, durationMs: Math.round(performance.now() - navigationStarted) });
    proof.newsletterJournalUnchanged = true;
    proof.newsletterEffectsUnchanged = true;
    console.log('Post-cut navigation qualification passed on the retained candidate and database.');
  } catch (error) {
    proof.results.push({ name: 'Navigation et lecture audio après coupures réelles', result: 'failed', error: error.message });
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([browser?.close(), fixture?.close(), pool.end()]);
    proof.cleanupSucceeded = cleanup.every(result => result.status === 'fulfilled');
    proof.durationMs = Math.round(performance.now() - started);
    proof.finishedAt = new Date().toISOString();
    await writeFile(`${outputDir}/navigation-proof.json`, JSON.stringify(proof, null, 2), { mode: 0o600 });
    assert.ok(proof.cleanupSucceeded, 'Browser fixture and database cleanup must complete');
  }
}
