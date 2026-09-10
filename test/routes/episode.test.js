import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { buildPodcastApp } from '../helpers/podcastApp.js'

describe('GET /podcast/:season/:episode', () => {
  let app

  before(async () => {
    app = await buildPodcastApp()
  })

  after(async () => {
    await app.close()
  })

  test('should return 200 for valid season and episode', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/podcast/2/1'
    })

    assert.strictEqual(response.statusCode, 200, 'Should return 200 OK')
  })

  test('should parse season and episode from URL params', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/podcast/1/5'
    })

    assert.strictEqual(response.statusCode, 200)
    
    const body = response.body
    assert.match(body, /Saison 1.*Épisode 5/i, 'Should display season and episode')
    assert.match(body, /Un bouclier collectif/, 'Should render the requested episode')
  })

  test('should display the RSS publication date for S2E1', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/podcast/2/1'
    })

    assert.strictEqual(response.statusCode, 200)
    
    const body = response.body
    assert.match(body, /S2E1/i, 'Should show episode identifier')
    assert.match(body, /27 octobre 2025/i, 'Should display publication date from RSS')
  })

  test('should display the RSS publication date for a different episode (S1E5)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/podcast/1/5'
    })

    assert.strictEqual(response.statusCode, 200)
    
    const body = response.body
    assert.match(body, /S1E5/i, 'Should show episode identifier')
    assert.match(body, /16 octobre 2025/i, 'Should display publication date from RSS')
  })

  test('should redirect to the podcast page when the episode is absent from RSS', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/podcast/99/99'
    })

    assert.equal(response.statusCode, 302)
    assert.equal(response.headers.location, '/podcast')
  })
})
