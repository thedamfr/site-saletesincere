import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../../server.js'
import {
  createDatabaseAvailability,
  DatabaseState
} from '../../server/resilience/databaseAvailability.js'
import { getOGImageS3Key } from '../../server/services/ogImageLayout.js'

const NOW = new Date('2026-08-20T12:00:00.000Z')
const apps = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function publishedEpisodes() {
  return [
    {
      season: 2,
      episode: 3,
      title: 'Le troisième épisode',
      description: 'Un extrait concret pour donner envie de découvrir cet épisode.',
      duration: '38:12',
      image: 'https://media.example/episode-3.jpg',
      episodeLink: 'https://podcasts.example/3',
      itemGuid: 'guid-3',
      rawPubDate: '2026-08-15'
    },
    {
      season: 2,
      episode: 2,
      title: 'Le deuxième épisode',
      description: 'Deuxième description.',
      duration: '41:00',
      image: 'https://media.example/episode-2.jpg',
      episodeLink: 'https://podcasts.example/2',
      itemGuid: 'guid-2',
      rawPubDate: '2026-08-08'
    },
    {
      season: 2,
      episode: 1,
      title: 'Le premier épisode',
      description: 'Première description.',
      duration: '43:11',
      image: 'https://media.example/episode-1.jpg',
      episodeLink: 'https://podcasts.example/1',
      itemGuid: 'guid-1',
      rawPubDate: '2026-08-01'
    }
  ]
}

function availability(initialState, probe) {
  return createDatabaseAvailability({ initialState, probe })
}

function databaseAdapter({ episodeStats } = {}) {
  const row = episodeStats || null
  return {
    async query() { return { rows: [] } },
    pool: {
      async query() {
        return { rows: row ? [row] : [] }
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
              feed_last_build: '2026-08-20T08:00:00.000Z',
              generated_at: '2026-08-20T08:00:00.000Z'
            }]
          }
        },
        release() {}
      }
    }
  }
}

async function createApp(options = {}) {
  const app = await buildApp({
    initializeStorage: false,
    databaseConfigured: false,
    databaseAdapter: databaseAdapter(),
    databaseAvailability: availability(DatabaseState.READ_WRITE, async () => DatabaseState.READ_WRITE),
    op3PublicStatsEnabled: true,
    now: () => NOW,
    ...options
  })
  apps.push(app)
  return app
}

describe('podcast canonical URL', () => {
  test('redirects an episode trailing slash to its canonical URL', async () => {
    const app = await createApp()

    const response = await app.inject({
      method: 'GET',
      url: '/podcast/3/2/?source=preview'
    })

    assert.equal(response.statusCode, 301)
    assert.equal(response.headers.location, '/podcast/3/2?source=preview')
  })

  test('redirects /podcast/ permanently while preserving ordinary query parameters', async () => {
    const app = await createApp()

    const response = await app.inject({ method: 'GET', url: '/podcast/?source=newsletter' })

    assert.equal(response.statusCode, 301)
    assert.equal(response.headers.location, '/podcast?source=newsletter')
  })

  test('keeps compatibility for slash URLs with season and episode', async () => {
    const app = await createApp()

    const response = await app.inject({
      method: 'GET',
      url: '/podcast/?season=2&episode=1'
    })

    assert.equal(response.statusCode, 301)
    assert.equal(response.headers.location, '/podcast/2/1')
  })
})

