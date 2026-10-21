import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { chromium } from 'playwright'

// Load the application only after disabling dotenv and all real workers.
process.env.DOTENV_CONFIG_PATH = '/dev/null'
process.env.DISABLE_WORKER = 'true'
process.env.NODE_ENV = 'production'

const outputDirectory = path.resolve(process.env.E2E_OUTPUT || 'test-results/podcast-video')
const feedLastBuildDate = '2026-10-21T08:00:00.000Z'
const episodes = [4, 2].map(episode => ({
  season: 3,
  episode,
  title: episode === 4 ? 'FISSURE — Épisode de qualification' : 'CHARBON — Épisode de qualification',
  description: 'Contenu fictif pour vérifier les liens vidéo du podcast.',
  duration: '26:04',
  image: '/images/charbon-wafer-cover.png',
  episodeLink: `https://podcasts.example/episode-${episode}`,
  audioUrl: null,
  itemGuid: `qualification-3-${episode}`,
  rawPubDate: '2026-10-21',
  feedLastBuildDate,
  hasVideo: true,
  hasPrimaryVideo: true,
  videoFormats: { mp4: true, hls: false }
}))

function platformLinks(episode) {
  return {
    spotify_url: `https://open.spotify.com/episode/qualification${episode}`,
    spotify_video_available: true,
    apple_url: `https://podcasts.apple.com/fr/podcast/id1846531745?i=100078779874${episode}`,
    deezer_url: `https://www.deezer.com/episode/qualification${episode}`,
    youtube_url: `https://www.youtube.com/watch?v=${episode === 4 ? 'WCInqunmc2A' : 'Bbbbbbbbb-1'}`,
    youtube_thumbnail_checked: true,
    feed_last_build: feedLastBuildDate
  }
}

