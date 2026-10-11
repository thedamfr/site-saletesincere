import { EventEmitter } from 'node:events'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getBoss,
  initializeEpisodeWorker,
  isEpisodeCacheComplete,
  queueEpisodeResolution,
  setEpisodeQueueShuttingDown,
  stopQueue
} from '../../server/queues/episodeQueue.js'
import { getOGImageS3Key } from '../../server/services/ogImageLayout.js'

function createFakeBoss({ failAt, sendResult, sendError, duplicateRows = [{ id: 'existing-job' }] } = {}) {
  const candidate = new EventEmitter()
  candidate.calls = []
  candidate.stopCalls = 0
  candidate.start = async () => {
    candidate.calls.push('start')
    if (failAt === 'start') throw new Error('start failed')
  }
  candidate.createQueue = async (name) => {
    candidate.calls.push(`createQueue:${name}`)
    if (failAt === 'createQueue') throw new Error('create queue failed')
  }
  candidate.updateQueue = async () => {}
  candidate.getDb = () => ({ executeSql: async sql => ({ rows: sql.includes('SELECT id') ? duplicateRows : [] }) })
  candidate.work = async (name, options, handler) => {
    candidate.calls.push(`work:${name}`)
    candidate.workerOptions = options
    candidate.handlers ||= new Map()
    candidate.handlers.set(name, handler)
    if (name === 'resolve-episode') candidate.handler = handler
    candidate.publishedDuringWork = getBoss()
    if (failAt === 'work') throw new Error('worker registration failed')
  }
  candidate.schedule = async (name) => {
    candidate.calls.push(`schedule:${name}`)
  }
  candidate.send = async (...args) => {
    candidate.sent = args
    if (sendError) throw sendError
    return sendResult === undefined
      ? '00000000-0000-0000-0000-000000000001'
      : sendResult
  }
  candidate.stop = async () => {
    candidate.stopCalls += 1
  }
  return candidate
}

afterEach(async () => {
  setEpisodeQueueShuttingDown(false)
  await stopQueue()
})

