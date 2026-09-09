import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../../server.js'
import {
  createDatabaseAvailability,
  DatabaseState
} from '../../server/resilience/databaseAvailability.js'

const UNAVAILABLE_DATABASE_URL = [
  'postgresql:',
  '',
  '127.0.0.1:1',
  'salete_test'
].join('/')

const RSS_EPISODE = {
  season: 2,
  episode: 1,
  title: 'Le titre reste disponible',
  description: 'La description RSS reste disponible sans PostgreSQL.',
  pubDate: '27 octobre 2025',
  rawPubDate: '2025-10-27',
  duration: '42:00',
  image: 'https://media.example/cover.jpg',
  audioUrl: 'https://media.example/episode.mp3',
  episodeLink: 'https://podcasts.example/episode',
  feedLastBuildDate: '2026-08-19T12:00:00.000Z',
  itemGuid: 'episode-guid',
  isTruncated: false
}

function unavailableAvailability() {
  return createDatabaseAvailability({
    initialState: DatabaseState.UNAVAILABLE,
    probe: async () => DatabaseState.UNAVAILABLE
  })
}

function multipartRecording() {
  const boundary = '----salete-sincere-test-boundary'
  const fields = [
    ['title', 'Un récit'],
    ['transcription', 'Une transcription accessible'],
    ['badge', 'wafer'],
    ['duration', '30000']
  ]
  const chunks = fields.map(([name, value]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
  )
  chunks.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="recording.webm"\r\nContent-Type: audio/webm\r\n\r\nfake-webm\r\n`,
    `--${boundary}--\r\n`
  )
  return {
    payload: chunks.join(''),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
  }
}

describe('complete degraded mode routes', () => {
  let app
  let storageCalls

  before(async () => {
    storageCalls = 0
    app = await buildApp({
      initializeStorage: false,
      databaseUrl: UNAVAILABLE_DATABASE_URL,
      databaseConfigured: false,
      databaseAvailability: unavailableAvailability(),
      episodeFetcher: async () => RSS_EPISODE,
      storageClient: {
        async send() {
          storageCalls += 1
        }
      }
    })
  })

  after(async () => {
    await app.close()
  })

  test('renders a complete RSS episode with functional fallbacks and no warning', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/podcast/2/1'
    })

    assert.equal(response.statusCode, 200)
    assert.match(response.body, /Le titre reste disponible/)
    assert.match(response.body, /La description RSS reste disponible sans PostgreSQL/)
    assert.match(response.body, /27 octobre 2025/)
    assert.match(response.body, /media\.example\/cover\.jpg/)
    assert.match(response.body, /media\.example\/episode\.mp3/)
    assert.doesNotMatch(response.body, /Certains liens directs et les statistiques/)
    assert.match(response.body, /open\.spotify\.com\/show\/07VuGnu0YSacC671s0DQ3a/)
    assert.match(response.body, /deezer\.com\/fr\/show\/1002292972/)
    assert.match(
      response.body,
      /<div class="text-xs text-gray-500">Écouter le podcast<\/div>/
    )
  })

  test('renders the wall as unavailable without empty stats or write controls', async () => {
    const response = await app.inject({ method: 'GET', url: '/wall' })

    assert.equal(response.statusCode, 200)
    assert.match(response.body, /Le Sale-wall est temporairement indisponible/)
    assert.doesNotMatch(response.body, /Aucun récit partagé pour le moment/)
    assert.doesNotMatch(response.body, /id="toggle-record"/)
    assert.doesNotMatch(response.body, /aria-label="Voter"/)
  })

  test('rejects wall writes before parsing or uploading with a stable 503 contract', async () => {
    const [createResponse, voteResponse] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/posts' }),
      app.inject({ method: 'POST', url: '/api/posts/00000000-0000-0000-0000-000000000001/vote' })
    ])

    for (const response of [createResponse, voteResponse]) {
      assert.equal(response.statusCode, 503)
      assert.equal(response.headers['retry-after'], '60')
      assert.deepEqual(response.json(), {
        success: false,
        code: 'SERVICE_TEMPORARILY_UNAVAILABLE',
        retryable: true,
        message: 'Le Sale-wall est temporairement indisponible. Réessaie dans quelques minutes.'
      })
    }
    assert.equal(storageCalls, 0)
  })

  test('uses readable episode cache in recovery without pretending the wall is writable', async () => {
    const readOnlyAvailability = createDatabaseAvailability({
      initialState: DatabaseState.READ_ONLY,
      probe: async () => DatabaseState.READ_ONLY
    })
    const cachedLinks = {
      spotify_url: 'https://open.spotify.com/episode/direct',
      apple_url: 'https://podcasts.apple.com/episode/direct',
      deezer_url: 'https://deezer.com/episode/direct',
      podcast_addict_url: null,
      og_image_url: 'https://media.example/og.png',
      feed_last_build: RSS_EPISODE.feedLastBuildDate,
      generated_at: new Date().toISOString()
    }
    const readOnlyApp = await buildApp({
      initializeStorage: false,
      databaseUrl: UNAVAILABLE_DATABASE_URL,
      databaseConfigured: false,
      databaseAvailability: readOnlyAvailability,
      databaseAdapter: {
        query: async () => ({ rows: [] }),
        pool: {},
        connect: async () => ({
          query: async () => ({ rows: [cachedLinks] }),
          release() {}
        })
      },
      episodeFetcher: async () => ({ ...RSS_EPISODE, itemGuid: null })
    })

    try {
      const [episodeResponse, wallResponse] = await Promise.all([
        readOnlyApp.inject({ method: 'GET', url: '/podcast/2/1' }),
        readOnlyApp.inject({ method: 'GET', url: '/wall' })
      ])

      assert.equal(episodeResponse.statusCode, 200)
      assert.match(episodeResponse.body, /open\.spotify\.com\/episode\/direct/)
      assert.match(
        episodeResponse.body,
        /<meta property="og:image" content="https:\/\/saletesincere\.fr\/cdn-cgi\/image\/width=1200,height=630,fit=cover,quality=85,format=png\/https:\/\/media\.example\/og\.png">/
      )
      assert.match(
        episodeResponse.body,
        /<meta name="twitter:image" content="https:\/\/saletesincere\.fr\/cdn-cgi\/image\/width=1200,height=630,fit=cover,quality=85,format=png\/https:\/\/media\.example\/og\.png">/
      )
      assert.doesNotMatch(episodeResponse.body, /Certains liens directs et les statistiques/)
      assert.equal(wallResponse.statusCode, 200)
      assert.match(wallResponse.body, /Le Sale-wall est temporairement indisponible/)
    } finally {
      await readOnlyApp.close()
    }
  })

  test('keeps the episode available when PostgreSQL fails during the OP3 cache read', async () => {
    const availability = createDatabaseAvailability({
      initialState: DatabaseState.READ_WRITE,
      probe: async () => DatabaseState.READ_WRITE
    })
    const statsFailureApp = await buildApp({
      initializeStorage: false,
      op3PublicStatsEnabled: true,
      databaseUrl: UNAVAILABLE_DATABASE_URL,
      databaseConfigured: false,
      databaseAvailability: availability,
      databaseAdapter: {
        async query() {
          throw Object.assign(new Error('connection terminated'), {
            code: 'ECONNRESET'
          })
        },
        pool: {
          async query() {
            throw Object.assign(new Error('connection terminated'), {
              code: 'ECONNRESET'
            })
          }
        },
        async connect() {
          return {
            async query() {
              return {
                rows: [{
                  spotify_url: 'https://open.spotify.com/episode/direct',
                  apple_url: 'https://podcasts.apple.com/episode/direct',
                  deezer_url: 'https://deezer.com/episode/direct',
                  podcast_addict_url: null,
                  og_image_url: 'https://media.example/og.png',
                  feed_last_build: RSS_EPISODE.feedLastBuildDate,
                  generated_at: new Date().toISOString()
                }]
              }
            },
            release() {}
          }
        }
      },
      episodeFetcher: async () => RSS_EPISODE
    })

    try {
      const response = await statsFailureApp.inject({
        method: 'GET',
        url: '/podcast/2/1'
      })

      assert.equal(response.statusCode, 200)
      assert.match(response.body, /open\.spotify\.com\/episode\/direct/)
      assert.doesNotMatch(response.body, /Certains liens directs et les statistiques/)
      assert.equal(availability.getState(), DatabaseState.UNAVAILABLE)
    } finally {
      await statsFailureApp.close()
    }
  })

  test('compensates an uploaded audio object when PostgreSQL fails before insert', async () => {
    const storageCommands = []
    const writableAvailability = createDatabaseAvailability({
      probe: async () => DatabaseState.READ_WRITE
    })
    const compensationApp = await buildApp({
      initializeStorage: false,
      databaseUrl: UNAVAILABLE_DATABASE_URL,
      databaseConfigured: false,
      databaseAvailability: writableAvailability,
      databaseAdapter: {
        query: async () => ({ rows: [] }),
        pool: {},
        connect: async () => {
          throw Object.assign(new Error('connection refused'), {
            code: 'ECONNREFUSED'
          })
        }
      },
      storageClient: {
        async send(command) {
          storageCommands.push(command.constructor.name)
        }
      },
      audioValidator: () => ({
        isValid: true,
        validatedData: { duration: 30000, size: 9 }
      })
    })

    try {
      const recording = multipartRecording()
      const response = await compensationApp.inject({
        method: 'POST',
        url: '/api/posts',
        ...recording
      })

      assert.equal(response.statusCode, 503)
      assert.deepEqual(storageCommands, ['PutObjectCommand', 'DeleteObjectCommand'])
    } finally {
      await compensationApp.close()
    }
  })

  test('retires the wall without touching storage or the database', async () => {
    let databaseCalls = 0
    let storageCalls = 0
    const retiredWallApp = await buildApp({
      initializeStorage: false,
      wallEnabled: false,
      databaseConfigured: false,
      databaseAdapter: {
        async query() {
          databaseCalls += 1
          throw new Error('database must not be called')
        },
        pool: {},
        async connect() {
          databaseCalls += 1
          throw new Error('database must not be called')
        }
      },
      storageClient: {
        async send() {
          storageCalls += 1
        }
      }
    })

    try {
      const [wall, create, vote] = await Promise.all([
        retiredWallApp.inject({ method: 'GET', url: '/wall' }),
        retiredWallApp.inject({ method: 'POST', url: '/api/posts' }),
        retiredWallApp.inject({
          method: 'POST',
          url: '/api/posts/00000000-0000-0000-0000-000000000001/vote'
        })
      ])

      assert.equal(wall.statusCode, 301)
      assert.equal(wall.headers.location, '/')
      for (const response of [create, vote]) {
        assert.equal(response.statusCode, 410)
        assert.deepEqual(response.json(), {
          success: false,
          code: 'SALE_WALL_RETIRED',
          retryable: false,
          message: 'Le Sale-wall est fermé.'
        })
      }
      assert.equal(databaseCalls, 0)
      assert.equal(storageCalls, 0)
    } finally {
      await retiredWallApp.close()
    }
  })
})
