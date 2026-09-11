import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createEpisodeIntentBuffer } from '../../server/queues/episodeIntentBuffer.js'

function episodePayload(overrides = {}) {
  return {
    season: 2,
    episode: 1,
    episodeDate: '2025-10-27',
    title: 'Un épisode sincère',
    imageUrl: 'https://media.example/cover.jpg',
    feedLastBuildDate: '2026-08-19T12:00:00.000Z',
    audioUrl: 'https://media.example/episode.mp3',
    ...overrides
  }
}

describe('episode intent buffer', () => {
  test('deduplicates concurrent visits and keeps the latest RSS payload', () => {
    const buffer = createEpisodeIntentBuffer()

    for (let visit = 0; visit < 20; visit += 1) {
      buffer.remember(episodePayload({ title: `Version ${visit}` }))
    }

    assert.equal(buffer.size(), 1)
    assert.equal(buffer.entries()[0].payload.title, 'Version 19')
    assert.equal(buffer.entries()[0].key, 'episode-2-1')
  })

  test('keeps the buffer bounded by evicting the oldest intent', () => {
    let currentTime = 0
    const buffer = createEpisodeIntentBuffer({
      maxSize: 2,
      now: () => currentTime
    })

    buffer.remember(episodePayload({ episode: 1 }))
    currentTime += 1
    buffer.remember(episodePayload({ episode: 2 }))
    currentTime += 1
    buffer.remember(episodePayload({ episode: 3 }))

    assert.deepEqual(
      buffer.entries().map(({ key }) => key),
      ['episode-2-2', 'episode-2-3']
    )
  })

  test('expires stale intents and rejects arbitrary payloads', () => {
    let currentTime = 0
    const buffer = createEpisodeIntentBuffer({
      ttlMs: 1000,
      now: () => currentTime
    })

    assert.equal(buffer.remember(episodePayload()).remembered, true)
    assert.equal(buffer.remember({ season: 2, episode: 99 }).remembered, false)
    assert.equal(buffer.remember(episodePayload({ itemGuid: 'x'.repeat(2049) })).remembered, false)
    currentTime = 1000

    assert.equal(buffer.size(), 0)
  })

  test('drains confirmed jobs, keeps failures and continues after one error', async () => {
    const buffer = createEpisodeIntentBuffer()
    buffer.remember(episodePayload({ episode: 1 }))
    buffer.remember(episodePayload({ episode: 2 }))
    buffer.remember(episodePayload({ episode: 3 }))

    const result = await buffer.drain(async (payload) => {
      if (payload.episode === 1) return { queued: true, reason: 'QUEUED' }
      if (payload.episode === 2) throw new Error('isolated queue failure')
      return { queued: false, reason: 'ALREADY_QUEUED' }
    })

    assert.deepEqual(result, {
      drained: 2,
      failed: 1,
      expired: 0,
      pending: 1
    })
    assert.equal(buffer.entries()[0].key, 'episode-2-2')
  })
})
