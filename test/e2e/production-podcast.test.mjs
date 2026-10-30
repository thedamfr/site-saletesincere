import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { chromium } from 'playwright'

// Local by default; deployed checks require an explicit, fixed public target.
// No environment file, credentials, real database or worker is loaded locally.
const target = process.env.PRODUCTION_PODCAST_E2E_TARGET || 'local'
assert.ok(['local', 'staging', 'production'].includes(target), 'PRODUCTION_PODCAST_E2E_TARGET must be local, staging or production')
const remote = target !== 'local'
const remoteURL = { staging: 'https://staging.saletesincere.fr', production: 'https://saletesincere.fr' }[target]
process.env.DOTENV_CONFIG_PATH = '/dev/null'
process.env.DISABLE_WORKER = 'true'
process.env.NODE_ENV = 'production'

const offerPath = '/offre-production-podcast/'
const canonical = `https://saletesincere.fr${offerPath}`
const footerLabel = "Besoin d'un producteur sur mon podcast ?"
const title = 'Ton podcast, sans y passer tes semaines.'
const outputDirectory = path.resolve(process.env.PRODUCTION_PODCAST_E2E_OUTPUT || `test-results/production-podcast${remote ? `-${target}` : ''}`)
const command = `${remote ? `PRODUCTION_PODCAST_E2E_TARGET=${target} ` : ''}npm run test:e2e:production-podcast`
const episode = {
  season: 3, episode: 4, title: 'Épisode de qualification',
  description: 'Entretien fictif pour le parcours de découverte de l’offre.',
  duration: '26:04', image: '/images/charbon-wafer-cover.png',
  episodeLink: 'https://podcasts.example/episode', audioUrl: null,
  itemGuid: 'production-podcast-e2e-3-4', rawPubDate: '2026-10-21',
  feedLastBuildDate: '2026-10-21T08:00:00.000Z', hasVideo: false,
  videoFormats: { mp4: false, hls: false }
}