describe('GET /podcast traction card', () => {
  test('uses the latest published episode OG image for sharing, independently from popularity', async () => {
    const latestEpisode = publishedEpisodes()[0]
    const expectedKey = getOGImageS3Key({
      season: latestEpisode.season,
      episode: latestEpisode.episode,
      imageUrl: latestEpisode.image,
      feedLastBuildDate: latestEpisode.feedLastBuildDate
    })
    const expectedUrl = `https://media.example/${expectedKey}`
    const expectedTransformedUrl = `https://saletesincere.fr/cdn-cgi/image/width=1200,height=630,fit=cover,quality=85,format=png/${expectedUrl}`
    const adapter = databaseAdapter()
    adapter.pool.query = async (query, values) => {
      assert.match(query, /SELECT og_image_url/)
      assert.deepEqual(values, [2, 3])
      return { rows: [{ og_image_url: expectedUrl }] }
    }
    const app = await createApp({
      databaseAdapter: adapter,
      podcastEpisodesFetcher: async () => publishedEpisodes(),
      op3StatsListReader: async () => [
        { itemGuid: 'guid-1', downloads7: 12, downloadsAll: 30, fetchedAt: NOW },
        { itemGuid: 'guid-2', downloads7: 50, downloadsAll: 90, fetchedAt: NOW },
        { itemGuid: 'guid-3', downloads7: 42, downloadsAll: 80, fetchedAt: NOW }
      ]
    })

    const response = await app.inject({ method: 'GET', url: '/podcast' })
    const health = await app.inject({ method: 'GET', url: '/health' })

    assert.equal(response.statusCode, 200)
    assert.match(response.body, /Le deuxième épisode/)
    assert.ok(response.body.includes(`<meta property="og:image" content="${expectedTransformedUrl}">`))
    assert.match(response.body, /<meta property="og:image:width" content="1200">/)
    assert.match(response.body, /<meta property="og:image:height" content="630">/)
    assert.match(
      response.body,
      /<meta property="og:image:alt" content="Jaquette de l&#x27;épisode Le troisième épisode">/
    )
    assert.ok(response.body.includes(`<meta name="twitter:image" content="${expectedTransformedUrl}">`))
    assert.equal(health.json().episodeIntents.pending, 0)
  })

  test('schedules regeneration when the latest image uses a legacy cache key', async () => {
    const adapter = databaseAdapter()
    adapter.pool.query = async () => ({
      rows: [{ og_image_url: 'https://media.example/og-images/s2e3.png' }]
    })
    const app = await createApp({
      databaseAdapter: adapter,
      podcastEpisodesFetcher: async () => publishedEpisodes()
    })

    const response = await app.inject({ method: 'GET', url: '/podcast' })
    const health = await app.inject({ method: 'GET', url: '/health' })

    assert.equal(response.statusCode, 200)
    assert.match(
      response.body,
      /<meta property="og:image" content="https:\/\/saletesincere\.fr\/cdn-cgi\/image\/width=1200,height=630,fit=cover,quality=85,format=png\/https:\/\/media\.example\/og-images\/s2e3\.png">/
    )
    assert.equal(health.json().episodeIntents.pending, 1)
  })

  test('renders the selected popular episode from RSS and cached OP3 stats', async () => {
    let queueCalls = 0
    const app = await createApp({
      podcastEpisodesFetcher: async () => publishedEpisodes(),
      op3StatsListReader: async () => [
        { itemGuid: 'guid-1', downloads7: 12, downloadsAll: 30, fetchedAt: NOW },
        { itemGuid: 'guid-2', downloads7: 18, downloadsAll: 60, fetchedAt: NOW },
        { itemGuid: 'guid-3', downloads7: 42, downloadsAll: 80, fetchedAt: NOW }
      ],
      episodeQueuer: async () => {
        queueCalls += 1
        return { queued: true }
      }
    })

    const response = await app.inject({ method: 'GET', url: '/podcast' })

    assert.equal(response.statusCode, 200)
    assert.match(response.body, /Le plus populaire cette semaine/)
    assert.match(response.body, /Le troisième épisode/)
    assert.match(
      response.body,
      /Déjà 80 téléchargements depuis sa sortie, mesurés par OP3/
    )
    assert.doesNotMatch(response.body, />42 téléchargements mesurés par OP3</)
    assert.match(response.body, /href="\/podcast\/2\/3"/)
    assert.match(
      response.body,
      /<img[^>]+src="\/cdn-cgi\/image\/width=662,height=662,fit=pad,background=%23000000,quality=85,format=auto\/https:\/\/media\.example\/episode-3\.jpg"[^>]+class="[^"]*h-auto[^"]*w-full[^"]*"/
    )
    assert.doesNotMatch(response.body, /rel="preconnect"[^>]+cellar-c2\.services\.clever-cloud\.com/)
    assert.match(
      response.body,
      /<img[^>]+media\.example\/episode-3\.jpg[^>]+width="662"[^>]+height="662"[^>]+fetchpriority="high"/
    )
    assert.doesNotMatch(
      response.body,
      /<img[^>]+media\.example\/episode-3\.jpg[^>]+object-cover/
    )
    assert.equal(queueCalls, 0)
  })

  test('uses the latest RSS image for sharing without a DB probe or stats read', async () => {
    let probeCalls = 0
    let rssCalls = 0
    let statsCalls = 0
    const app = await createApp({
      databaseAvailability: availability(DatabaseState.UNAVAILABLE, async () => {
        probeCalls += 1
        return DatabaseState.UNAVAILABLE
      }),
      podcastEpisodesFetcher: async () => {
        rssCalls += 1
        return publishedEpisodes()
      },
      op3StatsListReader: async () => {
        statsCalls += 1
        return []
      }
    })

    const response = await app.inject({ method: 'GET', url: '/podcast' })

    assert.equal(response.statusCode, 200)
    assert.match(response.body, /Le Podcast est sorti/)
    assert.match(
      response.body,
      /<meta property="og:image" content="https:\/\/media\.example\/episode-3\.jpg">/
    )
    assert.equal(probeCalls, 0)
    assert.equal(rssCalls, 1)
    assert.equal(statsCalls, 0)
  })

  test('falls back to the latest RSS image when the generated image cache is unavailable', async () => {
    const databaseAvailability = availability(
      DatabaseState.READ_WRITE,
      async () => DatabaseState.READ_WRITE
    )
    const error = new Error('database connection lost')
    error.code = 'ECONNRESET'
    const adapter = databaseAdapter()
    adapter.pool.query = async () => { throw error }
    let statsCalls = 0
    const app = await createApp({
      databaseAdapter: adapter,
      databaseAvailability,
      podcastEpisodesFetcher: async () => publishedEpisodes(),
      op3StatsListReader: async () => {
        statsCalls += 1
        return []
      }
    })

    const response = await app.inject({ method: 'GET', url: '/podcast' })

    assert.equal(response.statusCode, 200)
    assert.match(
      response.body,
      /<meta property="og:image" content="https:\/\/media\.example\/episode-3\.jpg">/
    )
    assert.equal(statsCalls, 0)
    assert.equal(databaseAvailability.getState(), DatabaseState.UNAVAILABLE)
  })

  test('renders the editorial fallback when the RSS fetch fails', async () => {
    const app = await createApp({
      podcastEpisodesFetcher: async () => { throw new Error('RSS unavailable') },
      op3StatsListReader: async () => { throw new Error('must not read stats') }
    })

    const response = await app.inject({ method: 'GET', url: '/podcast' })

    assert.equal(response.statusCode, 200)
    assert.match(response.body, /Le Podcast est sorti/)
    assert.match(
      response.body,
      /<meta property="og:image" content="https:\/\/saletesincere\.fr\/images\/preview-podcast-smartlink\.jpg">/
    )
    assert.match(
      response.body,
      /<meta name="twitter:image" content="https:\/\/saletesincere\.fr\/images\/preview-podcast-smartlink\.jpg">/
    )
    assert.doesNotMatch(response.body, /RSS unavailable/)
  })

  test('renders the editorial fallback when the optional cache read fails', async () => {
    const databaseAvailability = availability(
      DatabaseState.READ_WRITE,
      async () => DatabaseState.READ_WRITE
    )
    const error = new Error('database connection lost')
    error.code = 'ECONNRESET'
    const app = await createApp({
      databaseAvailability,
      podcastEpisodesFetcher: async () => publishedEpisodes(),
      op3StatsListReader: async () => { throw error }
    })

    const response = await app.inject({ method: 'GET', url: '/podcast' })

    assert.equal(response.statusCode, 200)
    assert.match(response.body, /Le Podcast est sorti/)
    assert.doesNotMatch(response.body, /database connection lost/)
    assert.equal(databaseAvailability.getState(), DatabaseState.UNAVAILABLE)
  })

  test('still refreshes the latest share image while public stats are disabled', async () => {
    let rssCalls = 0
    let statsCalls = 0
    const app = await createApp({
      op3PublicStatsEnabled: false,
      podcastEpisodesFetcher: async () => { rssCalls += 1; return publishedEpisodes() },
      op3StatsListReader: async () => { statsCalls += 1; return [] }
    })

    const response = await app.inject({ method: 'GET', url: '/podcast' })

    assert.equal(response.statusCode, 200)
    assert.match(response.body, /Le Podcast est sorti/)
    assert.match(
      response.body,
      /<meta property="og:image" content="https:\/\/media\.example\/episode-3\.jpg">/
    )
    assert.equal(rssCalls, 1)
    assert.equal(statsCalls, 0)
  })
})

