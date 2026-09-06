import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../../server.js'
import {
  createDatabaseAvailability,
  DatabaseState
} from '../../server/resilience/databaseAvailability.js'

const apps = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function episodeData({
  season = 3,
  episode = 2,
  hasVideo = false,
  videoFormats = { mp4: false, hls: false }
} = {}) {
  return {
    season,
    episode,
    title: 'CHARBON - Les petits de Douai qui travaillent avec INTEL et AMD',
    description: 'Description de test.',
    duration: '26:04',
    image: 'https://media.example/episode.jpg',
    episodeLink: 'https://podcasts.example/episode',
    audioUrl: null,
    itemGuid: `guid-${season}-${episode}`,
    rawPubDate: '2026-08-25',
    feedLastBuildDate: '2026-09-04T08:00:00.000Z',
    hasVideo,
    videoFormats
  }
}

function databaseAdapter(platformLinks = null, podcastPlatformRows = []) {
  return {
    pool: { async query() { return { rows: [] } } },
    async connect() {
      return {
        async query(sql) {
          if (sql.includes('SELECT season, episode')) {
            return { rows: podcastPlatformRows }
          }
          return { rows: platformLinks ? [platformLinks] : [] }
        },
        release() {}
      }
    }
  }
}

async function createApp(platformLinks = null, {
  episode = episodeData(),
  episodes = [episode],
  podcastPlatformRows = []
} = {}) {
  const app = await buildApp({
    initializeStorage: false,
    databaseConfigured: false,
    databaseAdapter: databaseAdapter(platformLinks, podcastPlatformRows),
    databaseAvailability: createDatabaseAvailability({
      initialState: DatabaseState.READ_WRITE,
      probe: async () => DatabaseState.READ_WRITE
    }),
    episodeFetcher: async () => episode,
    podcastEpisodesFetcher: async () => episodes,
    youtubeChannelUrl: null,
    youtubeEpisodeResolutionEnabled: true
  })
  apps.push(app)
  return app
}

function elementById(body, tag, id) {
  const match = body.match(new RegExp(`<${tag}[^>]+id="${id}"[\\s\\S]*?<\\/${tag}>`))
  assert.ok(match, `Expected the ${id} element to be rendered`)
  return match[0]
}

