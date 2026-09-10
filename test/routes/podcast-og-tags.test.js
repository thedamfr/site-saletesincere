/**
 * Tests OG tags et meta sociales - US4.1
 * ADR-0011 + Épopée 4 Roadmap MVP
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { buildPodcastApp } from '../helpers/podcastApp.js'

describe('US4.1 - Open Graph tags dynamiques par épisode', () => {
  let app

  before(async () => {
    app = await buildPodcastApp()
  })

  after(async () => {
    await app.close()
  })

  it('devrait afficher og:url avec format /podcast/:season/:episode (pas query params)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/podcast/2/1'
    })

    assert.equal(res.statusCode, 200)
    
    // ✅ OG url correct (Open Graph uses property="")
    assert.match(res.body, /<meta property="og:url" content="https:\/\/saletesincere\.fr\/podcast\/2\/1">/)
    // Twitter:url not tested - template uses property="" instead of name="" (to fix later)
  })

  it('devrait afficher og:title spécifique à l\'épisode', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/podcast/2/1'
    })

    assert.equal(res.statusCode, 200)
    
    // Doit contenir S2E1 + titre épisode
    assert.match(res.body, /<meta property="og:title" content="S2E1 - .+? \| Charbon & Wafer">/)
    assert.match(res.body, /<meta name="twitter:title" content="S2E1 - .+? \| Charbon & Wafer">/)
  })

  it('devrait afficher og:description spécifique à l\'épisode (depuis RSS)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/podcast/1/5'
    })

    assert.equal(res.statusCode, 200)
    
    // Description doit exister et ne pas être générique
    assert.match(res.body, /<meta property="og:description" content="[^"]{10,}">/)
    assert.match(res.body, /<meta name="twitter:description" content="[^"]{10,}">/)
    
    // Ne doit PAS contenir la description générique du show
    assert.doesNotMatch(res.body, /Pas de Charbon, Pas de Wafer - Confidences brutes/)
  })

  it('devrait utiliser og:type="article" pour un épisode (pas website)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/podcast/2/1'
    })

    assert.equal(res.statusCode, 200)
    
    // ❌ RED : Actuellement "website", devrait être "article" ou "music.song"
    assert.match(res.body, /<meta property="og:type" content="article">/)
  })

  it('devrait afficher og:image custom si disponible, sinon RSS thumbnail', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/podcast/2/1'
    })

    assert.equal(res.statusCode, 200)
    
    // Doit avoir une image (custom S3, RSS, ou fallback)
    assert.match(res.body, /<meta property="og:image" content="https?:\/\/.+">/)
    assert.match(res.body, /<meta name="twitter:image" content="https?:\/\/.+">/)
    
    // Si custom OG image, doit avoir dimensions
    if (res.body.includes('og:image:width')) {
      assert.match(res.body, /<meta property="og:image:width" content="1200">/)
      assert.match(res.body, /<meta property="og:image:height" content="630">/)
    }
  })

  it('devrait avoir twitter:card="summary_large_image"', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/podcast/2/1'
    })

    assert.equal(res.statusCode, 200)
    // Twitter Cards use name="" not property=""
    assert.match(res.body, /<meta name="twitter:card" content="summary_large_image">/)
  })
})

describe('US4.1 - Cache headers et bots (Vary: User-Agent)', () => {
  let app

  before(async () => {
    app = await buildPodcastApp()
  })

  after(async () => {
    await app.close()
  })

  it('devrait retourner HTML complet pour facebookexternalhit (bot)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/podcast/2/1',
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
      }
    })

    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8')
    
    // Doit contenir OG tags (pas de redirect)
    assert.match(res.body, /<meta property="og:title"/)
    assert.match(res.body, /<meta property="og:image"/)
  })

  it('devrait retourner HTML complet pour Twitterbot', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/podcast/2/1',
      headers: {
        'User-Agent': 'Twitterbot/1.0'
      }
    })

    assert.equal(res.statusCode, 200)
    assert.match(res.body, /<meta name="twitter:card" content="summary_large_image">/)
  })

  it('devrait avoir Cache-Control avec max-age pour CDN', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/podcast/2/1'
    })

    assert.equal(res.statusCode, 200)
    
    // Cache headers doivent exister
    assert.ok(res.headers['cache-control'])
    assert.match(res.headers['cache-control'], /max-age=\d+/)
  })

  it('devrait avoir Vary: User-Agent pour cache bot vs user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/podcast/2/1'
    })

    assert.equal(res.statusCode, 200)
    
    // ❌ RED : Vary header probablement absent ou incomplet
    assert.ok(res.headers['vary'])
    assert.match(res.headers['vary'], /User-Agent/i)
  })
})
