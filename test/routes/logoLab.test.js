import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../../server.js'

const apps = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

async function createApp() {
  const app = await buildApp({
    initializeStorage: false,
    databaseConfigured: false,
    podcastEpisodesFetcher: async () => []
  })
  apps.push(app)
  return app
}

describe('GET /laboratoire-du-geste', () => {
  test('renders the public brand page and animation controls without a database', async () => {
    const app = await createApp()

    const response = await app.inject({ method: 'GET', url: '/laboratoire-du-geste' })

    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['x-robots-tag'], undefined)
    assert.doesNotMatch(response.body, /noindex|nofollow|noarchive/)
    assert.match(response.body, /rel="canonical" href="https:\/\/saletesincere\.fr\/laboratoire-du-geste"/)
    assert.match(response.body, /href="\/" aria-label="Accueil Saleté Sincère"/)
    assert.match(response.body, /Laboratoire du geste/)
    assert.match(response.body, /type="range"[^>]*data-logo-progress/)
    assert.match(response.body, /data-logo-guides/)
    assert.match(response.body, /<script type="module" src="\/js\/logo-lab\.js"><\/script>/)
  })

  test('remains available in production', async () => {
    const originalEnvironment = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'production'
      const app = await createApp()
      const response = await app.inject({ method: 'GET', url: '/laboratoire-du-geste' })
      assert.equal(response.statusCode, 200)
    } finally {
      if (originalEnvironment === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = originalEnvironment
    }
  })

  test('redirects the old laboratory address to the public page', async () => {
    const app = await createApp()

    const response = await app.inject({ method: 'GET', url: '/__logo-lab' })

    assert.equal(response.statusCode, 301)
    assert.equal(response.headers.location, '/laboratoire-du-geste')
  })

  test('is linked from the home page', async () => {
    const app = await createApp()
    const response = await app.inject({ method: 'GET', url: '/' })
    assert.match(response.body, /href="\/laboratoire-du-geste">Laboratoire du geste<\/a>/)
  })
})
