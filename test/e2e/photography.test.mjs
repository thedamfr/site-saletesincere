import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'

// Local runs remain isolated. Remote runs are explicit and restricted to fixed
// public hosts, with read-only browser requests. Never read the local .env.
const target = process.env.PHOTOGRAPHY_E2E_TARGET || 'local'
assert.ok(['local', 'staging', 'production'].includes(target), 'PHOTOGRAPHY_E2E_TARGET must be local, staging or production')
const remote = target !== 'local'
const remoteURL = { staging: 'https://staging.saletesincere.fr', production: 'https://saletesincere.fr' }[target]
process.env.DOTENV_CONFIG_PATH = '/dev/null'
process.env.DISABLE_WORKER = 'true'
process.env.NODE_ENV = 'production'

const outputDirectory = path.resolve(process.env.PHOTOGRAPHY_E2E_OUTPUT || (remote ? `test-results/photography-${target}` : 'test-results/photography'))
const command = `${remote ? `PHOTOGRAPHY_E2E_TARGET=${target} ` : ''}npm run test:e2e:photography`
const remoteAssets = [
  '/photography.css',
  '/site-header.css',
  '/site-footer.css',
  '/images/photography/forum-php-2026-conference-480.webp',
  '/images/photography/forum-php-2026-conference-960.webp',
  '/images/photography/forum-php-2026-conference-1600.webp',
  '/images/photography/forum-php-2026-intervenante-480.webp',
  '/images/photography/forum-php-2026-intervenante-960.webp',
  '/images/photography/forum-php-2026-rencontres-480.webp',
  '/images/photography/forum-php-2026-rencontres-960.webp',
  '/images/photography/forum-php-2026-social.jpg'
]

