import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../../server.js'

const apps = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

async function createApp(logoLabEnabled) {
  const app = await buildApp({
    initializeStorage: false,
    databaseConfigured: false,
    podcastEpisodesFetcher: async () => [],
    logoLabEnabled
  })
  apps.push(app)
  return app
}

describe('GET /__logo-lab', () => {
  test('renders the local animation scrubber when explicitly enabled', async () => {
    const app = await createApp(true)

    const response = await app.inject({ method: 'GET', url: '/__logo-lab' })

    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['x-robots-tag'], 'noindex, nofollow, noarchive')
    assert.match(response.body, /Laboratoire du geste/)
    assert.match(response.body, /type="range"[^>]*data-logo-progress/)
    assert.match(response.body, /data-logo-guides/)
    assert.match(response.body, /<script type="module" src="\/js\/logo-lab\.js"><\/script>/)
  })

  test('is unavailable when the local lab is disabled', async () => {
    const app = await createApp(false)

    const response = await app.inject({ method: 'GET', url: '/__logo-lab' })

    assert.equal(response.statusCode, 404)
  })
})
