/**
 * Tests pour platformAPIs.js - Services de résolution des deeplinks
 * 
 * Phase 1 TDD - Liste des tests à implémenter :
 * 
 * getSpotifyToken()
 * ✅ 1. Should authenticate with Spotify and return access token
 * ✅ 2. Should throw error if credentials missing
 * 
 * searchSpotifyEpisode(episodeDate)
 * ✅ 3. Should find episode by date and return deeplink
 * ✅ 4. Should return null if episode not found
 * 
 * searchAppleEpisode(episodeDate)
 * ✅ 5. Should find episode by date and return deeplink
 * ✅ 6. Should return null if episode not found
 * 
 * searchDeezerEpisode(episodeDate)
 * ✅ 7. Should find episode by date and return deeplink
 * ✅ 8. Should return null if episode not found
 * 
 * buildPodcastAddictLink(audioUrl)
 * ✅ 9. Should encode audioUrl and build deeplink
 * ✅ 10. Should throw error if audioUrl missing
 * 
 * buildFallbackLinks()
 * ✅ 11. Should return fallback URLs for all platforms
 */

import 'dotenv/config'
import { describe, test } from 'node:test'
import assert from 'node:assert'
import {
  getSpotifyToken,
  searchSpotifyEpisode,
  searchAppleEpisode,
  searchDeezerEpisode,
  searchYouTubeEpisode,
  searchYouTubeEpisodeMedia,
  isYouTubeEpisodeResolutionConfigured,
  buildPodcastAddictLink,
  buildFallbackLinks
} from '../../server/services/platformAPIs.js'

const runExternalTests = process.env.RUN_EXTERNAL_INTEGRATION_TESTS === 'true'
const hasSpotifyCredentials = Boolean(
  process.env.SPOTIFY_CLIENT_ID
  && process.env.SPOTIFY_CLIENT_SECRET
  && process.env.SPOTIFY_SHOW_ID
)
const skipExternal = { skip: !runExternalTests }
const skipSpotify = { skip: !runExternalTests || !hasSpotifyCredentials }

