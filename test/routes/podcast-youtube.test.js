import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../../server.js'
import {
  createDatabaseAvailability,
  DatabaseState
} from '../../server/resilience/databaseAvailability.js'

const apps = []
const legacyChannelUrl = 'https://www.youtube.com/@charbonwafer'

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function episodeData() {
  return {
    season: 3,
    episode: 1,
    title: 'Mais l’IA consomme de l’eau',
    description: 'Description de test.',
    duration: '26:04',
    image: 'https://media.example/episode.jpg',
    episodeLink: 'https://podcasts.example/episode',
    audioUrl: null,
    itemGuid: 'guid-3-1',
    rawPubDate: '2026-08-25',
    feedLastBuildDate: '2026-09-04T08:00:00.000Z'
  }
}

function databaseAdapter(youtubeUrl) {
  return {
    pool: { async query() { return { rows: [] } } },
    async connect() {
      return {
        async query() {
          return {
            rows: [{
              spotify_url: 'https://open.spotify.com/episode/direct',
              apple_url: 'https://podcasts.apple.com/episode/direct',
              deezer_url: 'https://deezer.com/episode/direct',
              podcast_addict_url: null,
              youtube_url: youtubeUrl,
              og_image_url: 'https://media.example/og.png',
              feed_last_build: '2026-09-04T08:00:00.000Z',
              generated_at: new Date().toISOString()
            }]
          }
        },
        release() {}
      }
    }
  }
}

async function createApp({ youtubeUrl = null } = {}) {
  const app = await buildApp({
    initializeStorage: false,
    databaseConfigured: false,
    databaseAdapter: databaseAdapter(youtubeUrl),
    databaseAvailability: createDatabaseAvailability({
      initialState: DatabaseState.READ_WRITE,
      probe: async () => DatabaseState.READ_WRITE
    }),
    episodeFetcher: async () => episodeData(),
    podcastEpisodesFetcher: async () => [],
    youtubeChannelUrl: legacyChannelUrl,
    youtubeEpisodeResolutionEnabled: true
  })
  apps.push(app)
  return app
}

describe('podcast YouTube links', () => {
  test('renders the generic YouTube channel among platforms on the main podcast page', async () => {
    const app = await createApp()

    const response = await app.inject({ method: 'GET', url: '/podcast' })

    assert.equal(response.statusCode, 200)
    assert.match(response.body, new RegExp(`href="${legacyChannelUrl}"`))
    assert.match(response.body, /Voir les épisodes vidéo/)
    assert.match(response.body, /src="\/images\/youtube-logo\.svg" alt=""/)
  })

  test('links an episode page to its resolved YouTube video', async () => {
    const videoUrl = 'https://www.youtube.com/watch?v=Bbbbbbbbb-1'
    const app = await createApp({ youtubeUrl: videoUrl })

    const response = await app.inject({ method: 'GET', url: '/podcast/3/1' })

    assert.equal(response.statusCode, 200)
    assert.match(response.body, /href="https:\/\/www\.youtube\.com\/watch\?v&#x3D;Bbbbbbbbb-1"/)
    assert.match(response.body, /Voir Mais l’IA consomme de l’eau/)
  })

  test('removes the YouTube card when the episode has no resolved video', async () => {
    const app = await createApp()

    const response = await app.inject({ method: 'GET', url: '/podcast/3/1' })

    assert.equal(response.statusCode, 200)
    assert.doesNotMatch(response.body, new RegExp(`href="${legacyChannelUrl}"`))
    assert.doesNotMatch(response.body, /Voir la chaîne du podcast/)
    assert.doesNotMatch(response.body, /src="\/images\/youtube-logo\.svg"/)
    assert.equal(response.headers['cache-control'], 'public, max-age=60')
  })
})
