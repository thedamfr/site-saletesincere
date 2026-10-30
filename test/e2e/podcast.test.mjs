import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

process.env.DOTENV_CONFIG_PATH = '/dev/null'
process.env.DISABLE_WORKER = 'true'
process.env.NODE_ENV = 'production'

// Only the local application is contacted. External destinations are intercepted.
test('Golden Journeys — podcast cards and episode availability', { timeout: 90_000 }, async t => {
  const { buildApp } = await import('../../server.js')
  const { createDatabaseAvailability, DatabaseState } = await import('../../server/resilience/databaseAvailability.js')
  let databaseState = DatabaseState.UNAVAILABLE
  let videoAvailable = true
  const episode = {
    season: 3, episode: 2, title: 'Épisode de qualification', description: 'Description de test.',
    duration: '26:04', image: '/images/youtube-logo.svg', episodeLink: 'https://podcasts.example/episode',
    audioUrl: null, itemGuid: 'podcast-e2e-3-2', rawPubDate: '2026-08-25',
    feedLastBuildDate: '2026-09-04T08:00:00.000Z', hasVideo: false,
    videoFormats: { mp4: false, hls: false }
  }
  const databaseAvailability = createDatabaseAvailability({
    initialState: databaseState, freshnessMs: 0, probe: async () => databaseState
  })
  const app = await buildApp({
    storageEnabled: false, initializeStorage: false, wallEnabled: false,
    databaseConfigured: false, databaseAvailability,
    databaseAdapter: {
      pool: { async query() { return { rows: [] } } },
      async connect() {
        assert.equal(databaseState, DatabaseState.READ_WRITE)
        return {
          async query() { return { rows: [{
            spotify_url: 'https://open.spotify.com/episode/direct', spotify_video_available: videoAvailable,
            youtube_url: videoAvailable ? 'https://www.youtube.com/watch?v=Bbbbbbbbb-1' : null,
            apple_url: 'https://podcasts.apple.com/episode/direct',
            generated_at: new Date().toISOString(), feed_last_build: episode.feedLastBuildDate
          }] } },
          release() {}
        }
      }
    },
    podcastEpisodesFetcher: async () => [episode], episodeFetcher: async () => episode,
    op3PublicStatsEnabled: false, youtubeEpisodeResolutionEnabled: true,
    youtubeChannelUrl: 'https://www.youtube.com/@saletesincere'
  })
  let browser
  try {
    const baseURL = await app.listen({ host: '127.0.0.1', port: 0 })
    browser = await chromium.launch({ headless: true, chromiumSandbox: true,
      channel: process.env.E2E_BROWSER_CHANNEL || undefined,
      executablePath: process.env.E2E_BROWSER_EXECUTABLE || undefined })
    const context = await browser.newContext()
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === baseURL) return route.continue()
      return route.fulfill({ contentType: 'text/html', body: '<p>Destination externe simulée</p>' })
    })
    const page = await context.newPage()
    await mkdir('test-results/podcast', { recursive: true })
    for (const width of [320, 390, 1440]) {
      await t.test(`Page générale sans base, largeur ${width}px`, async () => {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(`${baseURL}/podcast`)
        const cards = page.locator('#plateformes .podcast-platform')
        const site = cards.filter({ hasText: 'Le site du podcast' })
        assert.equal(await site.count(), 1)
        assert.match(await site.innerText(), /Retrouve les épisodes et leur transcript complet/)
        assert.equal(await site.getAttribute('href'), 'https://podcasts.saletesincere.fr')
        assert.equal(await cards.locator('.podcast-video-badge').count(), 3)
        for (const name of ['YouTube', 'Apple Podcasts', 'Spotify']) {
          assert.equal(await cards.filter({ hasText: name }).locator('.podcast-video-badge').innerText(), 'Vidéo selon les épisodes')
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
        assert.equal(await cards.evaluateAll(elements => elements.every(card => {
          const box = card.getBoundingClientRect()
          return [...card.querySelectorAll('img, svg, .podcast-video-badge')].every(child => {
            const rect = child.getBoundingClientRect()
            return rect.left >= box.left && rect.right <= box.right && rect.width > 0
          })
        })), true)
        await page.locator('#plateformes').screenshot({ path: `test-results/podcast/platforms-${width}.png` })
        // Reach the first card using the keyboard from the document start.
        await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0) })
        for (let i = 0; i < 60 && !await site.evaluate(el => el === document.activeElement); i++) {
          await page.keyboard.press('Tab')
        }
        assert.equal(await site.evaluate(el => el === document.activeElement), true)
        const popupPromise = page.waitForEvent('popup')
        await page.keyboard.press('Enter')
        const popup = await popupPromise
        await popup.waitForLoadState()
        assert.equal(popup.url(), 'https://podcasts.saletesincere.fr/')
        await popup.close()
        for (const name of ['YouTube', 'Apple Podcasts', 'Spotify']) {
          const card = cards.filter({ hasText: name })
          const href = await card.getAttribute('href')
          const opened = page.waitForEvent('popup')
          await card.click()
          const destination = await opened
          await destination.waitForLoadState()
          assert.equal(destination.url(), new URL(href).href)
          await destination.close()
        }
        await page.reload()
        assert.equal(await cards.locator('.podcast-video-badge').count(), 3)
      })
    }
    await t.test('Les badges des épisodes restent soumis aux preuves disponibles', async () => {
      databaseState = DatabaseState.READ_WRITE
      await page.goto(`${baseURL}/podcast/3/2`)
      const cards = page.locator('#plateformes')
      assert.equal(await cards.getByText('Vidéo selon les épisodes', { exact: true }).count(), 0)
      assert.equal(await cards.getByText('Vidéo 4K', { exact: true }).count(), 2)
      assert.equal(await cards.getByText('Écouter cet épisode', { exact: true }).count(), 1)
      videoAvailable = false
      await page.reload()
      assert.equal(await cards.locator('.podcast-video-badge').count(), 0)
      assert.equal(await cards.getByText('YouTube', { exact: true }).count(), 0)
      databaseState = DatabaseState.UNAVAILABLE
      await page.reload()
      assert.equal(await cards.locator('.podcast-video-badge').count(), 0)
      databaseState = DatabaseState.READ_WRITE
      videoAvailable = true
      await page.reload()
      assert.equal(await cards.getByText('Vidéo 4K', { exact: true }).count(), 2)
    })
    await context.close()
  } finally {
    await browser?.close()
    await app.close()
  }
})
