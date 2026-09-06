import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getEpisodeVideoQuality,
  inspectSpotifyEpisodeVideo
} from '../../server/services/podcastVideoAvailability.js'

describe('Spotify episode video availability', () => {
  test('uses the official oEmbed endpoint for a direct Spotify episode URL', async () => {
    let requestedUrl
    const available = await inspectSpotifyEpisodeVideo(
      'https://open.spotify.com/episode/2eJ4o6eRoPl3c04ObJoxj6',
      {
        fetchImpl: async (url) => {
          requestedUrl = url
          return {
            ok: true,
            json: async () => ({
              type: 'video',
              iframe_url: 'https://open.spotify.com/embed/episode/2eJ4o6eRoPl3c04ObJoxj6/video'
            })
          }
        }
      }
    )

    assert.equal(available, true)
    assert.equal(
      requestedUrl.toString(),
      'https://open.spotify.com/oembed?url=https%3A%2F%2Fopen.spotify.com%2Fepisode%2F2eJ4o6eRoPl3c04ObJoxj6'
    )
  })

  test('returns false for a successful audio-only oEmbed response', async () => {
    const available = await inspectSpotifyEpisodeVideo(
      'https://open.spotify.com/episode/2eJ4o6eRoPl3c04ObJoxj6',
      {
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({
            type: 'rich',
            iframe_url: 'https://open.spotify.com/embed/episode/2eJ4o6eRoPl3c04ObJoxj6'
          })
        })
      }
    )

    assert.equal(available, false)
  })

  test('returns null without fetching for non-Spotify and non-episode URLs', async () => {
    let fetchCalls = 0
    const fetchImpl = async () => {
      fetchCalls += 1
    }

    assert.equal(await inspectSpotifyEpisodeVideo('https://example.com/episode/id', { fetchImpl }), null)
    assert.equal(await inspectSpotifyEpisodeVideo('https://open.spotify.com/show/id', { fetchImpl }), null)
    assert.equal(fetchCalls, 0)
  })

  test('returns null when Spotify is unavailable or sends malformed JSON', async () => {
    assert.equal(await inspectSpotifyEpisodeVideo(
      'https://open.spotify.com/episode/2eJ4o6eRoPl3c04ObJoxj6',
      { fetchImpl: async () => ({ ok: false }) }
    ), null)
    assert.equal(await inspectSpotifyEpisodeVideo(
      'https://open.spotify.com/episode/2eJ4o6eRoPl3c04ObJoxj6',
      { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad json') } }) }
    ), null)
  })
})

describe('editorial video quality', () => {
  test('keeps the confirmed platform-specific quality independent from RSS', () => {
    assert.equal(getEpisodeVideoQuality(3, 1, 'spotify'), 'HD')
    assert.equal(getEpisodeVideoQuality(3, 2, 'spotify'), '4K')
    assert.equal(getEpisodeVideoQuality(3, 2, 'youtube'), '4K')
    assert.equal(getEpisodeVideoQuality(3, 1, 'youtube'), null)
  })
})