describe('episodeQueue lifecycle', () => {
  for (const phase of ['read', 'write']) {
    test(`discards a client after a failed cache ${phase} so the next attempt can recover`, async (t) => {
      t.mock.method(globalThis, 'fetch', async () => ({ ok: false }))
      const candidate = createFakeBoss()
      const failure = Object.assign(new Error('Query read timeout'), { code: 'ETIMEDOUT' })
      const released = []
      let mustFail = true
      let writes = 0
      const fastify = { pg: { connect: async () => ({
        query: async sql => {
          const isWrite = sql.includes('INSERT INTO episode_links')
          if (mustFail && (phase === 'write') === isWrite) {
            mustFail = false
            throw failure
          }
          if (isWrite) writes += 1
          return { rows: [] }
        },
        release: error => released.push(error)
      }) } }
      await initializeEpisodeWorker(fastify, {
        queueOptions: { bossFactory: () => candidate }, workerOptions: { storageEnabled: false }
      })
      const jobs = [{ id: 'interrupted-sql', data: {
        season: 1, episode: 1, episodeDate: '2026-10-11', title: 'Interrupted SQL'
      } }]

      await assert.rejects(candidate.handler(jobs), error => error === failure)
      assert.equal(writes, 0)
      assert.equal(released.at(-1), failure, 'The failed client must be removed from the pool')

      await candidate.handler(jobs)
      assert.equal(writes, 1)
      assert.equal(released.at(-1), undefined, 'The healthy replacement returns to the pool')
    })
  }

  test('closes the pg-boss pool even when start fails before stop becomes active', async () => {
    const candidate = createFakeBoss({ failAt: 'start' })
    let closes = 0
    const database = { _pgbdb: true, opened: true, close: async () => { closes += 1; database.opened = false } }
    candidate.getDb = () => database
    await assert.rejects(initializeEpisodeWorker({ pg: {} }, {
      queueOptions: { bossFactory: () => candidate }
    }), /start failed/)
    assert.equal(closes, 1)
  })

  test('retries a provider outage instead of recording a completed partial cache', async (t) => {
    const previous = process.env.DEEZER_SHOW_ID
    process.env.DEEZER_SHOW_ID = 'qualification-show'
    t.after(() => {
      if (previous === undefined) delete process.env.DEEZER_SHOW_ID
      else process.env.DEEZER_SHOW_ID = previous
    })
    t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }))
    const candidate = createFakeBoss()
    let writes = 0
    await initializeEpisodeWorker({ pg: { connect: async () => ({
      query: async sql => { if (sql.includes('INSERT')) writes += 1; return { rows: [] } }, release() {}
    }) } }, { queueOptions: { bossFactory: () => candidate }, workerOptions: { storageEnabled: false } })
    await assert.rejects(candidate.handler([{ id: 'outage-job', data: {
      season: 2, episode: 1, episodeDate: '2026-10-11', title: 'Outage'
    } }]), /Deezer request failed/)
    assert.equal(writes, 0)
  })

  test('does not acknowledge a throttled job without a durable unfinished job', async () => {
    const candidate = createFakeBoss({ sendResult: null, duplicateRows: [] })
    await initializeEpisodeWorker({ pg: {} }, { queueOptions: { bossFactory: () => candidate } })
    const result = await queueEpisodeResolution(2, 1, '2026-10-11', 'Episode', null)
    assert.equal(result.reason, 'THROTTLED')
  })

  test('fails the accepted job when the result cannot be persisted', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => ({ ok: false }))
    const candidate = createFakeBoss()
    const failure = Object.assign(new Error('connection lost before commit'), { code: 'ECONNRESET' })
    const fastify = { pg: { connect: async () => ({
      query: async sql => {
        if (sql.includes('INSERT INTO episode_links')) throw failure
        return { rows: [] }
      }, release() {}
    }) } }
    await initializeEpisodeWorker(fastify, {
      queueOptions: { bossFactory: () => candidate }, workerOptions: { storageEnabled: false }
    })
    await assert.rejects(candidate.handler([{ id: 'job', data: {
      season: 1, episode: 1, episodeDate: '2026-10-11', title: 'Interrupted'
    } }]), error => error === failure)
  })

  test('preserves the RSS GUID from enqueue to the Apple link saved by the worker', async (t) => {
    const previousPodcastId = process.env.APPLE_PODCAST_ID
    process.env.APPLE_PODCAST_ID = '1846531745'
    t.after(() => {
      if (previousPodcastId === undefined) delete process.env.APPLE_PODCAST_ID
      else process.env.APPLE_PODCAST_ID = previousPodcastId
    })
    const appleUrl = 'https://podcasts.apple.com/fr/podcast/id1846531745?i=1000787798745'
    t.mock.method(globalThis, 'fetch', async (url) => String(url).startsWith('https://itunes.apple.com/')
      ? { ok: true, json: async () => ({ results: [{
        wrapperType: 'podcastEpisode', collectionId: 1846531745,
        episodeGuid: 'rss-guid-s3e2', releaseDate: '2026-09-10T10:00:00Z',
        trackViewUrl: appleUrl, episodeContentType: 'video'
      }] }) }
      : { ok: false })
    const queries = []
    const candidate = createFakeBoss()
    const fastify = { pg: { connect: async () => ({
      query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] } },
      release() {}
    }) } }
    await initializeEpisodeWorker(fastify, {
      queueOptions: { bossFactory: () => candidate },
      workerOptions: { storageEnabled: false }
    })

    await queueEpisodeResolution(3, 2, '2026-09-04', 'Episode vidéo', null, null, null, 'rss-guid-s3e2')
    const output = await candidate.handler([{ id: 'apple-video-job', data: candidate.sent[1] }])

    assert.equal(output.links.apple, appleUrl)
    const saved = queries.find(({ sql }) => sql.includes('INSERT INTO episode_links'))
    assert.deepEqual(saved.params.slice(0, 2), [3, 2])
    assert.equal(saved.params[4], appleUrl)
  })

  test('requires a YouTube link only when YouTube resolution is enabled', () => {
    const expectedOgImageS3Key = getOGImageS3Key({
      season: 3,
      episode: 1,
      imageUrl: 'https://example.com/cover.jpg',
      feedLastBuildDate: '2026-09-04T08:00:00.000Z'
    })
    const cached = {
      spotify_url: 'https://open.spotify.com/episode/direct',
      apple_url: 'https://podcasts.apple.com/episode/direct',
      deezer_url: 'https://deezer.com/episode/direct',
      spotify_video_available: true,
      youtube_url: null,
      og_image_url: `https://media.example/${expectedOgImageS3Key}`,
      feed_last_build: '2026-09-04T08:00:00.000Z',
      generated_at: '2026-09-04T09:00:00.000Z'
    }
    const options = {
      expectedOgImageS3Key,
      feedLastBuildDate: '2026-09-04T08:00:00.000Z',
      now: new Date('2026-09-04T10:00:00.000Z').getTime()
    }

    assert.equal(isEpisodeCacheComplete(cached, options), true)
    assert.equal(isEpisodeCacheComplete({
      ...cached,
      spotify_video_available: null
    }, options), false)
    assert.equal(isEpisodeCacheComplete(cached, {
      ...options,
      youtubeResolutionEnabled: true
    }), false)
    assert.equal(isEpisodeCacheComplete({
      ...cached,
      youtube_url: 'https://www.youtube.com/watch?v=Bbbbbbbbb-1',
      youtube_thumbnail_checked: true
    }, {
      ...options,
      youtubeResolutionEnabled: true
    }), true)

    assert.equal(isEpisodeCacheComplete({
      ...cached,
      og_image_url: null,
      generated_at: null
    }, {
      ...options,
      storageEnabled: false
    }), true)
  })

  test('returns an explicit contract when the worker is unavailable', async () => {
    const result = await queueEpisodeResolution(
      2,
      1,
      '2025-10-27',
      'Test episode',
      'https://example.com/cover.jpg'
    )

    assert.deepEqual(result, {
      queued: false,
      reason: 'WORKER_UNAVAILABLE'
    })
  })

  test('does not publish a partially initialized pg-boss instance', async () => {
    const candidate = createFakeBoss({ failAt: 'work' })

    await assert.rejects(
      initializeEpisodeWorker(
        { pg: {} },
        { queueOptions: { bossFactory: () => candidate } }
      ),
      /worker registration failed/
    )

    assert.equal(candidate.publishedDuringWork, null)
    assert.equal(getBoss(), null)
    assert.equal(candidate.stopCalls, 1)
    assert.deepEqual(candidate.calls, [
      'start',
      'createQueue:resolve-episode',
      'work:resolve-episode'
    ])
  })

  test('publishes only the fully initialized instance and can enqueue', async () => {
    const candidate = createFakeBoss()

    const initialized = await initializeEpisodeWorker(
      { pg: {} },
      {
        queueOptions: { bossFactory: () => candidate },
        workerOptions: { teamSize: 2 }
      }
    )

    assert.equal(candidate.publishedDuringWork, null)
    assert.equal(initialized, candidate)
    assert.equal(getBoss(), candidate)
    assert.equal(candidate.workerOptions.teamSize, 2)

    const queueResult = await queueEpisodeResolution(
      2,
      1,
      '2025-10-27',
      'Test episode',
      'https://example.com/cover.jpg'
    )

    assert.deepEqual(queueResult, {
      queued: true,
      reason: 'QUEUED',
      jobId: '00000000-0000-0000-0000-000000000001'
    })
  })

  test('registers OP3 on the same candidate before publishing the singleton', async () => {
    const candidate = createFakeBoss()
    let factoryCalls = 0
    const fastify = {
      pg: { pool: {} },
      databaseAvailability: { getState: () => 'read_write' }
    }

    const initialized = await initializeEpisodeWorker(fastify, {
      queueOptions: {
        bossFactory: () => {
          factoryCalls += 1
          return candidate
        }
      },
      op3Options: {
        env: { OP3_API_TOKEN: 'test-token', OP3_GUID: 'test-guid' },
        refresh: async () => ({ status: 'updated', updatedCount: 1 })
      }
    })

    assert.equal(initialized, candidate)
    assert.equal(factoryCalls, 1)
    assert.equal(candidate.publishedDuringWork, null)
    assert.ok(candidate.calls.includes('createQueue:op3-stats-refresh'))
    assert.ok(candidate.calls.includes('work:op3-stats-refresh'))
    assert.ok(candidate.calls.includes('schedule:op3-stats-refresh'))
    assert.equal(getBoss(), candidate)
  })

  test('distinguishes throttling, queue errors and shutdown', async () => {
    const throttledBoss = createFakeBoss({ sendResult: null })
    await initializeEpisodeWorker(
      { pg: {} },
      { queueOptions: { bossFactory: () => throttledBoss } }
    )

    assert.deepEqual(
      await queueEpisodeResolution(2, 1, '2025-10-27', 'Episode', null),
      { queued: false, reason: 'ALREADY_QUEUED' }
    )

    const queueError = Object.assign(new Error('database unavailable'), {
      code: 'ECONNRESET'
    })
    throttledBoss.send = async () => {
      throw queueError
    }
    const queueErrorResult = await queueEpisodeResolution(
      2,
      1,
      '2025-10-27',
      'Episode',
      null
    )
    assert.equal(queueErrorResult.queued, false)
    assert.equal(queueErrorResult.reason, 'QUEUE_ERROR')
    assert.equal(queueErrorResult.error, queueError)

    setEpisodeQueueShuttingDown(true)
    assert.deepEqual(
      await queueEpisodeResolution(2, 1, '2025-10-27', 'Episode', null),
      { queued: false, reason: 'SHUTTING_DOWN' }
    )
  })

  test('skips costly enrichment when the current episode cache is already complete', async () => {
    const candidate = createFakeBoss()
    const expectedOgImageS3Key = getOGImageS3Key({
      season: 2,
      episode: 1,
      imageUrl: 'https://example.com/cover.jpg',
      feedLastBuildDate: '2026-08-19T12:00:00.000Z'
    })
    let releaseCalls = 0
    const queries = []
    const fastify = {
      pg: {
        async connect() {
          return {
            async query(sql, params) {
              queries.push({ sql, params })
              return {
                rows: [{
                  spotify_url: 'https://open.spotify.com/episode/direct',
                  apple_url: 'https://podcasts.apple.com/episode/direct',
                  deezer_url: 'https://deezer.com/episode/direct',
                  spotify_video_available: false,
                  og_image_url: `https://media.example/${expectedOgImageS3Key}`,
                  feed_last_build: '2026-08-19T12:00:00.000Z',
                  generated_at: new Date().toISOString()
                }]
              }
            },
            release() {
              releaseCalls += 1
            }
          }
        }
      }
    }

    await initializeEpisodeWorker(
      fastify,
      { queueOptions: { bossFactory: () => candidate } }
    )

    const output = await candidate.handler([{
      id: 'job-id',
      data: {
        season: 2,
        episode: 1,
        episodeDate: '2025-10-27',
        title: 'Episode',
        imageUrl: 'https://example.com/cover.jpg',
        feedLastBuildDate: '2026-08-19T12:00:00.000Z',
        audioUrl: 'https://example.com/audio.mp3'
      }
    }])

    assert.deepEqual(output, { skipped: true, reason: 'CACHE_COMPLETE' })
    assert.equal(queries.length, 1)
    assert.deepEqual(queries[0].params, [2, 1])
    assert.equal(releaseCalls, 1)
  })
})
