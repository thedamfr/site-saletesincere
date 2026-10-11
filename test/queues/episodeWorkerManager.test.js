import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createEpisodeWorkerManager,
  classifyDatabaseError,
  DatabaseState,
  EpisodeWorkerState
} from '../../server/queues/episodeWorkerManager.js'
import { createDatabaseAvailability } from '../../server/resilience/databaseAvailability.js'

function createFakeTimers() {
  const scheduled = []

  return {
    scheduled,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cleared: false, executed: false }
      scheduled.push(timer)
      return timer
    },
    clearTimeoutFn(timer) {
      timer.cleared = true
    },
    async runNext() {
      const timer = scheduled.find((item) => !item.cleared && !item.executed)
      assert.ok(timer, 'A retry timer should be scheduled')
      timer.executed = true
      return timer.callback()
    }
  }
}

function createCandidate() {
  const candidate = new EventEmitter()
  candidate.stopCalls = 0
  candidate.stop = async () => {
    candidate.stopCalls += 1
  }
  return candidate
}

describe('episodeWorkerManager', () => {
  test('retries after a runtime failure while the ready hook is still draining', async () => {
    const timers = createFakeTimers()
    const first = createCandidate()
    const second = createCandidate()
    let finishReady
    let starts = 0
    const readyGate = new Promise(resolve => { finishReady = resolve })
    const manager = createEpisodeWorkerManager({
      start: async () => ++starts === 1 ? first : second,
      stop: instance => instance.stop(),
      onReady: instance => instance === first ? readyGate : undefined,
      retryDelays: [5], jitterRatio: 0,
      setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn
    })
    const starting = manager.ensureStarted()
    await new Promise(resolve => setImmediate(resolve))
    first.emit('error', Object.assign(new Error('offline during drain'), { code: 'ECONNRESET' }))
    const retry = timers.runNext()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(starts, 1, 'The ready hook remains part of the single startup')

    finishReady()
    await Promise.all([starting, retry])

    assert.equal(starts, 2, 'The elapsed retry must not be consumed by the old startup')
    assert.equal(first.stopCalls, 1)
    assert.equal(manager.getInstance(), second)
    assert.equal(manager.getStatus().state, EpisodeWorkerState.READY)
    await manager.stop()
    assert.equal(second.stopCalls, 1)
  })

  test('does not restart after shutdown while a retry awaits the ready hook', async () => {
    const timers = createFakeTimers()
    const candidate = createCandidate()
    let finishReady
    let starts = 0
    const readyGate = new Promise(resolve => { finishReady = resolve })
    const manager = createEpisodeWorkerManager({
      start: async () => { starts += 1; return candidate },
      stop: instance => instance.stop(),
      onReady: () => readyGate,
      retryDelays: [5], jitterRatio: 0,
      setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn
    })
    const starting = manager.ensureStarted()
    await new Promise(resolve => setImmediate(resolve))
    candidate.emit('error', Object.assign(new Error('offline during drain'), { code: 'ECONNRESET' }))
    const retry = timers.runNext()
    const closing = manager.stop()
    finishReady()
    await Promise.all([starting, retry, closing])

    assert.equal(starts, 1)
    assert.equal(candidate.stopCalls, 1)
    assert.equal(manager.getInstance(), null)
    assert.equal(manager.getStatus().state, EpisodeWorkerState.STOPPED)
    assert.equal(timers.scheduled.filter(timer => !timer.cleared && !timer.executed).length, 0)
  })

  test('keeps the retiring instance until stop succeeds instead of overlapping workers', async () => {
    const timers = createFakeTimers()
    const candidate = createCandidate()
    let starts = 0
    let stops = 0
    const manager = createEpisodeWorkerManager({
      start: async () => { starts += 1; return candidate },
      stop: async () => { if (++stops < 3) throw new Error('stop unavailable') },
      retryDelays: [5], jitterRatio: 0,
      setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn
    })
    await manager.ensureStarted()
    candidate.emit('error', Object.assign(new Error('offline'), { code: 'ECONNRESET' }))
    await new Promise(resolve => setImmediate(resolve))
    await timers.runNext()
    assert.equal(starts, 1)
    await timers.runNext()
    assert.equal(starts, 2)
    await manager.stop()
  })

  test('rejects shutdown after its budget when startup never settles', async () => {
    const manager = createEpisodeWorkerManager({
      start: () => new Promise(() => {}), stop: async () => {}, shutdownTimeoutMs: 10
    })
    void manager.ensureStarted()
    await new Promise(resolve => setImmediate(resolve))
    await assert.rejects(manager.stop(), error => error.code === 'WORKER_SHUTDOWN_TIMEOUT')
    assert.equal(manager.getStatus().state, EpisodeWorkerState.STOPPING)
  })

  test('does not start a replacement until the failed instance has stopped', async () => {
    const timers = createFakeTimers()
    const first = createCandidate()
    const second = createCandidate()
    let finishStop
    let starts = 0
    const stopped = new Promise(resolve => { finishStop = resolve })
    const manager = createEpisodeWorkerManager({
      start: async () => ++starts === 1 ? first : second,
      stop: async instance => { if (instance === first) await stopped },
      retryDelays: [5], jitterRatio: 0,
      setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn
    })
    await manager.ensureStarted()
    first.emit('error', Object.assign(new Error('offline'), { code: 'ECONNRESET' }))
    const retry = timers.runNext()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(starts, 1)
    finishStop()
    await retry
    assert.equal(starts, 2)
    await manager.stop()
  })

  test('waits for a starting candidate to be cleaned before completing shutdown', async () => {
    const candidate = createCandidate()
    let finishStart
    const manager = createEpisodeWorkerManager({
      start: () => new Promise(resolve => { finishStart = resolve }),
      stop: instance => instance.stop()
    })
    const starting = manager.ensureStarted()
    await new Promise(resolve => setImmediate(resolve))
    let stopped = false
    const closing = manager.stop().then(() => { stopped = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(stopped, false)
    finishStart(candidate)
    await Promise.all([starting, closing])
    assert.equal(candidate.stopCalls, 1)
    assert.equal(manager.getStatus().state, EpisodeWorkerState.STOPPED)
  })

  test('shares a single startup promise across concurrent calls', async () => {
    const candidate = createCandidate()
    let resolveStart
    let startCalls = 0
    const startGate = new Promise((resolve) => {
      resolveStart = resolve
    })
    const manager = createEpisodeWorkerManager({
      start: () => {
        startCalls += 1
        return startGate
      },
      stop: (instance) => instance.stop(),
      jitterRatio: 0
    })

    const attempts = Array.from({ length: 20 }, () => manager.ensureStarted())

    assert.equal(startCalls, 0, 'Startup is deferred to a microtask')
    assert.ok(attempts.every((attempt) => attempt === attempts[0]))

    resolveStart(candidate)
    const instances = await Promise.all(attempts)

    assert.equal(startCalls, 1)
    assert.ok(instances.every((instance) => instance === candidate))
    assert.equal(manager.getStatus().state, EpisodeWorkerState.READY)
    assert.equal(manager.getDatabaseState(), DatabaseState.READ_WRITE)

    await manager.stop()
    assert.equal(candidate.stopCalls, 1)
  })

  test('retries with a fresh startup and recovers without a process restart', async () => {
    const timers = createFakeTimers()
    const candidate = createCandidate()
    let startCalls = 0
    const manager = createEpisodeWorkerManager({
      start: async () => {
        startCalls += 1
        if (startCalls === 1) {
          const error = new Error('connection refused')
          error.code = 'ECONNREFUSED'
          throw error
        }
        return candidate
      },
      stop: (instance) => instance.stop(),
      retryDelays: [5000, 15000],
      jitterRatio: 0,
      now: () => 1000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn
    })

    assert.equal(await manager.ensureStarted(), null)
    assert.equal(manager.getInstance(), null)
    assert.equal(manager.getStatus().state, EpisodeWorkerState.RETRY_SCHEDULED)
    assert.equal(manager.getStatus().retryAttempt, 1)
    assert.equal(manager.getStatus().nextRetryAt, new Date(6000).toISOString())
    assert.equal(manager.getDatabaseState(), DatabaseState.UNAVAILABLE)
    assert.equal(timers.scheduled.length, 1)

    await Promise.all(Array.from({ length: 20 }, () => manager.ensureStarted()))
    assert.equal(startCalls, 1)
    assert.equal(timers.scheduled.length, 1)

    await timers.runNext()

    assert.equal(startCalls, 2)
    assert.equal(manager.getInstance(), candidate)
    assert.equal(manager.getStatus().state, EpisodeWorkerState.READY)
    assert.equal(manager.getStatus().retryAttempt, 0)
    assert.equal(manager.getDatabaseState(), DatabaseState.READ_WRITE)

    await manager.stop()
  })

  test('moves out of READY and schedules one retry after a runtime error', async () => {
    const timers = createFakeTimers()
    const candidate = createCandidate()
    const manager = createEpisodeWorkerManager({
      start: async () => candidate,
      stop: (instance) => instance.stop(),
      retryDelays: [5000],
      jitterRatio: 0,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn
    })

    await manager.ensureStarted()
    const error = new Error('database system is in recovery mode')
    error.code = '57P03'
    candidate.emit('error', error)

    assert.equal(manager.getInstance(), null)
    assert.equal(manager.getStatus().state, EpisodeWorkerState.RETRY_SCHEDULED)
    assert.equal(manager.getDatabaseState(), DatabaseState.UNAVAILABLE)
    assert.equal(timers.scheduled.length, 1)

    await manager.stop()
    assert.equal(timers.scheduled[0].cleared, true)
  })

  test('cancels a scheduled retry and prevents resurrection during shutdown', async () => {
    const timers = createFakeTimers()
    let startCalls = 0
    const manager = createEpisodeWorkerManager({
      start: async () => {
        startCalls += 1
        throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })
      },
      stop: async () => {},
      retryDelays: [5000],
      jitterRatio: 0,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn
    })

    await manager.ensureStarted()
    await manager.stop()

    assert.equal(timers.scheduled[0].cleared, true)
    assert.equal(manager.getStatus().state, EpisodeWorkerState.STOPPED)
    assert.equal(await manager.ensureStarted(), null)
    assert.equal(startCalls, 1)
  })

  test('classifies read-only and unavailable PostgreSQL failures', () => {
    assert.equal(
      classifyDatabaseError(Object.assign(new Error('read-only transaction'), { code: '25006' })),
      DatabaseState.READ_ONLY
    )
    assert.equal(
      classifyDatabaseError(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })),
      DatabaseState.UNAVAILABLE
    )
  })

  test('invalidates a ready worker when a route reports a database failure', async () => {
    const timers = createFakeTimers()
    const candidate = createCandidate()
    const availability = createDatabaseAvailability({
      probe: async () => DatabaseState.UNKNOWN
    })
    const manager = createEpisodeWorkerManager({
      start: async () => candidate,
      stop: (instance) => instance.stop(),
      databaseAvailability: availability,
      retryDelays: [5000],
      jitterRatio: 0,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn
    })

    await manager.ensureStarted()
    manager.reportDatabaseError(Object.assign(new Error('connection refused'), {
      code: 'ECONNREFUSED'
    }))

    assert.equal(availability.getState(), DatabaseState.UNAVAILABLE)
    assert.equal(manager.getStatus().state, EpisodeWorkerState.RETRY_SCHEDULED)
    assert.equal(manager.getInstance(), null)
    assert.equal(timers.scheduled.length, 1)

    await manager.stop()
  })
})