describe('platformAPIs', () => {
  describe('getSpotifyToken', () => {
    test('should authenticate with Spotify and return access token', skipSpotify, async () => {
      const token = await getSpotifyToken()
      
      assert.ok(token, 'Token should be defined')
      assert.strictEqual(typeof token, 'string')
      assert.ok(token.length > 0, 'Token should not be empty')
    })

    test('should return a valid token that works with Spotify API', skipSpotify, async () => {
      const token = await getSpotifyToken()
      
      // Teste que le token fonctionne en appelant l'API shows
      const response = await fetch(`https://api.spotify.com/v1/shows/${process.env.SPOTIFY_SHOW_ID}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      
      assert.strictEqual(response.ok, true, 'Token should work with Spotify API')
    })
    
    test('should throw error if credentials missing', async () => {
      const originalClientId = process.env.SPOTIFY_CLIENT_ID
      const originalClientSecret = process.env.SPOTIFY_CLIENT_SECRET
      
      delete process.env.SPOTIFY_CLIENT_ID
      delete process.env.SPOTIFY_CLIENT_SECRET
      
      await assert.rejects(
        async () => await getSpotifyToken(),
        /Missing Spotify credentials/
      )
      
      if (originalClientId === undefined) delete process.env.SPOTIFY_CLIENT_ID
      else process.env.SPOTIFY_CLIENT_ID = originalClientId
      if (originalClientSecret === undefined) delete process.env.SPOTIFY_CLIENT_SECRET
      else process.env.SPOTIFY_CLIENT_SECRET = originalClientSecret
    })
  })
  
  describe('searchSpotifyEpisode', () => {
    test('should find episode by date and return deeplink', skipSpotify, async () => {
      const episodeDate = '2025-10-27'
      
      const deeplink = await searchSpotifyEpisode(episodeDate)
      
      assert.ok(deeplink, 'Deeplink should be defined')
      assert.ok(deeplink.includes('https://open.spotify.com/episode/'))
      assert.ok(deeplink.includes('4uuRA1SjUKWPI3G0NmpCQx')) // ID épisode S2E1
    })

    test('should find different episode for different date', skipSpotify, async () => {
      const episodeDate = '2025-10-17' // Bande-Annonce Saison Pilote
      
      const deeplink = await searchSpotifyEpisode(episodeDate)
      
      assert.ok(deeplink, 'Deeplink should be defined')
      assert.ok(deeplink.includes('https://open.spotify.com/episode/'))
      assert.ok(deeplink.includes('1vUiAyqm9uaNYOFS1CKkcH'), 'Should be bande-annonce ID')
      assert.ok(!deeplink.includes('4uuRA1SjUKWPI3G0NmpCQx'), 'Should NOT be S2E1 ID')
    })

    test('should find third different episode', skipSpotify, async () => {
      const episodeDate = '2025-10-15' // BOUCLIER 🛡️
      
      const deeplink = await searchSpotifyEpisode(episodeDate)
      
      assert.ok(deeplink, 'Deeplink should be defined')
      assert.ok(deeplink.includes('https://open.spotify.com/episode/'))
      assert.ok(deeplink.includes('55hcQ7NGJfzfo8sMCXBsrx'), 'Should be BOUCLIER ID')
    })
    
    test('should return null if episode not found', skipSpotify, async () => {
      const episodeDate = '2099-12-31' // Date future
      
      const deeplink = await searchSpotifyEpisode(episodeDate)
      
      assert.strictEqual(deeplink, null)
    })
  })
  
  describe('searchAppleEpisode', () => {
    test('should find episode by date and return deeplink', skipExternal, async () => {
      const episodeDate = '2025-10-27'
      
      const deeplink = await searchAppleEpisode(episodeDate)
      
      assert.ok(deeplink, 'Deeplink should be defined')
      assert.ok(deeplink.includes('https://podcasts.apple.com/'))
      assert.ok(deeplink.includes('id1846531745'))
      assert.ok(deeplink.includes('i=1000733777469')) // trackId S2E1
    })

    test('should find different episode for different date', skipExternal, async () => {
      const episodeDate = '2025-10-17' // Bande-annonce
      
      const deeplink = await searchAppleEpisode(episodeDate)
      
      assert.ok(deeplink, 'Deeplink should be defined')
      assert.ok(deeplink.includes('https://podcasts.apple.com/'))
      assert.ok(!deeplink.includes('i=1000733777469'), 'Should NOT be S2E1 trackId')
    })
    
    test('should return null if episode not found', skipExternal, async () => {
      const episodeDate = '2099-12-31'
      
      const deeplink = await searchAppleEpisode(episodeDate)
      
      assert.strictEqual(deeplink, null)
    })
  })
  
  describe('searchDeezerEpisode', () => {
    test('should find episode by date and return deeplink', skipExternal, async () => {
      const episodeDate = '2025-10-27'
      
      const deeplink = await searchDeezerEpisode(episodeDate)
      
      assert.ok(deeplink, 'Deeplink should be defined')
      assert.strictEqual(deeplink, 'https://www.deezer.com/fr/episode/804501282')
    })

    test('should find different episode for different date', skipExternal, async () => {
      const episodeDate = '2025-10-17' // Bande-annonce
      
      const deeplink = await searchDeezerEpisode(episodeDate)
      
      assert.ok(deeplink, 'Deeplink should be defined')
      assert.ok(deeplink.includes('https://www.deezer.com/fr/episode/'))
      assert.ok(!deeplink.includes('804501282'), 'Should NOT be S2E1 ID')
    })
    
    test('should return null if episode not found', skipExternal, async () => {
      const episodeDate = '2099-12-31'
      
      const deeplink = await searchDeezerEpisode(episodeDate)
      
      assert.strictEqual(deeplink, null)
    })
  })

  describe('searchYouTubeEpisode', () => {
    test('returns the resolved video with its API-provided 16:9 maxres thumbnail', async () => {
      const result = await searchYouTubeEpisodeMedia(3, 2, {
        apiKey: 'test-api-key',
        uploadsPlaylistId: 'UU-test-uploads',
        fetchImpl: async () => ({
          ok: true,
          async json() {
            return {
              items: [{
                snippet: {
                  description: 'https://saletesincere.fr/podcast/3/2',
                  resourceId: { videoId: 'Bbbbbbbbb-1' },
                  thumbnails: {
                    maxres: {
                      url: 'https://i.ytimg.com/vi/Bbbbbbbbb-1/maxresdefault.jpg',
                      width: 1280,
                      height: 720
                    }
                  }
                }
              }]
            }
          }
        })
      })

      assert.deepEqual(result, {
        url: 'https://www.youtube.com/watch?v=Bbbbbbbbb-1',
        thumbnailUrl: 'https://i.ytimg.com/vi/Bbbbbbbbb-1/maxresdefault.jpg'
      })
    })

    test('finds the video whose description contains the exact canonical episode URL', async () => {
      const requests = []
      const fetchImpl = async (url) => {
        requests.push(new URL(url))
        return {
          ok: true,
          async json() {
            return {
              items: [
                {
                  snippet: {
                    description: 'Voir aussi https://saletesincere.fr/podcast/3/10',
                    resourceId: { videoId: 'AAAAAAAAAAA' }
                  }
                },
                {
                  snippet: {
                    description: 'URL non canonique : https://saletesincere.fr/podcast/03/01',
                    resourceId: { videoId: 'EEEEEEEEEEE' }
                  }
                },
                {
                  snippet: {
                    description: 'Page de l’épisode : https://saletesincere.fr/podcast/3/1',
                    resourceId: { videoId: 'Bbbbbbbbb-1' }
                  }
                }
              ]
            }
          }
        }
      }

      const result = await searchYouTubeEpisode(3, 1, {
        apiKey: 'test-api-key',
        uploadsPlaylistId: 'UU-test-uploads',
        fetchImpl
      })

      assert.equal(result, 'https://www.youtube.com/watch?v=Bbbbbbbbb-1')
      assert.equal(requests.length, 1)
      assert.equal(requests[0].origin, 'https://www.googleapis.com')
      assert.equal(requests[0].pathname, '/youtube/v3/playlistItems')
      assert.equal(requests[0].searchParams.get('playlistId'), 'UU-test-uploads')
      assert.equal(requests[0].searchParams.get('part'), 'snippet')
      assert.equal(requests[0].searchParams.get('maxResults'), '50')
    })

    test('follows uploads playlist pagination without matching the video title', async () => {
      let calls = 0
      const fetchImpl = async (url) => {
        calls += 1
        const pageToken = new URL(url).searchParams.get('pageToken')
        return {
          ok: true,
          async json() {
            if (!pageToken) {
              return {
                nextPageToken: 'second-page',
                items: [{
                  snippet: {
                    title: 'Saison 2 épisode 3',
                    description: 'Le bon titre ne suffit pas.',
                    resourceId: { videoId: 'CCCCCCCCCCC' }
                  }
                }]
              }
            }
            return {
              items: [{
                snippet: {
                  description: 'https://saletesincere.fr/podcast/2/3',
                  resourceId: { videoId: 'DDDDDDDDDDD' }
                }
              }]
            }
          }
        }
      }

      const result = await searchYouTubeEpisode(2, 3, {
        apiKey: 'test-api-key',
        uploadsPlaylistId: 'UU-test-uploads',
        fetchImpl
      })

      assert.equal(result, 'https://www.youtube.com/watch?v=DDDDDDDDDDD')
      assert.equal(calls, 2)
    })

    test('is silently disabled when the API configuration is incomplete', async () => {
      let calls = 0

      const result = await searchYouTubeEpisode(2, 3, {
        apiKey: '',
        uploadsPlaylistId: '',
        fetchImpl: async () => {
          calls += 1
          throw new Error('should not fetch')
        }
      })

      assert.equal(result, null)
      assert.equal(calls, 0)
      assert.equal(isYouTubeEpisodeResolutionConfigured({
        YOUTUBE_API_KEY: 'key',
        YOUTUBE_UPLOADS_PLAYLIST_ID: 'UU-test'
      }), true)
      assert.equal(isYouTubeEpisodeResolutionConfigured({
        YOUTUBE_API_KEY: 'key'
      }), false)
    })

    test('ignores malformed video identifiers and API failures', async () => {
      const malformed = await searchYouTubeEpisode(1, 0, {
        apiKey: 'test-api-key',
        uploadsPlaylistId: 'UU-test-uploads',
        fetchImpl: async () => ({
          ok: true,
          async json() {
            return {
              items: [{
                snippet: {
                  description: 'https://saletesincere.fr/podcast/1/0',
                  resourceId: { videoId: 'not a valid id' }
                }
              }]
            }
          }
        })
      })
      const failed = await searchYouTubeEpisode(1, 0, {
        apiKey: 'test-api-key',
        uploadsPlaylistId: 'UU-test-uploads',
        fetchImpl: async () => ({ ok: false, status: 403 })
      })

      assert.equal(malformed, null)
      assert.equal(failed, null)
    })
  })
  
  describe('buildPodcastAddictLink', () => {
    test('should encode audioUrl and build deeplink', () => {
      const audioUrl = 'https://op3.dev/e,pg=bb74e9c5-20e5-5226-8491-d512ad8ebe04/podcasts.saletesincere.fr/audio/@charbonwafer/une-collaboration-un-peu-speciale.mp3?_from=podcastaddict.com'
      const originalPodcastId = process.env.PODCASTADDICT_PODCAST_ID
      process.env.PODCASTADDICT_PODCAST_ID = '6137997'
      
      const deeplink = buildPodcastAddictLink(audioUrl)

      if (originalPodcastId === undefined) delete process.env.PODCASTADDICT_PODCAST_ID
      else process.env.PODCASTADDICT_PODCAST_ID = originalPodcastId
      
      assert.ok(deeplink.includes('https://podcastaddict.com/episode/'))
      assert.ok(deeplink.includes('podcastId=6137997'))
      assert.ok(deeplink.includes(encodeURIComponent(audioUrl)))
    })
    
    test('should throw error if audioUrl missing', () => {
      assert.throws(
        () => buildPodcastAddictLink(),
        /audioUrl required/
      )
      
      assert.throws(
        () => buildPodcastAddictLink(''),
        /audioUrl required/
      )
    })
  })
  
  describe('buildFallbackLinks', () => {
    test('should return fallback URLs for all platforms', () => {
      const fallbacks = buildFallbackLinks()
      
      assert.ok(fallbacks.spotify)
      assert.ok(fallbacks.apple)
      assert.ok(fallbacks.deezer)
      assert.ok(fallbacks.podcastAddict)
      assert.ok(fallbacks.antennapod)
      assert.ok(fallbacks.pocketCasts)
      assert.ok(fallbacks.overcast)
      
      assert.ok(fallbacks.spotify.includes('spotify.com'))
      assert.ok(fallbacks.apple.includes('apple.com'))
      assert.ok(fallbacks.deezer.includes('deezer.com'))
      assert.ok(fallbacks.podcastAddict.includes('podcastaddict.com'))
    })
  })
})
