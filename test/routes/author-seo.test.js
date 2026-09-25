import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from '../helpers/app.js'

async function appFor(t, options = {}) {
  const app = await build({ storageEnabled: false, databaseConfigured: false,
    podcastEpisodesFetcher: async () => [{ season: 3, episode: 2 }, { season: 3, episode: 2 }, { season: -1, episode: 2 }], ...options })
  t.after(() => app.close())
  return app
}

test('author is public, server-rendered and independent of RSS and database', async t => {
  let calls = 0
  const app = await appFor(t, { podcastEpisodesFetcher: async () => { calls++; throw Error('offline') } })
  const response = await app.inject('/damien-cavailles')
  assert.equal(response.statusCode, 200)
  assert.match(response.body, /<h1>Damien Cavaillès<\/h1>/)
  assert.match(response.body, /Travail d’éditeur/)
  assert.match(response.body, /Free-Work/)
  assert.match(response.body, /HIT \/ EuraCreative/)
  assert.match(response.body, /Insitoo/)
  assert.match(response.body, /rel="canonical" href="https:\/\/saletesincere.fr\/damien-cavailles"/)
  const data = JSON.parse(response.body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])
  assert.equal(data['@type'], 'ProfilePage')
  assert.equal(data.mainEntity.name, 'Damien Cavaillès')
  assert.equal(calls, 0)
  assert.equal((await app.inject('/damien-cavailles/')).headers.location, '/damien-cavailles')
})

test('official portrait download preserves the original bytes', async t => {
  const app = await appFor(t)
  const response = await app.inject('/damien-cavailles/portrait.jpg')
  assert.equal(response.statusCode, 200)
  assert.match(response.headers['content-disposition'], /attachment; filename="damien-cavailles-portrait-officiel.jpg"/)
  assert.deepEqual(response.rawPayload, await readFile(new URL('../../public/images/damien-podcast.jpg', import.meta.url)))
})

test('robots declares a canonical sitemap with unique public episode URLs', async t => {
  const app = await appFor(t)
  const robots = await app.inject('/robots.txt')
  assert.equal(robots.statusCode, 200)
  assert.match(robots.body, /Sitemap: https:\/\/saletesincere.fr\/sitemap.xml/)
  const result = await app.inject('/sitemap.xml')
  assert.equal(result.statusCode, 200)
  assert.match(result.headers['content-type'], /application\/xml/)
  assert.match(result.body, /<loc>https:\/\/saletesincere.fr\/damien-cavailles<\/loc>/)
  assert.equal(result.body.match(/<loc>https:\/\/saletesincere.fr\/podcast\/3\/2<\/loc>/g).length, 1)
  assert.doesNotMatch(result.body, /staging|\/wall|\/health|\/api|\/podcast\/-1|lastmod/)
})

test('sitemap failure without a previous cache is temporary', async t => {
  const app = await appFor(t, { podcastEpisodesFetcher: async () => { throw Error('private upstream') } })
  const response = await app.inject('/sitemap.xml')
  assert.equal(response.statusCode, 503)
  assert.equal(response.headers['retry-after'], '300')
  assert.doesNotMatch(response.body, /private upstream/)
})