test('Golden Journeys — photographie', { timeout: remote ? 180_000 : 120_000 }, async t => {
  await mkdir(outputDirectory, { recursive: true })
  let app
  if (!remote) {
    const { buildApp } = await import('../../server.js')
    const unavailableDatabase = async () => { throw new Error('Database intentionally unavailable in E2E') }
    app = await buildApp({
      storageEnabled: false,
      initializeStorage: false,
      wallEnabled: false,
      databaseConfigured: false,
      databaseAdapter: { query: unavailableDatabase, connect: unavailableDatabase },
      podcastEpisodesFetcher: async () => [],
      op3PublicStatsEnabled: false
    })
  }
  let browser
  const outcomes = []
  const errors = []
  const verifiedAssets = []
  let release
  let remoteChecksPassed = false
  try {
    const baseURL = remote ? remoteURL : await app.listen({ host: '127.0.0.1', port: 0 })
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      channel: process.env.E2E_BROWSER_CHANNEL || undefined,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined
    })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    if (remote) {
      await context.route('**/*', route => {
        if (['GET', 'HEAD'].includes(route.request().method()) && !new URL(route.request().url()).pathname.startsWith('/podcast')) return route.continue()
        errors.push(`Potentially stateful browser request blocked: ${route.request().method()} ${new URL(route.request().url()).pathname}`)
        return route.abort()
      })
      const response = await context.request.get(baseURL + '/photographie', { maxRedirects: 0 })
      assert.equal(response.status(), 200)
      assert.equal(response.url(), remoteURL + '/photographie')
      assert.equal(new URL(response.url()).protocol, 'https:')
      if (target === 'staging') {
        assert.match(response.headers()['x-robots-tag'] || '', /\bnoindex\b/i, 'Staging must remain excluded from indexing')
      }
      const healthResponse = await context.request.get(baseURL + '/health', { maxRedirects: 0 })
      assert.equal(healthResponse.status(), 200)
      const health = await healthResponse.json()
      assert.equal(health.ok, true)
      assert.equal(health.mode, 'normal')
      assert.equal(health.database?.state, 'read_write')
      assert.equal(health.episodeWorker?.state, 'ready')
      assert.match(health.release?.sourceCommit || '', /^[a-f0-9]{40}$/)
      assert.match(health.release?.digest || '', /^sha256:[a-f0-9]{64}$/)
      // Only retain public release identifiers, never the full health payload.
      release = { sourceCommit: health.release.sourceCommit, digest: health.release.digest }
      for (const asset of remoteAssets) {
        const assetResponse = await context.request.get(baseURL + asset, { maxRedirects: 0 })
        assert.equal(assetResponse.status(), 200, `Missing ${target} asset: ${asset}`)
        assert.equal(new URL(assetResponse.url()).origin, remoteURL)
        const expectedHash = createHash('sha256').update(await readFile(path.join('public', asset))).digest('hex')
        const actualHash = createHash('sha256').update(await assetResponse.body()).digest('hex')
        assert.equal(actualHash, expectedHash, `${target} must serve the candidate bytes: ${asset}`)
        verifiedAssets.push({ asset, sha256: actualHash })
      }
      remoteChecksPassed = true
    }
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => {
      if (response.url().startsWith(baseURL) && response.status() >= 400) {
        errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`)
      }
    })

    await t.test('Golden Journey 1 — accueil, références, offre, contact et retour', async () => {
      await page.goto(baseURL)
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 })
        const navigationFits = await page.getByRole('navigation', { name: 'Navigation principale', exact: true }).getByRole('link').evaluateAll(links => links.every(link => {
          const bounds = link.getBoundingClientRect()
          return bounds.left >= 0 && bounds.right <= innerWidth
        }))
        assert.ok(navigationFits, `Home navigation must remain visible at ${width}px`)
        if (width === 320) await page.screenshot({ path: path.join(outputDirectory, 'home-320.png') })
      }
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.getByRole('navigation', { name: 'Navigation principale', exact: true }).getByRole('link', { name: 'Photographie', exact: true }).click()
      await page.waitForURL('**/photographie')
      assert.equal(new URL(page.url()).origin, baseURL)
      assert.match(await page.title(), /Photographie événementielle/)
      const primaryNavigation = page.getByRole('navigation', { name: 'Navigation principale', exact: true })
      const pageNavigation = page.getByRole('navigation', { name: 'Sur cette page', exact: true })
      assert.deepEqual(await primaryNavigation.getByRole('link').allTextContents(), ['Photographie', 'Podcast', 'À propos', 'Contact'])
      assert.equal(await primaryNavigation.getByRole('link', { name: 'Photographie', exact: true }).getAttribute('aria-current'), 'page')
      assert.deepEqual(await pageNavigation.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('href'))),
        ['#photo-reports', '#photo-method', '#photo-contact'])
      assert.equal(await page.getByRole('contentinfo').getByRole('link', { name: 'À propos', exact: true }).count(), 1)
      const earlyContact = page.locator('.photo-intro').getByRole('link', { name: 'Parlons de votre événement' })
      assert.equal(await earlyContact.count(), 1, 'Contact must be offered in the introduction')
      assert.equal(await earlyContact.getAttribute('href'), 'mailto:damien@saletesincere.fr')
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 667 })
        await page.evaluate(() => scrollTo(0, 0))
        const bounds = await earlyContact.boundingBox()
        assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 667, `Contact must be visible without scrolling at ${width}px`)
      }
      await page.setViewportSize({ width: 1440, height: 1000 })
      for (const name of ['Forum PHP 2026', 'dotAI / dotJS', 'Hodéfi Awards', 'Les Masters de Feu']) {
        assert.equal(await page.getByRole('heading', { name, exact: true }).count(), 1)
      }
      const opening = page.locator('.photo-hero-photo')
      assert.equal(await opening.getAttribute('src'), '/images/photography/forum-php-2026-conference-1600.webp')
      assert.match(await opening.getAttribute('alt'), /Forum PHP 2026/)
      assert.deepEqual((await opening.getAttribute('srcset')).split(',').map(candidate => Number(candidate.trim().split(/\s+/)[1].replace('w', ''))), [480, 960, 1600])
      await pageNavigation.getByRole('link', { name: 'Reportages', exact: true }).click()
      assert.equal(new URL(page.url()).hash, '#photo-reports')
      assert.equal(await page.locator('#photo-reports').getByRole('heading', { name: 'Forum PHP 2026', exact: true }).isVisible(), true)
      assert.equal(await page.getByRole('link', { name: 'Parlons de votre événement' }).getAttribute('href'), 'mailto:damien@saletesincere.fr')
      assert.match(await page.locator('.photo-delivery').innerText(), /20 ou 40 photos/)
      assert.match(await page.locator('.photo-delivery').innerText(), /Juste après la prise de vue/)
      assert.match(await page.locator('.photo-delivery').innerText(), /consentement/)
      await pageNavigation.getByRole('link', { name: 'L’approche', exact: true }).click()
      assert.equal(new URL(page.url()).hash, '#photo-method')
      assert.equal(await page.locator('#photo-method').isVisible(), true)
      await pageNavigation.getByRole('link', { name: 'Parlons de votre projet' }).click()
      assert.equal(new URL(page.url()).hash, '#photo-contact')
      assert.equal(await page.getByRole('link', { name: 'Écrire à Damien' }).getAttribute('href'), 'mailto:damien@saletesincere.fr')
      await page.getByRole('banner').getByRole('link', { name: 'Accueil Saleté Sincère', exact: true }).click()
      await page.waitForURL(baseURL + '/')
      assert.match(await page.locator('h1').innerText(), /On gratte la surface/i)
      await page.goto(baseURL + '/photographie')
      const podcastLink = page.getByRole('contentinfo').getByRole('link', { name: 'Podcast', exact: true })
      assert.equal(await podcastLink.getAttribute('href'), '/podcast')
      // GET /podcast can enqueue episode work on deployed environments.
      // Exercise that destination only against our isolated local server.
      if (!remote) {
        await podcastLink.click()
        await page.waitForURL('**/podcast')
        assert.match(await page.locator('h1').innerText(), /Charbon|Wafer/i)
      }
      outcomes.push(`Accueil → photographie → Forum PHP 2026 et références existantes → offre et contact → accueil ; ${remote ? 'lien podcast vérifié sans navigation distante' : 'navigation podcast locale'} : OK`)
    })

    await t.test('Golden Journey 2 — galerie au clavier, photos complètes et lecture responsive', async () => {
      await page.goto(baseURL + '/photographie')
      await page.keyboard.press('Tab')
      assert.equal(await page.locator('.photo-skip-link').evaluate(el => el === document.activeElement), true)
      await page.keyboard.press('Enter')
      assert.equal(new URL(page.url()).hash, '#contenu')
      const summary = page.locator('summary')
      await summary.focus()
      await page.keyboard.press('Enter')
      assert.equal(await page.locator('details').evaluate(el => el.open), true)
      assert.equal(await page.locator('main img').count(), 14)
      for (const image of await page.locator('main img').all()) {
        await image.scrollIntoViewIfNeeded()
        await image.evaluate(el => el.decode())
        const size = await image.evaluate(el => ({
          alt: el.alt, width: el.naturalWidth, height: el.naturalHeight,
          declaredRatio: Number(el.getAttribute('width')) / Number(el.getAttribute('height'))
        }))
        assert.ok(size.alt.length > 0 && size.width > 0)
        assert.ok(Math.abs(size.width / size.height - size.declaredRatio) < 0.01)
      }
      await summary.focus()
      await page.keyboard.press('Space')
      assert.equal(await page.locator('details').evaluate(el => el.open), false)
      await page.locator('h1').click()
      for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 })
        await page.evaluate(() => window.scrollTo(0, 0))
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Overflow at ${width}px`)
        const forumImages = page.locator('main img[src*="forum-php-2026-"]')
        assert.equal(await forumImages.count(), 3)
        for (const image of await forumImages.all()) {
          await image.scrollIntoViewIfNeeded()
          await image.evaluate(el => el.decode())
          const framing = await image.evaluate(el => {
            const bounds = el.getBoundingClientRect()
            return {
              source: el.getAttribute('src'),
              naturalRatio: el.naturalWidth / el.naturalHeight,
              displayedRatio: bounds.width / bounds.height,
              left: bounds.left,
              right: bounds.right,
              alt: el.alt
            }
          })
          assert.ok(Math.abs(framing.naturalRatio - framing.displayedRatio) < 0.01, `Photograph must remain uncropped at ${width}px: ${framing.source}`)
          assert.ok(framing.left >= 0 && framing.right <= width, `Photograph must fit the viewport at ${width}px: ${framing.source}`)
          assert.match(framing.alt, /Forum PHP 2026/)
        }
        if (width <= 390) {
          const speaker = await page.locator('img[src$="forum-php-2026-intervenante-960.webp"]').boundingBox()
          const meetings = await page.locator('img[src$="forum-php-2026-rencontres-960.webp"]').boundingBox()
          assert.ok(speaker.width >= width * 0.75, `The speaker portrait must remain readable at ${width}px`)
          assert.ok(meetings.y >= speaker.y + speaker.height, `Forum photographs must stack in reading order at ${width}px`)
        }
        if (width === 1440 || width === 390) {
          await page.locator('.photo-hero').screenshot({ path: path.join(outputDirectory, `photography-opening-${width}.png`) })
          await page.locator('#photo-reports').screenshot({ path: path.join(outputDirectory, `photography-forum-${width}.png`) })
          await page.screenshot({ path: path.join(outputDirectory, `photography-${width}.png`), fullPage: true })
        }
      }
      await page.reload()
      assert.equal(await page.locator('details').evaluate(el => el.open), false)
      assert.deepEqual(await context.cookies(), [])
      assert.equal(await page.evaluate(() => localStorage.length), 0)
      outcomes.push('Clavier, chargement des 14 photos, Forum PHP sans recadrage aux formats 1440/768/390/320, empilement mobile et rechargement sans stockage : OK')
    })

    await t.test(`Golden Journey 3 — consultation et reprise sans JavaScript${remote ? '' : ' ni base'}`, async () => {
      const noScriptContext = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } })
      try {
        if (remote) {
          await noScriptContext.route('**/*', route => {
            if (['GET', 'HEAD'].includes(route.request().method()) && !new URL(route.request().url()).pathname.startsWith('/podcast')) return route.continue()
            errors.push(`Potentially stateful browser request blocked: ${route.request().method()} ${new URL(route.request().url()).pathname}`)
            return route.abort()
          })
        }
        const noScriptPage = await noScriptContext.newPage()
        const response = await noScriptPage.goto(baseURL + '/photographie')
        assert.equal(response.status(), 200)
        assert.equal(await noScriptPage.getByRole('navigation', { name: 'Navigation principale', exact: true }).getByRole('link', { name: 'Photographie', exact: true }).getAttribute('aria-current'), 'page')
        const pageNavigation = noScriptPage.getByRole('navigation', { name: 'Sur cette page', exact: true })
        await pageNavigation.getByRole('link', { name: 'Reportages', exact: true }).click()
        assert.equal(new URL(noScriptPage.url()).hash, '#photo-reports')
        assert.equal(await noScriptPage.locator('#photo-reports').getByRole('heading', { name: 'Forum PHP 2026', exact: true }).isVisible(), true)
        await noScriptPage.locator('summary').click()
        assert.equal(await noScriptPage.locator('details').getAttribute('open'), '')
        assert.equal(await noScriptPage.locator('#photo-dot-extra').isVisible(), true)
        await pageNavigation.getByRole('link', { name: 'L’approche', exact: true }).click()
        assert.equal(new URL(noScriptPage.url()).hash, '#photo-method')
        await pageNavigation.getByRole('link', { name: 'Parlons de votre projet' }).click()
        assert.equal(await noScriptPage.getByRole('link', { name: 'Écrire à Damien' }).isVisible(), true)
        await noScriptPage.reload()
        assert.equal(await noScriptPage.locator('details').getAttribute('open'), null)
        await noScriptPage.getByRole('banner').getByRole('link', { name: 'Accueil Saleté Sincère', exact: true }).click()
        assert.match(await noScriptPage.locator('h1').innerText(), /On gratte la surface/i)
        outcomes.push(`Sans JavaScript${remote ? '' : ' et sans base'} : lecture, galerie, contact, rechargement et retour : OK`)
      } finally {
        await noScriptContext.close()
      }
    })
    assert.deepEqual(errors, [])
    await context.close()
  } finally {
    await browser?.close()
    await app?.close()
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0
    const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
      .split('\0').filter(file => /^(server\/|public\/|test\/|scripts\/|server\.js$|style\.css$|package(-lock)?\.json$)/.test(file)))].sort()
    const fingerprint = createHash('sha256')
    for (const file of files) fingerprint.update(file + '\0').update(await readFile(file)).update('\0')
    await writeFile(path.join(outputDirectory, 'report.md'), `# Golden Journeys — photographie

## Summary

${outcomes.length}/3 Golden Journeys terminés. ${errors.length} erreur(s) navigateur ou ressource ${remote ? target : 'locale'}.
Les échecs d’assertion éventuels restent visibles dans la sortie du runner npm.
${remote ? `Contrôles HTTPS${target === 'staging' ? ', noindex' : ''}, santé, identifiants publics de l’image et ${remoteAssets.length} ressources : ${remoteChecksPassed ? 'réussis' : 'incomplets ou échoués'}.` : ''}

## Synthèse

- Date UTC : ${new Date().toISOString()}
- Révision du checkout local : ${sha}${dirty ? ' ; checkout modifié, non commité' : ''}.
- Empreinte SHA-256 des sources, tests et ressources locales : ${fingerprint.digest('hex')}.
- Commande : ${command}.
- Environnement : Node ${process.version}, Chromium avec sandbox, ${remote ? remoteURL : 'HTTP loopback'}.
${remote ? `- Image déclarée par /health : commit ${release?.sourceCommit || 'non vérifié'}, digest ${release?.digest || 'non vérifié'}.
- Contrôle distant avec base et worker actifs ; aucune promesse de fonctionnement sans base n’est déduite de ce résultat.
- CSS et images comparés aux fichiers locaux ; template vérifié par les parcours, sans comparaison intégrale du HTML.
- Seules les requêtes GET/HEAD du navigateur sont autorisées ; aucun état de connexion n’est chargé.
- L’empreinte locale identifie les fichiers utilisés pour ce test ; elle ne prouve pas à elle seule le contenu déployé.` : '- Aucune base, aucun worker ni stockage objet. RSS simulé vide.'}
- La destination podcast est visitée uniquement en local ; en mode distant, son lien est vérifié sans requête car GET /podcast peut déclencher un traitement.
- Aucun envoi d’email, aucune écriture métier déclenchée par les scénarios. Le QR code et le consentement sont
  présentés comme service ; leur application externe n’est pas testée ici.
- Rechargement : galerie refermée ; aucun cookie ni état local ajouté.

${outcomes.map(outcome => '- ' + outcome).join('\n')}

## Annexes

Captures complètes : photography-1440.png, photography-390.png et home-320.png.
Détails de l’ouverture et du Forum PHP : photography-opening-1440.png,
photography-opening-390.png, photography-forum-1440.png et photography-forum-390.png.
Ces fichiers restent dans ce dossier ignoré par Git.
${remote ? `Ressources servies dont le SHA-256 est identique au fichier local (${verifiedAssets.length}/${remoteAssets.length}) :

${verifiedAssets.map(({ asset, sha256 }) => `- ${asset} : ${sha256}`).join('\n')}

Ce rapport qualifie uniquement ${target} à cette date ; il ne remplace pas la vérification du digest attendu, des pods et du rollout.` : 'Ce rapport local ne constitue pas une validation en production ni une preuve sur un commit publié.'}
`)
  }
})
