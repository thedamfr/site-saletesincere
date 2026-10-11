import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../../server.js'
import { createDatabaseAvailability, DatabaseState } from '../../server/resilience/databaseAvailability.js'

test('an idle PostgreSQL connection failure leaves public HTTP alive and reports degradation', async () => {
  const pool = new EventEmitter()
  const availability = createDatabaseAvailability({
    probe: async () => DatabaseState.UNAVAILABLE,
    initialState: DatabaseState.READ_WRITE
  })
  const app = await buildApp({
    initializeStorage: false,
    databaseConfigured: false,
    databaseAdapter: { pool },
    databaseAvailability: availability,
    podcastEpisodesFetcher: async () => []
  })
  try {
    assert.doesNotThrow(() => pool.emit('error', Object.assign(
      new Error('connection terminated unexpectedly'), { code: '57P01' }
    )))
    const home = await app.inject('/')
    const health = await app.inject('/health')
    assert.equal(home.statusCode, 200)
    assert.equal(health.statusCode, 200)
    assert.equal(health.json().database.state, 'unavailable')
  } finally {
    await app.close()
  }
  assert.equal(pool.listenerCount('error'), 0)
})


function controlledRetryTimers() {
  const timers = []
  return {
    timers,
    setTimeoutFn(callback) {
      const timer = { callback, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimeoutFn(timer) { timer.cleared = true }
  }
}

async function recoveryApp({ timers, probe, start, stop, fetchEpisodes }) {
  const pool = new EventEmitter()
  const availability = createDatabaseAvailability({ probe, initialState: DatabaseState.READ_WRITE })
  const app = await buildApp({
    initializeStorage: false,
    databaseConfigured: true,
    databaseAdapter: { pool, query: async () => ({ rows: [] }) },
    databaseAvailability: availability,
    podcastEpisodesFetcher: async () => [],
    recoveryEpisodesFetcher: fetchEpisodes,
    newsletterService: { start() {}, async stop() {} },
    episodeWorkerStarter: async () => {
      const state = await availability.check({ force: true })
      if (state !== DatabaseState.READ_WRITE) throw Object.assign(new Error('database unavailable'), { code: '08006' })
      return start()
    },
    episodeWorkerStopper: stop,
    workerManagerOptions: { retryDelays: [5], jitterRatio: 0,
      setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn }
  })
  await app.ready()
  await app.episodeWorkerManager.ensureStarted()
  await app.episodeRecovery.reconcile()
  return { app, pool, availability }
}

const idleError = () => Object.assign(new Error('connection terminated unexpectedly'), { code: '57P01' })

test('idle pool errors schedule one worker replacement and resume RSS without HTTP after the database returns', async t => {
  const timers = controlledRetryTimers()
  const retiring = Promise.withResolvers()
  let writable = true, probes = 0, starts = 0, rssReads = 0
  const workers = [], stopped = []
  const { app, pool, availability } = await recoveryApp({ timers,
    probe: async () => { probes++; return writable ? DatabaseState.READ_WRITE : DatabaseState.UNAVAILABLE },
    start: () => { starts++; const worker = new EventEmitter(); workers.push(worker); return worker },
    stop: async worker => { stopped.push(worker); if (worker === workers[0]) await retiring.promise },
    fetchEpisodes: async () => { rssReads++; return [] }
  })
  t.after(async () => { retiring.resolve(); await app.close() })
  const readsBeforeError = rssReads
  const probesBeforeError = probes
  writable = false

  pool.emit('error', idleError())
  pool.emit('error', idleError())
  assert.equal(availability.getState(), DatabaseState.UNAVAILABLE)
  assert.equal(app.episodeWorkerManager.getStatus().state, 'retry_scheduled')
  assert.equal(timers.timers.length, 1, 'Repeated pool errors must share the retry loop')
  const retry = timers.timers[0].callback()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(starts, 1, 'The old worker must finish stopping before replacement')
  assert.deepEqual(stopped, [workers[0]])

  writable = true
  retiring.resolve()
  await retry
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(starts, 2)
  assert.equal(probes, probesBeforeError + 1)
  assert.equal(availability.getState(), DatabaseState.READ_WRITE)
  assert.equal(app.episodeWorkerManager.getStatus().state, 'ready')
  assert.equal(rssReads, readsBeforeError + 1, 'onReady must restart reconstruction without an HTTP request')
  assert.equal(timers.timers.length, 1)
})

test('shutdown cancels the retry scheduled by an idle pool error and a late callback cannot restart it', async () => {
  const timers = controlledRetryTimers()
  let starts = 0, stops = 0
  const { app, pool } = await recoveryApp({ timers,
    probe: async () => DatabaseState.READ_WRITE,
    start: () => { starts++; return new EventEmitter() },
    stop: async () => { stops++ }, fetchEpisodes: async () => []
  })
  try {
    pool.emit('error', idleError())
    assert.equal(timers.timers.length, 1)
    await app.close()
    assert.equal(timers.timers[0].cleared, true)
    await timers.timers[0].callback()
    assert.equal(starts, 1)
    assert.equal(stops, 1)
    assert.equal(app.episodeWorkerManager.getStatus().state, 'stopped')
    assert.equal(pool.listenerCount('error'), 0)
  } finally { await app.close() }
})
