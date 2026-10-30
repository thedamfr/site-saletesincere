import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../../server.js'

const offerPath = '/offre-production-podcast/'
const canonical = `https://saletesincere.fr${offerPath}`
const footerLink = `<a href="${offerPath}">Besoin d'un producteur sur mon podcast ?</a>`

async function isolatedApp() {
  const unexpectedAccess = async () => assert.fail('The offer must not access external services')
  return buildApp({
    initializeStorage: false,
    storageEnabled: false,
    databaseConfigured: false,
    databaseAdapter: { query: unexpectedAccess, connect: unexpectedAccess },
    podcastEpisodesFetcher: unexpectedAccess,
    episodeWorkerStarter: unexpectedAccess
  })
}

test('the production offer renders its editorial and commercial commitments without external services', async () => {
  const app = await isolatedApp()
  try {
    const response = await app.inject(offerPath)
    assert.equal(response.statusCode, 200)
    assert.match(response.headers['content-type'], /text\/html/)
    assert.equal(response.headers['x-content-type-options'], 'nosniff')
    const text = response.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    for (const expected of [
      'Ton podcast, sans y passer tes semaines.',
      'Débloquer une production', '500', 'Produire une saison', '10 000', '20 000',
      'Une heure pour faire le point sur ton podcast', 'deux fois par an',
      'Je suis Damien Cavaillès', 'validation éditoriale'
    ]) assert.ok(text.includes(expected), `Missing offer information: ${expected}`)
    assert.match(response.body, /href="#session"[^>]*>\s*Faire le point sur mon podcast/)
    assert.match(response.body, /id="session"/)
    assert.match(response.body, /mailto:damien@saletesincere\.fr\?subject=/)
    assert.match(response.body, /<link rel="canonical" href="https:\/\/saletesincere\.fr\/offre-production-podcast\/">/)
    for (const property of ['og:url', 'og:title', 'og:description', 'og:image']) {
      assert.match(response.body, new RegExp(`<meta property="${property}" content="[^\"]+"`))
    }
    assert.match(response.body, /<meta name="twitter:card" content="summary_large_image"/)
    assert.doesNotMatch(response.body, /<form\b|<script\b|<iframe\b/)
    const assetURLs = new Set([...response.body.matchAll(/(?:src|href)="(\/(?:images\/|[^"/]+\.css)[^"#]*)"/g)].map(match => match[1]))
    assert.ok(assetURLs.size >= 3)
    for (const url of assetURLs) assert.equal((await app.inject(url)).statusCode, 200, `Missing asset ${url}`)
  } finally { await app.close() }
})

test('the offer canonical redirect keeps referral query parameters and has no loop', async () => {
  const app = await isolatedApp()
  try {
    for (const query of ['', '?utm_source=prescripteur&utm_campaign=podcast%20saison']) {
      const redirect = await app.inject('/offre-production-podcast' + query)
      assert.equal(redirect.statusCode, 301)
      assert.equal(redirect.headers.location, offerPath + query)
      assert.equal((await app.inject(redirect.headers.location)).statusCode, 200)
    }
  } finally { await app.close() }
})

test('the offer is discoverable in public footers and the sitemap, without changing the header or home offers', async () => {
  const app = await buildApp({ initializeStorage: false, storageEnabled: false, databaseConfigured: false, podcastEpisodesFetcher: async () => [] })
  try {
    for (const url of ['/', '/photographie', '/podcast', '/damien-cavailles', '/laboratoire-du-geste']) {
      const page = await app.inject(url)
      assert.equal(page.statusCode, 200, url)
      const footer = page.body.match(/<footer\b[^>]*>[\s\S]*?<\/footer>/)?.[0] || ''
      assert.ok(footer.includes(footerLink), `Missing offer footer link on ${url}`)
      const header = page.body.match(/<header\b[^>]*>[\s\S]*?<\/header>/)?.[0] || ''
      assert.ok(!header.includes(offerPath), `Unexpected header link on ${url}`)
      if (url === '/') {
        assert.equal((page.body.match(/class="landing-card"/g) || []).length, 3)
        assert.equal((page.body.match(/href="\/offre-production-podcast\/"/g) || []).length, 1)
      }
    }
    const sitemap = await app.inject('/sitemap.xml')
    assert.equal(sitemap.statusCode, 200)
    assert.ok(sitemap.body.includes(`<loc>${canonical}</loc>`))
  } finally { await app.close() }
})