describe('episode OP3 proof', () => {
  test('keeps fallback links usable without warning while direct links are pending', async () => {
    const rssEpisode = {
      ...publishedEpisodes()[0],
      pubDate: '20 août 2026',
      rawPubDate: '2026-08-20',
      audioUrl: 'https://media.example/episode-3.mp3',
      feedLastBuildDate: '2026-08-20T08:00:00.000Z',
      isTruncated: false
    }
    const app = await createApp({
      episodeFetcher: async () => rssEpisode,
      databaseAdapter: {
        async query() { return { rows: [] } },
        pool: { async query() { return { rows: [] } } },
        async connect() {
          return {
            async query() { return { rows: [] } },
            release() {}
          }
        }
      }
    })

    const response = await app.inject({ method: 'GET', url: '/podcast/2/3' })

    assert.equal(response.statusCode, 200)
    assert.match(response.body, /podcasts\.apple\.com\/us\/podcast\/pas-de-charbon-pas-de-wafer/)
    assert.match(response.body, /open\.spotify\.com\/show\/07VuGnu0YSacC671s0DQ3a/)
    assert.match(response.body, /deezer\.com\/fr\/show\/1002292972/)
    assert.match(response.body, /podcastaddict\.com\/podcast\/pas-de-charbon-pas-de-wafer\/6137997/)
    assert.match(response.body, /Écouter le podcast/)
    assert.doesNotMatch(response.body, /temporairement indisponibles|arrivent bientôt/)
    assert.doesNotMatch(response.body, /role="status"/)
  })

  test('shows a stable accessible download badge without IAB claims', async () => {
    const rssEpisode = {
      ...publishedEpisodes()[0],
      pubDate: '15 août 2026',
      rawPubDate: '2026-08-15',
      audioUrl: 'https://media.example/episode-3.mp3',
      feedLastBuildDate: '2026-08-20T08:00:00.000Z',
      isTruncated: false
    }
    const app = await createApp({
      episodeFetcher: async () => rssEpisode,
      op3EpisodeStatsReader: async () => ({
        itemGuid: 'guid-3',
        downloads7: 4,
        downloads30: 30,
        downloadsAll: 81,
        fetchedAt: NOW
      })
    })

    const response = await app.inject({ method: 'GET', url: '/podcast/2/3' })

    assert.equal(response.statusCode, 200)
    assert.match(response.body, /81 téléchargements mesurés par OP3/)
    assert.match(response.body, /Un téléchargement peut être automatique/)
    assert.match(response.body, /summary class="[^"]*list-none/)
    assert.match(response.body, /class="mt-3 rounded-lg/)
    assert.doesNotMatch(response.body, /class="absolute [^"]*top-6/)
    assert.doesNotMatch(response.body, /certifi[ée].*IAB/i)
  })

  test('hides a weak download count on an episode page', async () => {
    const rssEpisode = {
      ...publishedEpisodes()[0],
      pubDate: '15 août 2026',
      audioUrl: 'https://media.example/episode-3.mp3',
      feedLastBuildDate: '2026-08-20T08:00:00.000Z',
      isTruncated: false
    }
    const app = await createApp({
      episodeFetcher: async () => rssEpisode,
      op3EpisodeStatsReader: async () => ({
        itemGuid: 'guid-3',
        downloadsAll: 9,
        fetchedAt: NOW
      })
    })

    const response = await app.inject({ method: 'GET', url: '/podcast/2/3' })

    assert.equal(response.statusCode, 200)
    assert.doesNotMatch(response.body, /téléchargements mesurés par OP3/)
  })
})
