/**
 * Tests SEO podcast route - US4.1 OG tags & canonical
 * TDD RED → GREEN → REFACTOR
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { buildPodcastApp } from '../helpers/podcastApp.js'

describe('US4.1 - OG tags & SEO canonical', () => {
  let app

  before(async () => {
    app = await buildPodcastApp()
  })

  after(async () => {
    await app.close()
  })

  it('should have canonical URL in new format /podcast/:season/:episode', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/podcast/2/1'
    })
    const body = response.body

    assert.strictEqual(response.statusCode, 200, 'Route should exist')
    
    // US4.1: Canonical doit pointer vers nouvelle route
    assert.match(
      body,
      /<link rel="canonical" href="https:\/\/saletesincere\.fr\/podcast\/2\/1">/,
      'Canonical URL should use new route format /podcast/2/1'
    )
  })

  it('should have og:url matching canonical URL (new format)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/podcast/2/1'
    })
    const body = response.body

    assert.strictEqual(response.statusCode, 200)
    
    // og:url doit matcher le canonical (nouveau format)
    assert.match(
      body,
      /<meta property="og:url" content="https:\/\/saletesincere\.fr\/podcast\/2\/1">/,
      'og:url should match canonical URL with new format'
    )
  })



  it('should have og:type as article for episode pages', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/podcast/2/1'
    })
    const body = response.body

    assert.strictEqual(response.statusCode, 200)
    
    // og:type devrait être "article" pour un épisode (pas "website")
    assert.match(
      body,
      /<meta property="og:type" content="article">/,
      'og:type should be "article" for episode pages'
    )
  })

  it('should have episode-specific og:title with S2E1 format', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/podcast/2/1'
    })
    const body = response.body

    assert.strictEqual(response.statusCode, 200)
    
    // Ce test devrait passer (déjà implémenté)
    assert.match(
      body,
      /<meta property="og:title" content="S2E1 - .+ \| Charbon & Wafer">/,
      'og:title should include episode identifier S2E1'
    )
  })

  it('should have dynamic og:description from RSS', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/podcast/2/1'
    })
    const body = response.body

    assert.strictEqual(response.statusCode, 200)
    
    // og:description doit être présente et non vide
    assert.match(
      body,
      /<meta property="og:description" content=".+">/,
      'og:description should be present and non-empty'
    )
    
    // Vérifier que ce n'est pas la description générique
    assert.doesNotMatch(
      body,
      /<meta property="og:description" content="Pas de Charbon, Pas de Wafer - Confidences brutes/,
      'og:description should not use generic podcast description'
    )
  })

  it('should NEVER redirect bots (facebookexternalhit User-Agent)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/podcast/2/1',
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
      }
    })

    // Bots doivent recevoir 200, JAMAIS 301/302
    assert.strictEqual(
      response.statusCode, 
      200, 
      'Bot should receive 200 OK, not 301/302 redirect'
    )

    const body = response.body
    
    // Vérifier que le bot reçoit bien le HTML complet avec OG tags
    assert.match(body, /<meta property="og:title"/, 'Bot should receive OG tags')
    assert.match(body, /<meta property="og:image"/, 'Bot should receive OG image')
  })

  it('should NEVER redirect bots (Twitterbot User-Agent)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/podcast/2/1',
      headers: {
        'User-Agent': 'Twitterbot/1.0'
      }
    })

    assert.strictEqual(response.statusCode, 200, 'Twitterbot should receive 200 OK')
    
    const body = response.body
    assert.match(body, /<meta name="twitter:card"/, 'Bot should receive Twitter Card tags')
  })

  it('should set Vary: User-Agent header for CDN cache', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/podcast/2/1'
    })

    const varyHeader = response.headers['vary']
    
    assert.ok(
      varyHeader && varyHeader.toLowerCase().includes('user-agent'),
      'Vary header should include User-Agent for proper CDN caching'
    )
  })
})
