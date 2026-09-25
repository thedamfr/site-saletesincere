import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'

// This suite only starts its own loopback server. Never read the local .env or
// connect to production services; run the real routes with unavailable backends.
process.env.DOTENV_CONFIG_PATH = '/dev/null'
process.env.DISABLE_WORKER = 'true'
process.env.NODE_ENV = 'production'

const { buildApp } = await import('../../server.js')
const outputDirectory = path.resolve(process.env.PHOTOGRAPHY_E2E_OUTPUT || 'test-results/photography')

test('Golden Journeys — photographie', { timeout: 120_000 }, async t => {
  await mkdir(outputDirectory, { recursive: true })
  const unavailableDatabase = async () => { throw new Error('Database intentionally unavailable in E2E') }
  const app = await buildApp({
    storageEnabled: false,
    initializeStorage: false,
    wallEnabled: false,
    databaseConfigured: false,
    databaseAdapter: { query: unavailableDatabase, connect: unavailableDatabase },
    podcastEpisodesFetcher: async () => [],
    op3PublicStatsEnabled: false
  })
  let browser
  const outcomes = []
  const errors = []
  try {
    const baseURL = await app.listen({ host: '127.0.0.1', port: 0 })
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      channel: process.env.E2E_BROWSER_CHANNEL || undefined,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined
    })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
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
        const navigationFits = await page.getByRole('navigation').getByRole('link').evaluateAll(links => links.every(link => {
          const bounds = link.getBoundingClientRect()
          return bounds.left >= 0 && bounds.right <= innerWidth
        }))
        assert.ok(navigationFits, `Home navigation must remain visible at ${width}px`)
        if (width === 320) await page.screenshot({ path: path.join(outputDirectory, 'home-320.png') })
      }
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.getByRole('navigation').getByRole('link', { name: 'Photographie' }).click()
      await page.waitForURL('**/photographie')
      assert.match(await page.title(), /Photographie événementielle/)
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
      for (const name of ['dotAI / dotJS', 'Hodéfi Awards', 'Les Masters de Feu']) {
        assert.equal(await page.getByRole('heading', { name, exact: true }).count(), 1)
      }
      assert.match(await page.locator('.photo-delivery').innerText(), /20 ou 40 photos/)
      assert.match(await page.locator('.photo-delivery').innerText(), /Juste après la prise de vue/)
      assert.match(await page.locator('.photo-delivery').innerText(), /consentement/)
      await page.getByRole('link', { name: 'Parlons de votre projet' }).click()
      assert.equal(new URL(page.url()).hash, '#photo-contact')
      assert.equal(await page.getByRole('link', { name: 'Écrire à Damien' }).getAttribute('href'), 'mailto:damien@saletesincere.fr')
      await page.getByRole('link', { name: 'Accueil Saleté Sincère' }).click()
      await page.waitForURL(baseURL + '/')
      assert.match(await page.locator('h1').innerText(), /On gratte la surface/i)
      await page.goto(baseURL + '/photographie')
      await page.getByRole('contentinfo').getByRole('link', { name: 'Podcast', exact: true }).click()
      await page.waitForURL('**/podcast')
      assert.match(await page.locator('h1').innerText(), /Charbon|Wafer/i)
      outcomes.push('Accueil → photographie → références et offre → contact → accueil et podcast : OK')
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
        if (width === 1440 || width === 390) {
          await page.screenshot({ path: path.join(outputDirectory, `photography-${width}.png`), fullPage: true })
        }
      }
      await page.reload()
      assert.equal(await page.locator('details').evaluate(el => el.open), false)
      assert.deepEqual(await context.cookies(), [])
      assert.equal(await page.evaluate(() => localStorage.length), 0)
      outcomes.push('Clavier, chargement des 12 photos, formats 1440/768/390/320, rechargement sans stockage : OK')
    })

    await t.test('Golden Journey 3 — consultation et reprise sans JavaScript ni base', async () => {
      const noScriptContext = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } })
      try {
        const noScriptPage = await noScriptContext.newPage()
        const response = await noScriptPage.goto(baseURL + '/photographie')
        assert.equal(response.status(), 200)
        await noScriptPage.locator('summary').click()
        assert.equal(await noScriptPage.locator('details').getAttribute('open'), '')
        assert.equal(await noScriptPage.locator('#photo-dot-extra').isVisible(), true)
        await noScriptPage.getByRole('link', { name: 'Parlons de votre projet' }).click()
        assert.equal(await noScriptPage.getByRole('link', { name: 'Écrire à Damien' }).isVisible(), true)
        await noScriptPage.reload()
        assert.equal(await noScriptPage.locator('details').getAttribute('open'), null)
        await noScriptPage.getByRole('link', { name: 'Accueil Saleté Sincère' }).click()
        assert.match(await noScriptPage.locator('h1').innerText(), /On gratte la surface/i)
        outcomes.push('Sans JavaScript et sans base : lecture, galerie, contact, rechargement et retour : OK')
      } finally {
        await noScriptContext.close()
      }
    })
    assert.deepEqual(errors, [])
    await context.close()
  } finally {
    await browser?.close()
    await app.close()
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0
    const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
      .split('\0').filter(file => /^(server\/|public\/|test\/|scripts\/|server\.js$|style\.css$|package(-lock)?\.json$)/.test(file)))].sort()
    const fingerprint = createHash('sha256')
    for (const file of files) fingerprint.update(file + '\0').update(await readFile(file)).update('\0')
    await writeFile(path.join(outputDirectory, 'report.md'), `# Golden Journeys — photographie

## Summary

${outcomes.length}/3 Golden Journeys terminés. ${errors.length} erreur(s) navigateur ou ressource locale.
Les échecs d’assertion éventuels restent visibles dans la sortie du runner npm.

## Synthèse

- Date UTC : ${new Date().toISOString()}
- Révision de base : ${sha}${dirty ? ' ; checkout modifié, non commité' : ''}.
- Empreinte SHA-256 des sources, tests et ressources : ${fingerprint.digest('hex')}.
- Commande : npm run test:e2e:photography.
- Environnement : Node ${process.version}, Chromium avec sandbox, HTTP loopback.
- Aucune base, aucun worker ni stockage objet. RSS simulé vide.
- Aucun envoi d’email, aucune écriture métier. Le QR code et le consentement sont
  présentés comme service ; leur application externe n’est pas testée ici.
- Rechargement : galerie refermée ; aucun cookie ni état local ajouté.

${outcomes.map(outcome => '- ' + outcome).join('\n')}

## Annexes

Captures : photography-1440.png, photography-390.png et home-320.png dans ce dossier ignoré par Git.
Ce rapport local ne constitue pas une validation en production ni une preuve sur un commit publié.
`)
  }
})
