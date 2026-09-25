import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../../server.js'

test('GET /photographie presents the offer and three reportages without external dependencies', async () => {
  const unexpectedAccess = async () => assert.fail('The photography page must not access an external service')
  const app = await buildApp({
    initializeStorage: false,
    storageEnabled: false,
    databaseConfigured: false,
    databaseAdapter: { query: unexpectedAccess, connect: unexpectedAccess },
    podcastEpisodesFetcher: unexpectedAccess,
    episodeWorkerStarter: unexpectedAccess
  })

  try {
    const response = await app.inject('/photographie')

    assert.equal(response.statusCode, 200)
    assert.match(response.headers['content-type'], /text\/html/)
    assert.match(response.body, /Au milieu/)
    for (const text of ['dotAI / dotJS', 'Hodéfi Awards', 'Les Masters de Feu', '20 ou 40 photos', '48 h', 'consentement']) {
      assert.ok(response.body.includes(text), `Missing public information: ${text}`)
    }
    assert.match(response.body, /<link rel="canonical" href="https:\/\/saletesincere\.fr\/photographie">/)
    assert.match(response.body, /mailto:damien@saletesincere\.fr/)
    assert.equal(response.headers['x-content-type-options'], 'nosniff')
  } finally {
    await app.close()
  }
})

test('the home links to photography and every local page asset is served', async () => {
  const app = await buildApp({
    initializeStorage: false,
    databaseConfigured: false,
    podcastEpisodesFetcher: async () => []
  })
  try {
    const home = await app.inject('/')
    assert.match(home.body, /href="\/photographie">Photographie<\/a>/)
    const sitemap = await app.inject('/sitemap.xml')
    assert.ok(sitemap.body.includes('<loc>https://saletesincere.fr/photographie</loc>'))
    const page = await app.inject('/photographie')
    assert.match(page.body, /<details class="photo-series">/)
    assert.doesNotMatch(page.body, /<script|window\.openai|data-photo=|data:image\//)

    const assets = new Set([
      ...Array.from(page.body.matchAll(/(?:src|href)="(\/[^"#]+)"/g), match => match[1]),
      ...Array.from(page.body.matchAll(/(\/images\/photography\/[^\s",]+)/g), match => match[1]),
      '/images/photography/photographie-social.jpg'
    ])
    for (const url of assets) {
      const asset = await app.inject(url)
      assert.equal(asset.statusCode, 200, `Missing page resource: ${url}`)
      if (url.endsWith('.webp')) assert.match(asset.headers['content-type'], /image\/webp/)
    }
  } finally {
    await app.close()
  }
})
