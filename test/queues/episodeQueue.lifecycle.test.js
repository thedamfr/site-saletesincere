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

function createFakeBoss({ failAt, sendResult, sendError } = {}) {
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
  candidate.send = async () => {
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