describe('podcast format and platform availability', () => {
  test('does not render an aggregate video tag on /podcast', async () => {
    const hostedEpisode = episodeData({
      season: 3,
      episode: 3,
      hasVideo: true,
      videoFormats: { mp4: true, hls: true }
    })
    const app = await createApp(null, {
      episode: hostedEpisode,
      episodes: [hostedEpisode, episodeData()],
      podcastPlatformRows: [
        {
          season: 3,
          episode: 2,
          apple_url: null,
          spotify_video_available: true,
          youtube_url: 'https://www.youtube.com/watch?v=Bbbbbbbbb-1'
        },
        {
          season: 3,
          episode: 3,
          apple_url: 'https://podcasts.apple.com/episode/direct',
          spotify_video_available: false,
          youtube_url: null
        }
      ]
    })

    const response = await app.inject({ method: 'GET', url: '/podcast' })

    assert.equal(response.statusCode, 200)
    assert.match(response.body, /Choisis ton format et ta plateforme/)
    assert.doesNotMatch(response.body, /id="podcast-video-availability"/)
    assert.doesNotMatch(response.body, /id="podcast-availability"/)
  })

  test('does not treat the RSS feed as cross-platform publication proof', async () => {
    const audioEpisode = episodeData()
    const app = await createApp(null, {
      episode: audioEpisode,
      episodes: [audioEpisode]
    })

    const response = await app.inject({ method: 'GET', url: '/podcast' })

    assert.equal(response.statusCode, 200)
    assert.doesNotMatch(response.body, /id="podcast-video-availability"/)
    assert.doesNotMatch(response.body, /src="\/images\/youtube-logo\.svg"/)
  })

  test('shows S3E2 as 4K on Spotify and YouTube without an RSS video enclosure', async () => {
    const app = await createApp({
      spotify_url: 'https://open.spotify.com/episode/direct',
      spotify_video_available: true,
      apple_url: 'https://podcasts.apple.com/episode/direct',
      deezer_url: 'https://deezer.com/episode/direct',
      podcast_addict_url: 'https://podcastaddict.com/episode/direct',
      youtube_url: 'https://www.youtube.com/watch?v=Bbbbbbbbb-1',
      youtube_thumbnail_url: 'https://i.ytimg.com/vi/Bbbbbbbbb-1/maxresdefault.jpg',
      og_image_url: 'https://media.example/og.png',
      feed_last_build: '2026-09-04T08:00:00.000Z',
      generated_at: new Date().toISOString()
    })

    const response = await app.inject({ method: 'GET', url: '/podcast/3/2' })
    const availability = elementById(response.body, 'div', 'episode-video-availability')

    assert.equal(response.statusCode, 200)
    assert.match(availability, /Spotify \(4K\)/)
    assert.match(availability, /YouTube \(4K\)/)
    assert.doesNotMatch(availability, /Site officiel/)
    assert.doesNotMatch(availability, /Apple Podcasts/)
    assert.match(
      response.body,
      /href="https:\/\/open\.spotify\.com\/episode\/direct"[\s\S]*?>Vidéo 4K<\/span>[\s\S]*?<\/a>/
    )
    assert.match(
      response.body,
      /href="https:\/\/www\.youtube\.com\/watch\?v&#x3D;Bbbbbbbbb-1"[\s\S]*?>Vidéo 4K<\/span>[\s\S]*?<\/a>/
    )
    assert.match(
      response.body,
      /class="rounded-full bg-red-600 px-2 py-1 text-xs font-semibold text-white">Vidéo 4K<\/span>/
    )
    assert.doesNotMatch(response.body, /text-red-600">Vidéo 4K<\/span>/)
    assert.match(
      response.body,
      /<meta property="og:image" content="https:\/\/i\.ytimg\.com\/vi\/Bbbbbbbbb-1\/maxresdefault\.jpg">/
    )
    assert.match(response.body, /<meta property="og:image:width" content="1280">/)
    assert.match(response.body, /<meta property="og:image:height" content="720">/)
    assert.match(
      response.body,
      /<meta name="twitter:image" content="https:\/\/i\.ytimg\.com\/vi\/Bbbbbbbbb-1\/maxresdefault\.jpg">/
    )
  })

  test('keeps hosted video separate from an unavailable Spotify video', async () => {
    const hostedEpisode = episodeData({
      season: 3,
      episode: 3,
      hasVideo: true,
      videoFormats: { mp4: true, hls: true }
    })
    const app = await createApp({
      spotify_url: 'https://open.spotify.com/episode/direct',
      spotify_video_available: false,
      apple_url: 'https://podcasts.apple.com/episode/direct',
      deezer_url: null,
      podcast_addict_url: null,
      youtube_url: null,
      og_image_url: 'https://media.example/og.png',
      feed_last_build: '2026-09-04T08:00:00.000Z',
      generated_at: new Date().toISOString()
    }, { episode: hostedEpisode })

    const response = await app.inject({ method: 'GET', url: '/podcast/3/3' })
    const availability = elementById(response.body, 'div', 'episode-video-availability')

    assert.equal(response.statusCode, 200)
    assert.match(availability, /Site officiel/)
    assert.match(availability, /Apple Podcasts/)
    assert.doesNotMatch(availability, /Spotify/)
    assert.doesNotMatch(availability, /YouTube/)
    assert.doesNotMatch(response.body, />Vidéo HD<\/span>/)
  })

  test('shows the confirmed Spotify HD badge for S3E1 independently from RSS', async () => {
    const app = await createApp({
      spotify_url: 'https://open.spotify.com/episode/direct',
      spotify_video_available: true,
      apple_url: null,
      deezer_url: null,
      podcast_addict_url: null,
      youtube_url: null,
      og_image_url: 'https://media.example/og.png',
      feed_last_build: '2026-09-04T08:00:00.000Z',
      generated_at: new Date().toISOString()
    }, {
      episode: episodeData({ season: 3, episode: 1 })
    })

    const response = await app.inject({ method: 'GET', url: '/podcast/3/1' })
    const availability = elementById(response.body, 'div', 'episode-video-availability')

    assert.equal(response.statusCode, 200)
    assert.match(availability, /Spotify \(HD\)/)
    assert.doesNotMatch(availability, /YouTube/)
    assert.match(response.body, />Vidéo HD<\/span>/)
  })
})
