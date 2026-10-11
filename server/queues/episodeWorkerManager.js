import {
  classifyDatabaseError,
  DatabaseState
} from '../resilience/databaseAvailability.js'

export { classifyDatabaseError, DatabaseState }

export const EpisodeWorkerState = Object.freeze({
  STOPPED: 'stopped',
  STARTING: 'starting',
  READY: 'ready',
  RETRY_SCHEDULED: 'retry_scheduled',
  STOPPING: 'stopping'
})

const DEFAULT_RETRY_DELAYS = [5000, 15000, 30000, 60000]

function logEvent(logger, level, event, details = {}) {
  const log = logger?.[level]
  if (typeof log !== 'function') return

  log.call(logger, { event, ...details }, event)
}

export function createEpisodeWorkerManager({
  start,
  stop,
  logger,
  databaseAvailability,
  onReady,
  retryDelays = DEFAULT_RETRY_DELAYS,
  jitterRatio = 0.2,
  random = Math.random,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  shutdownTimeoutMs = 12_000
}) {
  if (typeof start !== 'function' || typeof stop !== 'function') {
    throw new TypeError('Episode worker manager requires start and stop functions')
  }

  let state = EpisodeWorkerState.STOPPED
  let databaseState = DatabaseState.UNKNOWN
  let instance = null
  let startPromise = null
  let retryTimer = null
  let retryAttempt = 0
  let nextRetryAt = null
  let shuttingDown = false
  let runtimeErrorHandler = null
  let stoppingPromise = null
  let shutdownPromise = null
  let retiringInstance = null
  const statusListeners = new Set()

  const normalizedDelays = retryDelays.length > 0 ? retryDelays : DEFAULT_RETRY_DELAYS

  function setWorkerState(nextState, reason = 'unknown') {
    if (state === nextState) return
    const previousState = state
    state = nextState
    for (const listener of statusListeners) {
      listener({ previousState, state, reason })
    }
  }

  function setDatabaseState(nextState, reason) {
    databaseState = nextState
    if (typeof databaseAvailability?.setState === 'function') {
      databaseAvailability.setState(nextState, reason)
    }
  }

  function getStatus() {
    return {
      state,
      retryAttempt,
      nextRetryAt
    }
  }

  function getDatabaseState() {
    return typeof databaseAvailability?.getState === 'function'
      ? databaseAvailability.getState()
      : databaseState
  }

  function getInstance() {
    return instance
  }

  function detachRuntimeError(target) {
    if (!target || !runtimeErrorHandler || typeof target.off !== 'function') return
    target.off('error', runtimeErrorHandler)
    runtimeErrorHandler = null
  }

  async function stopInstance(target, options = { graceful: false }) {
    if (!target) return

    detachRuntimeError(target)

    const stopErrorHandler = (error) => {
      logEvent(logger, 'warn', 'episode_worker_stop_error', {
        errorCode: error?.code || error?.name || 'UNKNOWN'
      })
    }

    if (typeof target.on === 'function') {
      target.on('error', stopErrorHandler)
    }

    try {
      await stop(target, options)
    } catch (error) {
      stopErrorHandler(error)
      throw error
    } finally {
      if (typeof target.off === 'function') {
        target.off('error', stopErrorHandler)
      }
    }
  }

  function scheduleRetry(error) {
    if (shuttingDown || retryTimer) return

    const baseDelay = normalizedDelays[Math.min(retryAttempt, normalizedDelays.length - 1)]
    const jitter = 1 + ((random() * 2 - 1) * jitterRatio)
    const delay = Math.max(0, Math.round(baseDelay * jitter))

    retryAttempt += 1
    nextRetryAt = new Date(now() + delay).toISOString()
    setWorkerState(EpisodeWorkerState.RETRY_SCHEDULED, 'retry_scheduled')

    retryTimer = setTimeoutFn(async () => {
      retryTimer = null
      nextRetryAt = null
      // A runtime failure can happen while onReady still drains intentions.
      // Let that startup release its single-flight guard before retrying.
      if (startPromise) await startPromise
      return ensureStarted()
    }, delay)

    logEvent(logger, 'warn', 'episode_worker_retry_scheduled', {
      attempt: retryAttempt,
      delayMs: delay,
      databaseState: getDatabaseState(),
      errorCode: error?.code || error?.name || 'UNKNOWN'
    })
  }

  function handleRuntimeError(error, target) {
    if (shuttingDown || target !== instance) return

    instance = null
    const classifiedState = classifyDatabaseError(error)
    if (classifiedState !== DatabaseState.UNKNOWN) {
      setDatabaseState(classifiedState, 'worker_runtime_error')
    }
    setWorkerState(EpisodeWorkerState.STOPPED, 'runtime_error')

    logEvent(logger, 'error', 'episode_worker_runtime_error', {
      databaseState: getDatabaseState(),
      errorCode: error?.code || error?.name || 'UNKNOWN'
    })

    retiringInstance = target
    stoppingPromise = stopInstance(target)
      .then(() => { retiringInstance = null })
      .catch(() => { /* Retain the instance so the next attempt retries cleanup. */ })
      .finally(() => { stoppingPromise = null })
    scheduleRetry(error)
  }

  function attachRuntimeError(target) {
    if (typeof target?.on !== 'function') return

    runtimeErrorHandler = (error) => handleRuntimeError(error, target)
    target.on('error', runtimeErrorHandler)
  }

  function ensureStarted() {
    if (shuttingDown) return Promise.resolve(null)
    if (state === EpisodeWorkerState.READY && instance) return Promise.resolve(instance)
    if (startPromise) return startPromise
    if (retryTimer) return Promise.resolve(null)

    setWorkerState(EpisodeWorkerState.STARTING, 'startup')
    logEvent(logger, 'info', 'episode_worker_starting', {
      attempt: retryAttempt + 1
    })

    const promise = Promise.resolve().then(async () => {
      try {
        // An old worker must release its jobs/connections before replacement.
        if (stoppingPromise) await stoppingPromise
        if (retiringInstance) {
          await stopInstance(retiringInstance)
          retiringInstance = null
        }
        if (shuttingDown) return null
        const candidate = await start()

        if (!candidate) {
          throw new Error('Episode worker starter returned no instance')
        }

        if (shuttingDown) {
          await stopInstance(candidate)
          return null
        }

        instance = candidate
        attachRuntimeError(candidate)
        setDatabaseState(DatabaseState.READ_WRITE, 'worker_ready')
        setWorkerState(EpisodeWorkerState.READY, 'startup_succeeded')
        retryAttempt = 0
        nextRetryAt = null

        logEvent(logger, 'info', 'episode_worker_ready', {
          databaseState: getDatabaseState()
        })

        if (typeof onReady === 'function') {
          try {
            await onReady(candidate)
          } catch (error) {
            logEvent(logger, 'warn', 'episode_worker_ready_hook_failed', {
              errorCode: error?.code || error?.name || 'UNKNOWN'
            })
          }
        }

        return candidate
      } catch (error) {
        if (!shuttingDown) {
          const classifiedState = classifyDatabaseError(error)
          if (classifiedState !== DatabaseState.UNKNOWN) {
            setDatabaseState(classifiedState, 'worker_start_failed')
          }
          logEvent(logger, 'error', 'episode_worker_start_failed', {
            databaseState: getDatabaseState(),
            errorCode: error?.code || error?.name || 'UNKNOWN'
          })
          scheduleRetry(error)
        }

        return null
      } finally {
        if (startPromise === promise) {
          startPromise = null
        }
      }
    })

    startPromise = promise
    return promise
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise
    shuttingDown = true
    setWorkerState(EpisodeWorkerState.STOPPING, 'shutdown')

    if (retryTimer) {
      clearTimeoutFn(retryTimer)
      retryTimer = null
      nextRetryAt = null
    }

    const activeInstance = instance
    instance = null
    const cleanup = (async () => {
      if (stoppingPromise) await stoppingPromise
      if (retiringInstance) {
        await stopInstance(retiringInstance)
        retiringInstance = null
      }
      await stopInstance(activeInstance, { graceful: true })
      // A bounded PostgreSQL connection attempt may finish during shutdown.
      // ensureStarted owns cleanup of that unpublished candidate.
      if (startPromise) await startPromise
      setWorkerState(EpisodeWorkerState.STOPPED, 'shutdown_complete')
      logEvent(logger, 'info', 'episode_worker_stopped')
    })()
    let deadline
    const timeout = new Promise((_resolve, reject) => {
      deadline = setTimeout(() => reject(Object.assign(
        new Error('Worker shutdown exceeded its budget'), { code: 'WORKER_SHUTDOWN_TIMEOUT' }
      )), shutdownTimeoutMs)
    })
    shutdownPromise = Promise.race([cleanup, timeout]).finally(() => clearTimeout(deadline))
    return shutdownPromise
  }

  return {
    ensureStarted,
    stop: shutdown,
    getStatus,
    getDatabaseState,
    getInstance,
    reportDatabaseError(error) {
      if (classifyDatabaseError(error) === DatabaseState.UNKNOWN) return false
      if (instance) {
        handleRuntimeError(error, instance)
      } else {
        setDatabaseState(classifyDatabaseError(error), 'route_error')
        scheduleRetry(error)
      }
      return true
    },
    subscribe(listener) {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    }
  }
}
