import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import pg from 'pg'
import PgBoss from 'pg-boss'
import { configureRecoveryQueue, rearmFailedRecoveryJobs } from '../../server/queues/recoveryPolicy.js'
import { initializeEpisodeWorker, queueEpisodeResolution, stopQueue } from '../../server/queues/episodeQueue.js'

const optionsFile = process.env.RESILIENCE_POSTGRES_OPTIONS

test('Golden Journey — legacy accepted jobs and failed commits recover on real PostgreSQL', {
  skip: !optionsFile, timeout: 60_000
}, async t => {
  const options = JSON.parse(await readFile(optionsFile, 'utf8'))
  assert.equal(options.host, '127.0.0.1', 'This test accepts only the qualification tunnel')
  assert.equal(Number(options.port), 25456)
  assert.equal(options.database, 'site_qualification')
  const name = `issue56_queue_${Date.now()}`
  const admin = new pg.Client(options)
  await admin.connect()
  await admin.query(`CREATE DATABASE ${name}`)
  const isolated = { ...options, database: name, connectionTimeoutMillis: 1500, query_timeout: 2000 }
  const pool = new pg.Pool(isolated)
  let legacy
  let worker
  t.after(async () => {
    if (worker) await stopQueue(worker, { graceful: false })
    if (legacy) await legacy.stop({ graceful: false })
    await pool.end()
    await admin.query(`DROP DATABASE ${name}`)
    await admin.end()
  })
  for (const file of (await readdir(new URL('../../sql/', import.meta.url))).filter(file => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(`../../sql/${file}`, import.meta.url), 'utf8'))
  }
  legacy = new PgBoss({ ...isolated, schema: 'pgboss', supervise: false, schedule: false })
  legacy.on('error', () => {})
  await legacy.start()
  await legacy.createQueue('resolve-episode')
  const payload = { season: 199956, episode: 1, episodeDate: '2026-10-11', title: 'Durable qualification', itemGuid: 'qualification-guid' }
  const activeId = await legacy.send('resolve-episode', payload, { expireInSeconds: 900, retryLimit: 2 })
  await legacy.fetch('resolve-episode')
  const createdId = await legacy.send('resolve-episode', { ...payload, episode: 2 }, { expireInSeconds: 900 })
  await configureRecoveryQueue(legacy, 'resolve-episode')
  const migrated = await pool.query('SELECT id, state, data, expire_seconds, retry_limit FROM pgboss.job WHERE name = $1 ORDER BY id', ['resolve-episode'])
  assert.deepEqual(new Set(migrated.rows.map(row => row.id)), new Set([activeId, createdId]))
  assert.equal(migrated.rows.find(row => row.id === activeId).state, 'active')
  for (const row of migrated.rows) {
    assert.equal(row.expire_seconds, 60)
    assert.equal(row.retry_limit, 3)
    assert.equal(row.data.itemGuid, 'qualification-guid')
  }
  await pool.query("UPDATE pgboss.job SET started_on = now() - interval '90 seconds' WHERE id = $1", [activeId])
  await legacy.stop({ graceful: false })
  legacy = null

  await pool.query(`CREATE FUNCTION qualification_reject_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'qualification persistence fault' USING ERRCODE = '08006'; END $$`)
  await pool.query('CREATE TRIGGER qualification_reject_commit BEFORE INSERT OR UPDATE ON episode_links FOR EACH ROW EXECUTE FUNCTION qualification_reject_commit()')
  const keys = ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_SHOW_ID', 'APPLE_PODCAST_ID', 'DEEZER_SHOW_ID', 'YOUTUBE_API_KEY']
  const previous = new Map(keys.map(key => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  worker = await initializeEpisodeWorker({ pg: pool }, {
    queueOptions: { ...isolated, connectionString: undefined, superviseIntervalSeconds: 1, monitorIntervalSeconds: 1 },
    workerOptions: { storageEnabled: false }, op3Options: { env: {} }
  })
  const accepted = await queueEpisodeResolution(199956, 3, '2026-10-11', 'Failed commit', null)
  assert.equal(accepted.queued, true)
  const waitFor = async predicate => {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const value = await predicate()
      if (value) return value
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.fail('Expected queue transition within 20 seconds')
  }
  await waitFor(async () => (await pool.query('SELECT state FROM pgboss.job WHERE id = $1', [accepted.jobId])).rows[0]?.state === 'retry')
  assert.equal((await pool.query('SELECT count(*)::int AS total FROM episode_links WHERE season = 199956')).rows[0].total, 0)
  await pool.query('DROP TRIGGER qualification_reject_commit ON episode_links')
  await waitFor(async () => (await pool.query('SELECT state FROM pgboss.job WHERE id = $1', [accepted.jobId])).rows[0]?.state === 'completed')
  await waitFor(async () => (await pool.query('SELECT state FROM pgboss.job WHERE id = $1', [activeId])).rows[0]?.state === 'completed')
  const results = await pool.query('SELECT episode FROM episode_links WHERE season = 199956 ORDER BY episode')
  assert.deepEqual(results.rows.map(row => row.episode), [1, 2, 3])

  await worker.offWork('resolve-episode')
  await configureRecoveryQueue(worker, 'op3-stats-refresh')
  const exhaustedEpisode = await worker.send('resolve-episode', { ...payload, episode: 9 })
  const exhaustedOp3 = await worker.send('op3-stats-refresh', {})
  const coolingEpisode = await worker.send('resolve-episode', { ...payload, episode: 10 })
  await pool.query(`UPDATE pgboss.job SET state = 'failed', retry_count = 3, retry_limit = 3,
    completed_on = now() - interval '61 seconds', output = '{"qualificationFailure":true}'::jsonb
    WHERE id = ANY($1::uuid[])`, [[exhaustedEpisode, exhaustedOp3, coolingEpisode]])
  await pool.query('UPDATE pgboss.job SET completed_on = now() WHERE id = $1', [coolingEpisode])
  assert.deepEqual(await rearmFailedRecoveryJobs(pool), { rearmed: 2 })
  assert.deepEqual(await rearmFailedRecoveryJobs(pool), { rearmed: 0 })
  // Recreating the process/configuration must not erase the cumulative budget.
  await configureRecoveryQueue(worker, 'resolve-episode')
  const rearmed = await pool.query('SELECT id, state, retry_count, retry_limit, output FROM pgboss.job WHERE id = ANY($1::uuid[])', [[exhaustedEpisode, exhaustedOp3, coolingEpisode]])
  for (const row of rearmed.rows) {
    assert.equal(row.retry_count, 3)
    assert.equal(row.output.qualificationFailure, true)
    assert.equal(row.state, row.id === coolingEpisode ? 'failed' : 'retry')
    assert.equal(row.retry_limit, row.id === coolingEpisode ? 3 : 4)
  }
})