test('Golden Journeys — vidéo des épisodes S3E4 et S3E2', { timeout: 120_000 }, async t => {
  await mkdir(outputDirectory, { recursive: true })
  const { buildApp } = await import('../../server.js')
  const { createDatabaseAvailability, DatabaseState } = await import('../../server/resilience/databaseAvailability.js')
  const links = new Map(episodes.map(episode => [episode.episode, platformLinks(episode.episode)]))
  const outcomes = []
  const errors = []
  let browser
  const query = async (sql, parameters = []) => {
    assert.match(sql.trim(), /^SELECT\b/i, 'The fixture must not accept database writes')
    const row = links.get(parameters[1])
    return { rows: row ? [{ ...row }] : [] }
  }
  const app = await buildApp({
    storageEnabled: false,
    initializeStorage: false,
    wallEnabled: false,
    databaseConfigured: false,
    databaseAdapter: {
      pool: { query },
      async connect() { return { query, release() {} } }
    },
    databaseAvailability: createDatabaseAvailability({
      initialState: DatabaseState.READ_WRITE,
      probe: async () => DatabaseState.READ_WRITE
    }),
    episodeFetcher: async (season, episode) => episodes.find(item => item.season === season && item.episode === episode) || null,
    podcastEpisodesFetcher: async () => episodes,
    youtubeChannelUrl: null,
    youtubeEpisodeResolutionEnabled: true,
    op3PublicStatsEnabled: false
  })
  try {
    const baseURL = await app.listen({ host: '127.0.0.1', port: 0 })
    browser = await chromium.launch({
      chromiumSandbox: true,
      channel: process.env.E2E_BROWSER_CHANNEL || undefined,
      executablePath: process.env.E2E_BROWSER_EXECUTABLE || undefined
    })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const destinations = new Set([...links.values()].flatMap(row => [row.youtube_url, row.spotify_url, row.apple_url]))
    await context.route('**/*', route => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.origin === baseURL && ['GET', 'HEAD'].includes(request.method())) return route.continue()
      if (request.isNavigationRequest() && destinations.has(url.href)) {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>Destination vidéo simulée</h1>' })
      }
      if (url.hostname === 'www.youtube-nocookie.com' && request.resourceType() === 'document') {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<p>Lecteur externe simulé</p>' })
      }
      // No provider, media, analytics or other remote resource leaves the browser.
      return route.abort()
    })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => {
      if (new URL(response.url()).origin === baseURL && response.status() >= 400) {
        errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`)
      }
    })
    const cardFor = destination => page.locator(`a.podcast-platform[href="${destination}"]`)
    const assertS3E4 = async () => {
      const row = platformLinks(4)
      assert.equal(await cardFor(row.youtube_url).locator('.podcast-video-badge').innerText(), 'Vidéo 4K')
      assert.equal(await cardFor(row.spotify_url).locator('.podcast-video-badge').innerText(), 'Vidéo')
      assert.equal(await cardFor(row.apple_url).locator('.podcast-video-badge').innerText(), 'Vidéo')
      assert.match(await page.locator('#episode-video-availability').innerText(), /Apple Podcasts · Spotify · YouTube \(4K\)/)
      assert.equal(await page.locator('.podcast-episode-video iframe').getAttribute('src'), 'https://www.youtube-nocookie.com/embed/WCInqunmc2A?playsinline=1')
    }

    await t.test('Golden Journey 1 — catalogue, S3E4, plateformes vidéo et rechargement', async () => {
      await page.goto(baseURL + '/podcast')
      await page.getByRole('link', { name: 'Écouter le dernier épisode' }).click()
      await page.waitForURL(baseURL + '/podcast/3/4')
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 })
        await assertS3E4()
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No horizontal overflow at ${width}px`)
        const row = platformLinks(4)
        for (const destination of [row.youtube_url, row.spotify_url, row.apple_url]) {
          const link = cardFor(destination)
          await link.scrollIntoViewIfNeeded()
          assert.equal(await link.isVisible(), true)
          assert.equal(await link.getAttribute('target'), '_blank')
          assert.match(await link.getAttribute('rel'), /\bnoopener\b/)
          const [popup] = await Promise.all([context.waitForEvent('page'), link.click()])
          try {
            await popup.waitForLoadState('domcontentloaded')
            assert.equal(popup.url(), destination)
            await popup.getByRole('heading', { name: 'Destination vidéo simulée' }).waitFor()
            assert.equal(await popup.getByRole('heading', { name: 'Destination vidéo simulée' }).isVisible(), true)
          } finally {
            await popup.close()
          }
        }
      }
      await page.reload()
      await assertS3E4()
      assert.deepEqual(await context.cookies(), [])
      assert.equal(await page.evaluate(() => localStorage.length), 0)
      outcomes.push('S3E4 : navigation catalogue, YouTube Vidéo 4K, Spotify/Apple Vidéo, six clics externes simulés, mobile/ordinateur et rechargement : OK')
    })

    await t.test('Golden Journey 2 — lien YouTube absent puis rétabli', async () => {
      links.set(4, { ...platformLinks(4), youtube_url: null })
      try {
        await page.goto(baseURL + '/podcast/3/4')
        assert.equal(await page.locator('a.podcast-platform[href*="youtube.com"]').count(), 0)
        assert.equal(await page.locator('.podcast-episode-video iframe').count(), 0)
        assert.doesNotMatch(await page.locator('#episode-video-availability').innerText(), /YouTube|4K/)
        assert.equal(await cardFor(platformLinks(4).spotify_url).locator('.podcast-video-badge').innerText(), 'Vidéo')
        assert.equal(await cardFor(platformLinks(4).apple_url).locator('.podcast-video-badge').innerText(), 'Vidéo')
        await page.reload()
        assert.doesNotMatch(await page.locator('#episode-video-availability').innerText(), /YouTube|4K/)
      } finally {
        links.set(4, platformLinks(4))
      }
      await page.reload()
      await assertS3E4()
      outcomes.push('S3E4 sans lien YouTube : aucune carte, iframe ou mention YouTube/4K ; Spotify/Apple conservés ; reprise après retour du lien : OK')
    })

    await t.test('Golden Journey 3 — qualités de S3E2 conservées', async () => {
      await page.getByRole('link', { name: 'Tous les épisodes du podcast' }).click()
      await page.locator('.landing-episode[href="/podcast/3/2"]').click()
      await page.waitForURL(baseURL + '/podcast/3/2')
      const row = platformLinks(2)
      assert.equal(await cardFor(row.youtube_url).locator('.podcast-video-badge').innerText(), 'Vidéo 4K')
      assert.equal(await cardFor(row.spotify_url).locator('.podcast-video-badge').innerText(), 'Vidéo 4K')
      assert.equal(await cardFor(row.apple_url).locator('.podcast-video-badge').innerText(), 'Vidéo Full HD')
      await page.reload()
      assert.match(await page.locator('#episode-video-availability').innerText(), /Apple Podcasts \(Full HD\) · Spotify \(4K\) · YouTube \(4K\)/)
      outcomes.push('S3E2 : retour au catalogue, vidéo YouTube/Spotify 4K et Apple Full HD, rechargement : OK')
    })
    assert.deepEqual(errors, [])
    await context.close()
  } finally {
    await browser?.close()
    await app.close()
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0
    const files = ['server.js', 'server/services/podcastVideoAvailability.js', 'server/views/podcast.hbs', 'public/style.css', 'package.json', 'package-lock.json', 'test/e2e/podcast-video.test.mjs']
    const fingerprint = createHash('sha256')
    for (const file of files) fingerprint.update(file + '\0').update(await readFile(file)).update('\0')
    await writeFile(path.join(outputDirectory, 'report.md'), `# Golden Journeys — podcast vidéo

## Summary

${outcomes.length}/3 Golden Journeys terminés ; ${errors.length} erreur(s) navigateur ou ressource locale.
Les échecs d’assertion restent visibles dans la sortie du runner npm.

## Synthèse

- Date UTC : ${new Date().toISOString()}.
- SHA local : ${sha}${dirty ? ' ; checkout modifié, non commité' : ''}.
- Empreinte SHA-256 des fichiers cités en annexe : ${fingerprint.digest('hex')}.
- Commande : npm run test:e2e:podcast-video.
- Environnement : Node ${process.version}, Chromium avec sandbox, Fastify sur loopback.
- Accès public sans authentification ; aucun cookie ni stockage local ajouté au premier parcours.
- RSS et cache PostgreSQL simulés en mémoire ; rechargement vérifié avec les mêmes fixtures,
  sans prétendre valider une persistance PostgreSQL ni un redémarrage.
- Aucun worker, accès à la production ou chargement de .env. Toutes les destinations
  externes et l’iframe YouTube sont interceptées. La lecture réelle et la résolution
  automatique des fournisseurs ne sont pas couvertes ; la qualité est éditoriale.

${outcomes.map(outcome => '- ' + outcome).join('\n')}

## Annexes

Fichiers de l’empreinte : ${files.join(', ')}.
Le rapport reste dans le dossier d’artefacts ; joindre aussi la sortie npm et le lien CI.
`)
  }
})
