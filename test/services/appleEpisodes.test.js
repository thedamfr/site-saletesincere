import { beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { searchAppleEpisode } from '../../server/services/platformAPIs.js'

const podcastId = '1846531745'
const episodeUrl = (id) => `https://podcasts.apple.com/fr/podcast/id${podcastId}?i=${id}`
const appleEpisode = (id, guid, releaseDate = '2026-09-04T07:26:49Z') => ({
  wrapperType: 'podcastEpisode', collectionId: Number(podcastId),
  episodeGuid: guid, releaseDate, trackViewUrl: episodeUrl(id)
})
const options = (results, itemGuid) => ({
  podcastId, itemGuid,
  fetchImpl: async () => ({ ok: true, json: async () => ({ results }) })
})

beforeEach((t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ results: [appleEpisode('1001', 'another-episode')] })
  }))
})

describe('Apple episode identity', () => {
  test('uses the RSS GUID when the video date changes or other episodes share its date', async () => {
    const results = [
      appleEpisode('1001', 'another-episode'),
      { ...appleEpisode('1002', 'rss-guid', '2026-09-10T10:00:00Z'), episodeContentType: 'video' }
    ]
    assert.equal(await searchAppleEpisode('2026-09-04', options(results, 'rss-guid')), episodeUrl('1002'))
  })

  test('does not substitute another episode when the requested GUID is absent', async () => {
    assert.equal(await searchAppleEpisode('2026-09-04', options([
      appleEpisode('1001', 'another-episode')
    ], 'rss-guid')), null)
  })

  test('supports old jobs without a GUID only when the publication date is unambiguous', async () => {
    const results = [appleEpisode('1001', 'first')]
    assert.equal(await searchAppleEpisode('2026-09-04', options(results)), episodeUrl('1001'))
    results.push(appleEpisode('1002', 'second'))
    assert.equal(await searchAppleEpisode('2026-09-04', options(results)), null)
  })

  test('rejects foreign links, other shows and malformed responses', async () => {
    for (const badEpisode of [
      { ...appleEpisode('1001', 'rss-guid'), trackViewUrl: 'https://evil.example/?i=1001' },
      { ...appleEpisode('1001', 'rss-guid'), collectionId: 1234 },
      { ...appleEpisode('1001', 'rss-guid'), trackViewUrl: 'https://podcasts.apple.com/fr/podcast/id1234?i=1001' }
    ]) {
      assert.equal(await searchAppleEpisode('2026-09-04', options([badEpisode], 'rss-guid')), null)
    }
    assert.equal(await searchAppleEpisode('2026-09-04', options(null)), null)
  })

  test('bounds the public lookup and returns null on network failures', async () => {
    let signal
    assert.equal(await searchAppleEpisode('2026-09-04', {
      podcastId,
      fetchImpl: async (url, request) => {
        assert.equal(new URL(url).hostname, 'itunes.apple.com')
        signal = request.signal
        throw new Error('unavailable')
      }
    }), null)
    assert.ok(signal instanceof AbortSignal)
  })
})
