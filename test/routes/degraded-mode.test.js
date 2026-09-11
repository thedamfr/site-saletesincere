import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../../server.js'
import { EpisodeWorkerState } from '../../server/queues/episodeWorkerManager.js'

const UNAVAILABLE_DATABASE_URL = 'postgresql://salete:salete@127.0.0.1:1/salete_test'
const RSS_EPISODE = {
  season: 2,
  episode: 1,
  title: 'Un épisode à reprendre',
  description: 'Disponible depuis le RSS.',
  pubDate: '27 octobre 2025',
  rawPubDate: '2025-10-27',
  duration: '42:00',
  image: 'https://media.example/cover.jpg',
  audioUrl: 'https://media.example/episode.mp3',
  episodeLink: 'https://podcasts.example/episode',
  feedLastBuildDate: '2026-08-19T12:00:00.000Z',
  itemGuid: 'rss-guid-s2e1',
  isTruncated: false
}

function createCandidate() {
  const candidate = new EventEmitter()
  candidate.stopCalls = 0
  candidate.stop = async () => {
    candidate.stopCalls += 1
  }
  return candidate
}

async function waitForState(manager, expectedState) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (manager.getStatus().state === expectedState) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(manager.getStatus().state, expectedState)
}

describe('degraded startup', () => {
  test('keeps database-independent routes up when PostgreSQL registration fails', async () => {
    const originalNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    let app

    try {
      app = await buildApp({
        initializeStorage: false,
        databaseAdapterFactory: () => {
          throw Object.assign(new Error('connection refused'), {
            code: 'ECONNREFUSED'
          })
        },
        databaseConfigured: true,
        episodeFetcher: async () => RSS_EPISODE,
        podcastEpisodesFetcher: async () => [RSS_EPISODE]
      })

      const [home, episode, wall] = await Promise.all([
        app.inject({ method: 'GET', url: '/' }),
        app.inject({ method: 'GET', url: '/podcast/2/1' }),
        app.inject({ method: 'GET', url: '/wall' })
      ])
      const health = await app.inject({ method: 'GET', url: '/health' })

      assert.equal(home.statusCode, 200)
      assert.equal(episode.statusCode, 200)
      assert.match(episode.body, /Un épisode à reprendre/)
      assert.equal(wall.statusCode, 200)
      assert.match(wall.body, /Le Sale-wall est temporairement indisponible/)
      assert.deepEqual(health.json(), {
        ok: true,
        mode: 'degraded',
        database: { state: 'unavailable' },
        episodeWorker: { state: 'stopped' },
        episodeIntents: { pending: 1 }
      })
    } finally {
      await app?.close()
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = originalNodeEnv
    }
  })

  test('builds HTTP without awaiting a pending worker connection', async () => {
    const candidate = createCandidate()
    let resolveStart
    const startGate = new Promise((resolve) => {
      resolveStart = resolve
    })

    const app = await buildApp({
      initializeStorage: false,
      databaseUrl: UNAVAILABLE_DATABASE_URL,
      databaseConfigured: true,
      episodeWorkerStarter: () => startGate,
      episodeWorkerStopper: (instance) => instance.stop(),
      podcastEpisodesFetcher: async () => [RSS_EPISODE],
      workerManagerOptions: {
        jitterRatio: 0
      }
    })

    assert.equal(typeof app.pg.connect, 'function')
    assert.equal(typeof app.pg.pool.query, 'function')

    const [home, podcast, health] = await Promise.all([
      app.inject({ method: 'GET', url: '/' }),
      app.inject({ method: 'GET', url: '/podcast' }),
      app.inject({ method: 'GET', url: '/health' })
    ])

    assert.equal(home.statusCode, 200)
    assert.equal(podcast.statusCode, 200)
    assert.equal(health.statusCode, 200)
    assert.deepEqual(health.json(), {
      ok: true,
      mode: 'degraded',
      database: { state: 'unknown' },
      episodeWorker: { state: 'starting' },
      episodeIntents: { pending: 0 }
    })

    await app.close()
    resolveStart(candidate)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(candidate.stopCalls, 1)
  })

  test('reports degradation then returns to normal after the singleton retry', async () => {
    const candidate = createCandidate()
    const scheduled = []
    const queuedIntents = []
    let startCalls = 0
    const app = await buildApp({
      initializeStorage: false,
      databaseUrl: UNAVAILABLE_DATABASE_URL,
      databaseConfigured: true,
      episodeWorkerStarter: async () => {
        startCalls += 1
        if (startCalls === 1) {
          throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })
        }
        return candidate
      },
      episodeWorkerStopper: (instance) => instance.stop(),
      episodeFetcher: async () => RSS_EPISODE,
      episodeQueuer: async (...args) => {
        queuedIntents.push(args)
        return { queued: true, reason: 'QUEUED', jobId: 'job-1' }
      },
      workerManagerOptions: {
        retryDelays: [5000],
        jitterRatio: 0,
        setTimeoutFn(callback, delay) {
          const timer = { callback, delay, cleared: false }
          scheduled.push(timer)
          return timer
        },
        clearTimeoutFn(timer) {
          timer.cleared = true
        }
      }
    })

    await waitForState(app.episodeWorkerManager, EpisodeWorkerState.RETRY_SCHEDULED)

    const episodeResponses = await Promise.all(Array.from({ length: 20 }, () =>
      app.inject({ method: 'GET', url: '/podcast/2/1' })
    ))
    assert.equal(episodeResponses.every((response) => response.statusCode === 200), true)
    assert.equal(app.episodeIntentBuffer.size(), 1)

    const degradedHealth = await app.inject({ method: 'GET', url: '/health' })
    assert.equal(degradedHealth.statusCode, 200)
    assert.deepEqual(degradedHealth.json(), {
      ok: true,
      mode: 'degraded',
      database: { state: 'unavailable' },
      episodeWorker: { state: 'retry_scheduled' },
      episodeIntents: { pending: 1 }
    })
    assert.equal(scheduled.length, 1)
    assert.equal(scheduled[0].delay, 5000)

    await scheduled[0].callback()
    await waitForState(app.episodeWorkerManager, EpisodeWorkerState.READY)

    const normalHealth = await app.inject({ method: 'GET', url: '/health' })
    assert.deepEqual(normalHealth.json(), {
      ok: true,
      mode: 'normal',
      database: { state: 'read_write' },
      episodeWorker: { state: 'ready' },
      episodeIntents: { pending: 0 }
    })
    assert.equal(startCalls, 2)
    assert.equal(queuedIntents.length, 1)
    assert.equal(queuedIntents[0][7], RSS_EPISODE.itemGuid)

    await app.close()
    assert.equal(candidate.stopCalls, 1)
  })
})
