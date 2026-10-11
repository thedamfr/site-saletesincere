import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { createHarness } from './resilience-harness.mjs';
import { startFixture, fixtureEpisodes } from './resilience-fixture.mjs';
import { setupApplication } from './resilience-setup.mjs';
import { exerciseNewsletter } from './newsletter-resilience.mjs';
import { navigation } from './resilience-navigation.mjs';
import { checkNavigationAfterCampaign } from './resilience-navigation-check.mjs';
import { crashOnBoundary, crashOnLock, exerciseBeforeAcceptance } from './durable-boundaries.mjs';

if (process.argv.includes('--navigation-only')) {
  assert.deepEqual(process.argv.slice(2), ['--navigation-only']);
  await checkNavigationAfterCampaign();
} else {

// Destructive actions are confined to an explicitly identified, disposable VM.
const stateDir = process.env.RESILIENCE_VM_STATE;
assert.ok(stateDir, 'Set RESILIENCE_VM_STATE to the private site-issue56 qualification state');
const phase = process.env.RESILIENCE_PHASE || 'all';
assert.ok(['setup', 'all'].includes(phase), 'RESILIENCE_PHASE must be setup or all');
const outputDir = process.env.RESILIENCE_OUTPUT || `${stateDir}/results-${Date.now()}`;
await mkdir(outputDir, { recursive: true, mode: 0o700 });
assert.deepEqual(await readdir(outputDir), [], 'Use a new evidence directory; previous observations must not be overwritten');
const candidate = JSON.parse(await readFile(`${stateDir}/candidate.json`, 'utf8'));
const proofFiles = ['test/e2e/resilience.test.mjs', 'test/e2e/resilience-fixture.mjs',
  'test/e2e/resilience-harness.mjs', 'test/e2e/resilience-setup.mjs', 'test/e2e/durable-boundaries.mjs',
  'test/e2e/newsletter-resilience.mjs', 'test/e2e/resilience-navigation.mjs', 'scripts/qualification/recovery-vm.py', 'scripts/qualification/observe-boundary.py'];
const hashes = Object.fromEntries(await Promise.all(proofFiles.map(async path => [path,
  createHash('sha256').update(await readFile(path)).digest('hex')])));
await writeFile(`${outputDir}/environment.json`, JSON.stringify({
  startedAt: new Date().toISOString(), node: process.version,
  command: 'npm run test:e2e:resilience', phase,
  database: process.env.RESILIENCE_DATABASE || 'site_qualification',
  candidate, harness: hashes,
  wavesurferSha256: createHash('sha256').update(await readFile(`${stateDir}/wavesurfer.esm.js`)).digest('hex'),
  providers: 'synthetic, external to guest', recoveryDeadlineMs: 300_000
}, null, 2), { mode: 0o600 });
const h = await createHarness({ stateDir, outputDir });
h.assertRoutingReadiness = async () => {
  const pod = await h.currentPod();
  const result = await h.kubectl(['exec', pod.metadata.name, '--', 'node', '/app/scripts/delivery/readiness.mjs'], { timeout: 20_000 });
  assert.equal(result.code, 0, 'routing probe must accept healthy HTTP in normal or degraded mode');
};
const f = await startFixture({ output: `${stateDir}/provider-journal.json` });
let browser;
const jobFor = async episode => (await h.sql(`SELECT id, state, retry_count, data FROM pgboss.job
  WHERE name = 'resolve-episode' AND (data->>'season')::integer = 91 AND (data->>'episode')::integer = $1
  ORDER BY created_on DESC LIMIT 1`, [episode])).rows[0];
const resolved = async episode => {
  const { rows } = await h.sql('SELECT * FROM episode_links WHERE season = 91 AND episode = $1', [episode]);
  return rows.length === 1 && rows[0].spotify_url && rows[0].apple_url && rows[0].deezer_url ? rows[0] : false;
};
const recoverEpisode = async (episode, since = performance.now()) => {
  await h.waitFor(async () => await resolved(episode) && (await jobFor(episode))?.state === 'completed',
    `episode ${episode}: persisted links and durable completion`, Math.max(1, 300_000 - (performance.now() - since)));
  const elapsedMs = Math.round(performance.now() - since);
  assert.ok(elapsedMs <= 300_000);
  assert.equal((await h.sql('SELECT count(*)::integer AS count FROM episode_links WHERE season=91 AND episode=$1', [episode])).rows[0].count, 1);
  h.events.push({ operation: 'business result', episode, elapsedMs });
};
const addFreshEpisode = async () => {
  // Previous runs remain intact; never make a false durability proof by resetting data.
  let episode;
  do { episode = f.addEpisode(); } while (await jobFor(episode.episode));
  return episode;
};


try {
  assert.equal((await h.guest('hostname')).stdout.trim(), 'site-issue56');
  await h.scenario('Candidat par digest, migrations rejouées et droits restreints', () => setupApplication(h, candidate));
  await h.scenario('RSS reconstruit sans visite les caches vides et le trailer avec itemGuid', async () => {
    for (const episode of fixtureEpisodes) await recoverEpisode(episode.episode);
    const job = await jobFor(0);
    assert.equal(job.data.itemGuid, 'qualification-s91e0');
    await h.waitFor(async () => (await h.sql("SELECT * FROM op3_stats WHERE item_guid = 'qualification-s91e2' AND downloads_all=50")).rowCount === 1, 'OP3 business result');
    await h.assertRoutingReadiness();
  });
  if (phase === 'setup') {
    console.log('Initial candidate usable; destructive campaign not requested by this phase.');
  } else {
    browser = await chromium.launch({ chromiumSandbox: true, executablePath: process.env.E2E_BROWSER_EXECUTABLE || undefined,
      channel: process.env.E2E_BROWSER_CHANNEL || undefined });
    await h.scenario('Navigation publique → épisode → lecture audio → lien plateforme', () => navigation({ browser, stateDir, outputDir, episodes: fixtureEpisodes, suffix: 'before' }));

    await h.freshProcess();
    await h.scenario('PostgreSQL absent puis disponible : HTTP dégradé, refus newsletter et reprise automatique', async () => {
      const before = await f.snapshot();
      await h.kubectl(['scale', 'statefulset/postgres', '--replicas=0']);
      try {
        await h.waitFor(async () => (await h.health(false))?.database?.state === 'unavailable', 'database unavailable exposed');
        await h.restartApp({ requireNormal: false });
        for (const path of ['/', '/podcast', '/health']) assert.equal((await h.request(path)).status, 200);
        await h.assertRoutingReadiness();
        const response = await h.request('/newsletter/subscribe', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: `email=absent-${Date.now()}%40example.test` });
        assert.equal(response.status, 503);
        assert.equal((await f.snapshot()).mutationsAttempted, before.mutationsAttempted);
      } finally { await h.kubectl(['scale', 'statefulset/postgres', '--replicas=1']); }
      await h.waitFor(async () => (await h.sql('SELECT 1')).rowCount, 'PostgreSQL returned');
      const since = performance.now();
      await h.waitFor(() => h.health(true), 'worker recovered');
      const episode = await addFreshEpisode();
      await recoverEpisode(episode.episode, since);
    });

    await h.freshProcess();
    await h.scenario('Panne fournisseurs prolongée puis retour : intentions acceptées et OP3 réarmés sans visite', async () => {
      await f.configure({ platforms: { unavailable: true }, op3: { unavailable: true } });
      const op3JobId = await h.enqueue('op3-stats-refresh');
      const beforeOp3 = (await h.sql('SELECT max(fetched_at) AS fetched FROM op3_stats')).rows[0].fetched;
      const episode = await addFreshEpisode();
      // Real elapsed retries/expiration: no clock or retry metadata is shortened.
      await h.waitFor(async () => (await jobFor(episode.episode))?.state === 'failed', 'episode retry budget exhausted');
      await h.waitFor(async () => (await h.sql('SELECT state FROM pgboss.job WHERE id=$1', [op3JobId])).rows[0]?.state === 'failed', 'OP3 retry budget exhausted');
      assert.equal(await resolved(episode.episode), false);
      await f.configure({ platforms: { unavailable: false }, op3: { unavailable: false } });
      const since = performance.now();
      await recoverEpisode(episode.episode, since);
      await h.waitFor(async () => (await h.sql('SELECT state FROM pgboss.job WHERE id=$1', [op3JobId])).rows[0]?.state === 'completed',
        'OP3 resumed before next daily schedule', Math.max(1, 300_000 - (performance.now() - since)));
      assert.ok((await h.sql('SELECT max(fetched_at) AS fetched FROM op3_stats')).rows[0].fetched > beforeOp3);
    });

    await h.freshProcess();
    await h.scenario('Crash pendant traitement après acquittement durable : même intention reprise', async () => {
      await f.configure({ platforms: { hold: true } });
      const episode = await addFreshEpisode();
      await h.waitFor(async () => (await jobFor(episode.episode))?.state === 'active', 'durable active episode');
      const accepted = await jobFor(episode.episode);
      assert.equal(await resolved(episode.episode), false);
      await crashOnBoundary(h, { kind: 'job-active', jobId: accepted.id, minRetryCount: accepted.retry_count });
      await f.configure({ platforms: { hold: false } });
      await recoverEpisode(episode.episode);
      assert.equal((await jobFor(episode.episode)).id, accepted.id);
    });

    await h.freshProcess();
    await h.scenario('Crash après commit métier avant acquittement pg-boss : résultat unique', async () => {
      await f.configure({ platforms: { hold: true } });
      const episode = await addFreshEpisode();
      const key = 560091;
      const release = await h.holdLock(key);
      let since;
      try {
        await h.sql(`CREATE OR REPLACE FUNCTION qualification_hold_completion() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.name = 'resolve-episode' AND NEW.state = 'completed' AND (NEW.data->>'episode')::integer = ${episode.episode}
            THEN PERFORM pg_advisory_xact_lock(${key}); END IF; RETURN NEW; END $$`);
        await h.sql('CREATE TRIGGER qualification_hold_completion BEFORE UPDATE ON pgboss.job FOR EACH ROW EXECUTE FUNCTION qualification_hold_completion()');
        since = await crashOnLock(h, key,
          () => f.configure({ platforms: { hold: false } }),
          async () => {
            assert.ok(await resolved(episode.episode), 'business transaction committed before observed crash');
            assert.equal((await jobFor(episode.episode)).state, 'active');
          });
      } finally {
        await release();
        await h.sql('DROP TRIGGER IF EXISTS qualification_hold_completion ON pgboss.job');
        await h.sql('DROP FUNCTION IF EXISTS qualification_hold_completion()');
      }
      await recoverEpisode(episode.episode, since);
    });

    await exerciseBeforeAcceptance(h, f);
    await exerciseNewsletter(h, f);

    await h.freshProcess();
    await h.scenario('SIGTERM applicatif : arrêt gracieux terminé sans destruction forcée', async () => {
      const timings = await h.restartApp({ signal: 'SIGTERM' });
      await recoverEpisode(2, timings.startedAt);
    });

    for (const operation of ['shutdown', 'crash']) {
      await h.freshProcess();
      await h.scenario(`${operation} VM : données acquittées, droits et temporaires`, async () => {
        const durable = (await h.sql('SELECT id, season, episode, spotify_url, apple_url, deezer_url FROM episode_links ORDER BY id')).rows;
        const ledger = (await h.sql('SELECT id, state, attempted_at FROM newsletter_requests ORDER BY id')).rows;
        const pod = await h.currentPod();
        await h.kubectl(['exec', pod.metadata.name, '--', 'node', '-e', 'require("node:fs").writeFileSync("/tmp/qualification-marker","temporary")']);
        const timings = await h.cycleVM(operation);
        assert.deepEqual((await h.sql('SELECT id, season, episode, spotify_url, apple_url, deezer_url FROM episode_links ORDER BY id')).rows, durable);
        const afterLedger = (await h.sql('SELECT id, state, attempted_at FROM newsletter_requests ORDER BY id')).rows;
        for (const row of ledger) assert.deepEqual(afterLedger.find(item => item.id === row.id), row);
        await recoverEpisode(2, timings.dependenciesAt);
        const after = await h.currentPod();
        const temporary = await h.kubectl(['exec', after.metadata.name, '--', 'node', '-e', 'process.exit(require("node:fs").existsSync("/tmp/qualification-marker")?1:0)']);
        assert.equal(temporary.code, 0);
        assert.deepEqual((await h.sql("SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname='site_issue56_app'")).rows[0],
          { rolsuper: false, rolcreatedb: false, rolcreaterole: false });
      });
    }

    await h.freshProcess();
    await h.scenario('Deuxième coupure VM pendant récupération puis résultat métier sous 300 secondes', async () => {
      await f.configure({ platforms: { hold: true } });
      const episode = await addFreshEpisode();
      await h.waitFor(async () => (await jobFor(episode.episode))?.state === 'active', 'active before first hard cut');
      const accepted = await jobFor(episode.episode);
      await h.cycleVM('crash', { kind: 'job-active', jobId: accepted.id, minRetryCount: accepted.retry_count });
      await h.cycleVM('crash', { kind: 'job-active', jobId: accepted.id, minRetryCount: accepted.retry_count + 1 });
      await f.configure({ platforms: { hold: false } });
      await recoverEpisode(episode.episode);
      assert.equal((await jobFor(episode.episode)).id, accepted.id);
    });
    await h.scenario('Navigation et lecture audio après coupures réelles', () => navigation({ browser, stateDir, outputDir, episodes: fixtureEpisodes, suffix: 'after' }));
  }
  await writeFile(`${outputDir}/candidate.json`, JSON.stringify(candidate, null, 2), { mode: 0o600 });
  console.log(`Resilience qualification passed: ${h.results.length} scenarios; evidence ${outputDir}`);
} finally {
  const cleanup = await Promise.allSettled([browser?.close(), f.close(), h.close()]);
  for (const result of cleanup) if (result.status === 'rejected') console.error('Qualification cleanup failed:', result.reason?.message);
  if (cleanup.some(result => result.status === 'rejected')) process.exitCode = 1;
}
}