test('Golden Journeys — offre de production de podcast', { timeout: remote ? 240_000 : 180_000 }, async t => {
  await mkdir(outputDirectory, { recursive: true })
  const outcomes = []
  const errors = []
  const verifiedAssets = []
  let app
  let browser
  let release
  let rssCalls = 0
  let databaseCalls = 0
  if (!remote) {
    const { buildApp } = await import('../../server.js')
    const { createDatabaseAvailability, DatabaseState } = await import('../../server/resilience/databaseAvailability.js')
    const unavailableDatabase = async () => {
      databaseCalls++
      throw new Error('Database intentionally unavailable in E2E')
    }
    app = await buildApp({
      storageEnabled: false, initializeStorage: false, wallEnabled: false,
      databaseConfigured: false,
      databaseAdapter: { pool: { query: unavailableDatabase }, connect: unavailableDatabase },
      databaseAvailability: createDatabaseAvailability({
        initialState: DatabaseState.UNAVAILABLE,
        probe: async () => DatabaseState.UNAVAILABLE
      }),
      podcastEpisodesFetcher: async () => { rssCalls++; return [episode] },
      episodeFetcher: async (season, number) => {
        rssCalls++
        return season === episode.season && number === episode.episode ? episode : null
      },
      op3PublicStatsEnabled: false, youtubeEpisodeResolutionEnabled: false
    })
  }

  try {
    const baseURL = remote ? remoteURL : await app.listen({ host: '127.0.0.1', port: 0 })
    browser = await chromium.launch({
      headless: true, chromiumSandbox: true,
      channel: process.env.E2E_BROWSER_CHANNEL || undefined,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.E2E_BROWSER_EXECUTABLE || undefined
    })
    const protectRequests = async context => context.route('**/*', route => {
      const request = route.request()
      const url = new URL(request.url())
      if (!['GET', 'HEAD'].includes(request.method()) || (remote && url.origin === baseURL && url.pathname.startsWith('/podcast'))) {
        errors.push(`Potentially stateful request blocked: ${request.method()} ${url.pathname}`)
        return route.abort()
      }
      if (url.origin === baseURL || ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return route.continue()
      // No external player, analytics, platform or media request is necessary.
      return route.abort()
    })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    await protectRequests(context)
    const page = await context.newPage()
    const observePage = currentPage => {
      currentPage.on('pageerror', error => errors.push(error.message))
      currentPage.on('response', response => {
        if (new URL(response.url()).origin === baseURL && response.status() >= 400) {
          errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`)
        }
      })
    }
    observePage(page)

    if (remote) {
      const response = await context.request.get(baseURL + '/health', { maxRedirects: 0 })
      assert.equal(response.status(), 200)
      const health = await response.json()
      assert.equal(health.ok, true)
      assert.equal(health.mode, 'normal')
      assert.equal(health.database?.state, 'read_write')
      assert.equal(health.episodeWorker?.state, 'ready')
      assert.match(health.release?.sourceCommit || '', /^[a-f0-9]{40}$/)
      assert.match(health.release?.digest || '', /^sha256:[a-f0-9]{64}$/)
      // Retain only public image identifiers, never the complete health payload.
      release = { sourceCommit: health.release.sourceCommit, digest: health.release.digest }
    }

    await t.test('Golden Journey 1 — découvrir l’offre depuis chaque famille de footer', async () => {
      const sources = ['/', '/photographie', '/damien-cavailles', '/laboratoire-du-geste']
      // Deployed GET /podcast can enqueue work; exercise those routes locally only.
      if (!remote) sources.push('/podcast', '/podcast/3/4')
      for (const source of sources) {
        await page.goto(baseURL + source)
        const link = page.locator('footer').getByRole('link', { name: footerLabel, exact: true })
        assert.equal(await link.count(), 1, `One offer entry in ${source}`)
        assert.equal(await link.getAttribute('href'), offerPath)
        assert.equal(await page.getByRole('navigation', { name: 'Navigation principale', exact: true }).locator(`a[href="${offerPath}"]`).count(), 0)
        await page.setViewportSize({ width: 320, height: 844 })
        await link.scrollIntoViewIfNeeded()
        const bounds = await link.boundingBox()
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 320, `Footer offer link fits at 320px: ${source}`)
        if (source === '/') {
          assert.equal(await page.locator('main').getByRole('link', { name: footerLabel, exact: true }).count(), 0)
          await page.locator('footer').screenshot({ path: path.join(outputDirectory, 'home-footer-320.png') })
        }
        await link.click()
        await page.waitForURL(baseURL + offerPath)
        assert.equal((await page.locator('h1').innerText()).replace(/\s+/g, ' ').trim(), title)
      }
      await page.getByRole('banner').getByRole('link', { name: 'Accueil Saleté Sincère', exact: true }).click()
      await page.waitForURL(baseURL + '/')
      assert.match(await page.locator('h1').innerText(), /On gratte la surface/i)
      outcomes.push(`Découverte depuis ${sources.join(', ')} → offre → retour accueil ; libellé complet à 320 px : OK`)
    })

    await t.test('Golden Journey 2 — comprendre les formats puis demander une session gratuite', async () => {
      await page.goto(baseURL + offerPath)
      const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ')
      assert.match(text, /Débloquer une production/)
      assert.match(text, /500\s*€\s*HT/)
      assert.match(text, /Produire une saison/)
      assert.match(text, /10\s*000 à 20\s*000\s*€\s*HT/)
      assert.match(text, /validation éditoriale/)
      assert.match(text, /sans engagement/i)
      assert.match(text, /deux fois par an/)
      const references = [
        { name: 'Voir l’épisode', href: 'https://podcasts.saletesincere.fr/@charbonwafer/episodes/charbon-les-petits-de-douai-qui-travaillent-avec-intel-et-amd' },
        { name: 'Voir le webinaire', href: 'https://app.livestorm.co/p/bf678e23-b016-4c5e-994a-663b6cfa1e90' }
      ]
      for (const reference of references) {
        const link = page.locator('main').getByRole('link', { name: reference.name, exact: true })
        assert.equal(await link.count(), 1)
        assert.equal(await link.getAttribute('href'), reference.href)
      }
      const primary = page.getByRole('link', { name: 'Faire le point sur mon podcast', exact: true })
      assert.equal(await primary.getAttribute('href'), '#session')
      await primary.click()
      assert.equal(new URL(page.url()).hash, '#session')
      assert.equal(await page.locator('#session').getByRole('heading', { name: 'Une heure pour faire le point sur ton podcast', exact: true }).isVisible(), true)
      const contact = page.getByRole('link', { name: 'Réserver une heure avec Damien', exact: true })
      const href = await contact.getAttribute('href')
      const mail = new URL(href)
      assert.equal(mail.protocol, 'mailto:')
      assert.equal(mail.pathname, 'damien@saletesincere.fr')
      assert.match(mail.searchParams.get('subject') || '', /podcast|session/i)
      assert.match(mail.searchParams.get('body') || '', /(?:une|1) heure/i)
      assert.match(await page.locator('#session').innerText(), /damien@saletesincere\.fr/)
      assert.match(await page.locator('#session').innerText(), /créneau|par (?:e-?mail|courriel)/i)
      assert.equal(await page.locator('#session form').count(), 0, 'The free session does not impose a budget qualification form')
      // Capture actual activation in the document before any email client opens.
      await page.evaluate(() => {
        window.__activatedMailto = null
        document.addEventListener('click', event => {
          const link = event.target.closest('a[href^="mailto:"]')
          if (!link) return
          event.preventDefault()
          window.__activatedMailto = link.getAttribute('href')
        }, { capture: true })
      })
      await contact.click()
      assert.equal(await page.evaluate(() => window.__activatedMailto), href)
      assert.equal(new URL(page.url()).hash, '#session')
      await page.reload()
      assert.equal(await contact.getAttribute('href'), href)
      assert.equal(await contact.isVisible(), true)
      assert.deepEqual(await context.cookies(), [])
      assert.equal(await page.evaluate(() => localStorage.length), 0)
      outcomes.push('Formats, prix, validation éditoriale et liens OCCT/EuraCreative → session gratuite → activation mailto interceptée → rechargement sans stockage : OK')
    })

    await t.test('Golden Journey 3 — partager une URL stable et charger ses ressources', async () => {
      const rssBefore = rssCalls
      const databaseBefore = databaseCalls
      const redirect = await context.request.get(`${baseURL}/offre-production-podcast?utm_source=prescripteur&tag=a&tag=b`, { maxRedirects: 0 })
      assert.equal(redirect.status(), 301)
      const destination = new URL(redirect.headers().location, baseURL)
      assert.equal(destination.origin, baseURL)
      assert.equal(destination.pathname, offerPath)
      assert.equal(destination.searchParams.get('utm_source'), 'prescripteur')
      assert.deepEqual(destination.searchParams.getAll('tag'), ['a', 'b'])
      const response = await page.goto(destination.href)
      assert.equal(response.status(), 200)
      if (target === 'staging') assert.match(response.headers()['x-robots-tag'] || '', /\bnoindex\b/i)
      assert.equal(await page.title(), 'Production de podcast avec Damien Cavaillès | Saleté Sincère')
      assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), canonical)
      assert.equal(await page.locator('meta[property="og:url"]').getAttribute('content'), canonical)
      assert.match(await page.locator('meta[name="description"]').getAttribute('content'), /podcast/i)
      assert.equal(await page.locator('meta[name="twitter:card"]').getAttribute('content'), 'summary_large_image')
      for (const selector of ['meta[property="og:title"]', 'meta[property="og:description"]', 'meta[name="twitter:title"]', 'meta[name="twitter:description"]']) {
        assert.ok((await page.locator(selector).getAttribute('content')).trim().length > 0)
      }
      const socialImage = new URL(await page.locator('meta[property="og:image"]').getAttribute('content'))
      assert.equal(socialImage.origin, 'https://saletesincere.fr')
      assert.equal(await page.locator('meta[name="twitter:image"]').getAttribute('content'), socialImage.href)
      const assets = await page.locator('link[rel="stylesheet"], main img').evaluateAll(elements => elements.map(element => element.getAttribute('href') || element.getAttribute('src')))
      const localAssets = [...new Set([...assets.filter(asset => asset.startsWith('/')), socialImage.pathname])]
      for (const asset of localAssets) {
        const assetResponse = await context.request.get(baseURL + asset, { maxRedirects: 0 })
        assert.equal(assetResponse.status(), 200, `Missing offer asset: ${asset}`)
        assert.equal(new URL(assetResponse.url()).origin, baseURL)
        const pathname = new URL(asset, baseURL).pathname
        const actualHash = createHash('sha256').update(await assetResponse.body()).digest('hex')
        const expectedHash = createHash('sha256').update(await readFile(path.join('public', pathname))).digest('hex')
        assert.equal(actualHash, expectedHash, `Asset must match candidate: ${pathname}`)
        verifiedAssets.push({ asset: pathname, sha256: actualHash })
      }
      const images = page.locator('main img')
      assert.ok(await images.count() > 0, 'The offer includes existing photographs')
      for (const image of await images.all()) {
        await image.scrollIntoViewIfNeeded()
        await image.evaluate(element => element.decode())
        assert.equal(await image.evaluate(element => Boolean(element.alt.trim()) && element.naturalWidth > 0 && element.naturalHeight > 0), true)
      }
      if (!remote) {
        assert.equal(rssCalls, rssBefore, 'Offer and its resources must not fetch RSS')
        assert.equal(databaseCalls, databaseBefore, 'Offer and its resources must not query PostgreSQL')
      }
      outcomes.push(`Lien partagé, redirection 301 avec paramètres, canonical et partage social, ${localAssets.length} ressources identiques à la candidate${remote ? '' : ', sans appel RSS ou base'} : OK`)
    })

    await t.test('Golden Journey 4 — lecture responsive et accès au clavier', async () => {
      await page.goto(baseURL + offerPath)
      await page.keyboard.press('Tab')
      const skip = page.getByRole('link', { name: 'Aller au contenu', exact: true })
      assert.equal(await skip.evaluate(element => element === document.activeElement), true)
      await page.keyboard.press('Enter')
      assert.equal(new URL(page.url()).hash, '#contenu')
      const primary = page.getByRole('link', { name: 'Faire le point sur mon podcast', exact: true })
      for (let step = 0; step < 30 && !await primary.evaluate(element => element === document.activeElement); step++) await page.keyboard.press('Tab')
      assert.equal(await primary.evaluate(element => element === document.activeElement), true)
      const focus = await primary.evaluate(element => {
        const style = getComputedStyle(element)
        return { style: style.outlineStyle, width: parseFloat(style.outlineWidth), shadow: style.boxShadow }
      })
      assert.ok((focus.style !== 'none' && focus.width > 0) || focus.shadow !== 'none', 'Keyboard focus must remain visible')
      await page.keyboard.press('Enter')
      assert.equal(new URL(page.url()).hash, '#session')
      const contact = page.getByRole('link', { name: 'Réserver une heure avec Damien', exact: true })
      for (let step = 0; step < 40 && !await contact.evaluate(element => element === document.activeElement); step++) await page.keyboard.press('Tab')
      assert.equal(await contact.evaluate(element => element === document.activeElement), true)
      await page.locator('h1').click()
      for (const image of await page.locator('main img').all()) {
        await image.scrollIntoViewIfNeeded()
        await image.evaluate(element => element.decode())
      }
      await page.evaluate(async () => {
        if (document.fonts) await document.fonts.ready
        scrollTo(0, 0)
      })
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 1000 })
        await page.evaluate(() => scrollTo(0, 0))
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No horizontal overflow at ${width}px`)
        const navigationFits = await page.getByRole('navigation', { name: 'Navigation principale', exact: true }).getByRole('link').evaluateAll(links => links.every(link => {
          const bounds = link.getBoundingClientRect()
          return bounds.left >= 0 && bounds.right <= innerWidth
        }))
        assert.ok(navigationFits, `Header navigation fits at ${width}px`)
        if (width === 390 || width === 1440) {
          await page.screenshot({ path: path.join(outputDirectory, `production-podcast-${width}.png`), fullPage: true })
          await page.locator('#session').screenshot({ path: path.join(outputDirectory, `session-${width}.png`) })
        }
      }
      outcomes.push('Clavier : lien d’évitement, focus visible, CTA et contact ; lecture sans débordement à 320/390/768/1440 px : OK')
    })

    await t.test(`Golden Journey 5 — lecture et reprise sans JavaScript${remote ? '' : ' ni base'}`, async () => {
      const noScriptContext = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } })
      try {
        await protectRequests(noScriptContext)
        const noScriptPage = await noScriptContext.newPage()
        observePage(noScriptPage)
        const response = await noScriptPage.goto(baseURL + offerPath)
        assert.equal(response.status(), 200)
        assert.equal((await noScriptPage.locator('h1').innerText()).replace(/\s+/g, ' ').trim(), title)
        await noScriptPage.getByRole('link', { name: 'Faire le point sur mon podcast', exact: true }).click()
        assert.equal(new URL(noScriptPage.url()).hash, '#session')
        const contact = noScriptPage.getByRole('link', { name: 'Réserver une heure avec Damien', exact: true })
        assert.equal(await contact.isVisible(), true)
        assert.match(await contact.getAttribute('href'), /^mailto:damien@saletesincere\.fr\?/)
        const visibleEmail = noScriptPage.getByRole('link', { name: 'damien@saletesincere.fr', exact: true })
        assert.equal(await visibleEmail.getAttribute('href'), 'mailto:damien@saletesincere.fr')
        assert.equal(await visibleEmail.isVisible(), true)
        await noScriptPage.reload()
        assert.equal(await contact.isVisible(), true)
        await noScriptPage.getByRole('banner').getByRole('link', { name: 'Accueil Saleté Sincère', exact: true }).click()
        await noScriptPage.waitForURL(baseURL + '/')
        await noScriptPage.locator('footer').getByRole('link', { name: footerLabel, exact: true }).click()
        await noScriptPage.waitForURL(baseURL + offerPath)
        outcomes.push(`Sans JavaScript${remote ? '' : ' ni base'} : accès direct, session, email lisible, rechargement et aller-retour accueil : OK`)
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
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0
    const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
      .split('\0').filter(file => /^(server\/|public\/|test\/|scripts\/|content\/|server\.js$|style\.css$|package(-lock)?\.json$)/.test(file)))].sort()
    const fingerprint = createHash('sha256')
    for (const file of files) fingerprint.update(file + '\0').update(await readFile(file)).update('\0')
    await writeFile(path.join(outputDirectory, 'report.md'), `# Golden Journeys — offre de production de podcast

## Summary

${outcomes.length}/5 Golden Journeys terminés ; ${errors.length} erreur(s) navigateur ou ressource ${remote ? target : 'locale'}.
Les échecs d’assertion restent visibles dans la sortie du runner npm. ${remote ? 'Qualification distante à la date ci-dessous.' : 'Qualification locale isolée, sans validation de production.'}

## Synthèse

- Date UTC : ${new Date().toISOString()}.
- Révision locale : ${sha}${dirty ? ' ; checkout modifié, non commité' : ''}.
- Arbre du commit local : ${tree}.
- Empreinte SHA-256 des sources, contenus, ressources et tests locaux : ${fingerprint.digest('hex')}.
- Commande : ${command}.
- Environnement : Node ${process.version}, Chromium avec sandbox, ${remote ? remoteURL : 'Fastify sur loopback'}.
${remote ? `- Image déclarée par /health : commit ${release?.sourceCommit || 'non vérifié'}, digest ${release?.digest || 'non vérifié'}.
- Base et worker distants actifs ; ce contrôle ne prouve pas le fonctionnement distant sans base.
- CSS, images et image sociale comparés aux fichiers locaux ; la seule empreinte locale ne prouve pas le contenu déployé.
- Routes podcast et épisode exclues à distance car leur GET peut mettre en file un travail ; leurs footers sont qualifiés localement.` : `- Aucune base, aucun worker ni stockage objet ; RSS simulé pour le catalogue et un épisode. Appels à l’adaptateur PostgreSQL : ${databaseCalls}.
- Le parcours de partage vérifie que l’offre ne sollicite ni RSS ni PostgreSQL. Aucun .env n’est chargé.`}
- Accès public sans authentification, rechargement et absence de cookie/stockage local vérifiés ; aucune donnée métier à persister.
- Seuls GET/HEAD sont autorisés par le navigateur. Aucun formulaire, email ou réservation n’est envoyé.
- Activation email interceptée dans le document ; ouverture du logiciel de messagerie, envoi et attribution réelle d’un créneau hors périmètre.
- Polices Google autorisées ; autres fournisseurs et médias externes bloqués. Les références sont présentées, sans valider leurs plateformes externes.

${outcomes.map(outcome => '- ' + outcome).join('\n')}

## Annexes

Captures : production-podcast-390.png, production-podcast-1440.png, session-390.png,
session-1440.png et home-footer-320.png. Rapport et captures restent hors Git.
Joindre la sortie npm et le lien CI au SHA candidat ; ce rapport ne remplace pas les contrôles de rollout et de pods.

Ressources dont les octets correspondent au checkout local :

${verifiedAssets.map(({ asset, sha256 }) => `- ${asset} : ${sha256}`).join('\n')}
`)
  }
})
