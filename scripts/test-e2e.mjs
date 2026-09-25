import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

process.env.DISABLE_WORKER = 'true'
process.env.DISABLE_STORAGE = 'true'
process.env.DISABLE_WALL = 'true'
const { buildApp } = await import('../server.js')
const app = await buildApp({ databaseConfigured: false, initializeStorage: false, storageEnabled: false,
  podcastEpisodesFetcher: async () => [] })
const local = await app.listen({ port: 0, host: '127.0.0.1' })
const base = process.env.E2E_BASE_URL || local
let browser
const output = process.env.E2E_OUTPUT || '/tmp/site-author-e2e'
await mkdir(output, { recursive: true })
try {
  browser = await chromium.launch({ chromiumSandbox: true,
    channel: process.env.E2E_BROWSER_CHANNEL || undefined,
    executablePath: process.env.E2E_BROWSER_EXECUTABLE || undefined })
  const context = await browser.newContext({ acceptDownloads: true })
  const page = await context.newPage()
  await page.goto(base)
  await page.getByRole('link', { name: 'À propos', exact: true }).first().click()
  await page.getByRole('heading', { name: 'Damien Cavaillès', exact: true }).waitFor()
  assert.equal(new URL(page.url()).pathname, '/damien-cavailles')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Télécharger le portrait HD' }).click()
  const download = await downloadPromise
  assert.equal(download.suggestedFilename(), 'damien-cavailles-portrait-officiel.jpg')
  assert.deepEqual(await readFile(await download.path()), await readFile(new URL('../public/images/damien-podcast.jpg', import.meta.url)))
  assert.equal(await page.locator('.author-prose li').count(), 11)
  for (const name of ['Travail d’éditeur', 'Articles signés', 'Webinars et tables rondes', 'Invité dans des podcasts']) {
    await page.getByRole('heading', { name, exact: true }).waitFor()
  }
  // Follow a real editorial link; only the external publisher is simulated.
  const article = page.locator('.author-prose a[href^="https://medium.com/"]').first()
  const destination = await article.getAttribute('href')
  await context.route('https://medium.com/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Publication externe</h1>' }))
  await article.click()
  assert.equal(page.url(), destination)
  await page.goBack()
  await page.reload()
  await page.getByRole('heading', { name: 'Damien Cavaillès', exact: true }).waitFor()
  await page.getByRole('link', { name: 'Podcast', exact: true }).click()
  await page.getByRole('link', { name: 'À propos', exact: true }).first().click()
  await page.getByRole('link', { name: 'Me contacter', exact: true }).click()
  assert.equal(new URL(page.url()).hash, '#contact')
  assert.equal(await page.locator('#contact').isVisible(), true)
  console.log('Golden Journey — navigation accueil/podcast → auteur → portrait original → référence éditoriale → contact : OK')
  await context.close()

  const noJs = await browser.newContext({ javaScriptEnabled: false })
  const staticPage = await noJs.newPage()
  for (const width of [320, 390, 1440]) {
    await staticPage.setViewportSize({ width, height: 960 })
    await staticPage.goto(`${base}/damien-cavailles`)
    await staticPage.locator('.author-work-photo').scrollIntoViewIfNeeded()
    await staticPage.waitForFunction(() => [...document.images].every(img => img.complete && img.naturalWidth > 0))
    assert.equal(await staticPage.evaluate(() => document.documentElement.scrollWidth), width)
    await staticPage.screenshot({ path: `${output}/author-${width}.png`, fullPage: true })
  }
  await staticPage.goto(`${base}/damien-cavailles/`)
  assert.equal(new URL(staticPage.url()).pathname, '/damien-cavailles')
  const canonical = await staticPage.locator('link[rel="canonical"]').getAttribute('href')
  assert.equal(canonical, 'https://saletesincere.fr/damien-cavailles')
  const schema = JSON.parse(await staticPage.locator('script[type="application/ld+json"]').textContent())
  assert.equal(schema.mainEntity.name, 'Damien Cavaillès')
  const robots = await noJs.request.get(`${base}/robots.txt`)
  assert.equal(robots.status(), 200)
  assert.match(await robots.text(), /Sitemap: https:\/\/saletesincere.fr\/sitemap.xml/)
  const sitemap = await noJs.request.get(`${base}/sitemap.xml`)
  assert.equal(sitemap.status(), 200)
  assert.match(await sitemap.text(), /<loc>https:\/\/saletesincere.fr\/damien-cavailles<\/loc>/)
  console.log('Golden Journey — lecture sans JavaScript, mobile, redirection canonique et découverte robots/sitemap : OK')
  await noJs.close()
} finally {
  await browser?.close()
  await app.close()
}
