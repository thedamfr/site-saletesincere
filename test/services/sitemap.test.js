import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSitemap } from '../../server/services/sitemap.js'

test('sitemap shares one refresh, caches an hour, keeps stale data and recovers', async () => {
  let time = 0
  let calls = 0
  let complete
  const get = createSitemap({ now: () => time, fetchEpisodes: () => {
    calls++
    return new Promise((resolve, reject) => { complete = { resolve, reject } })
  } })
  const first = get()
  const concurrent = get()
  assert.equal(calls, 1)
  complete.resolve([{ season: 1, episode: 2 }])
  const xml = await first
  assert.equal(await concurrent, xml)
  time = 3599999
  assert.equal(await get(), xml)
  assert.equal(calls, 1)
  time = 3600000
  const stale = get()
  complete.reject(Error('upstream unavailable'))
  assert.equal(await stale, xml)
  assert.equal(await get(), xml)
  assert.equal(calls, 2)
  time += 300000
  const recovered = get()
  complete.resolve([{ season: 1, episode: 3 }])
  assert.match(await recovered, /podcast\/1\/3/)
  assert.equal(calls, 3)
})

test('cold upstream errors have a bounded retry and do not publish an empty success', async () => {
  let time = 0
  let calls = 0
  const get = createSitemap({ now: () => time, fetchEpisodes: async () => {
    if (++calls === 1) throw Error('private detail')
    return []
  } })
  await assert.rejects(get(), { message: 'Sitemap temporarily unavailable' })
  await assert.rejects(get(), { message: 'Sitemap temporarily unavailable' })
  assert.equal(calls, 1)
  time = 300000
  assert.match(await get(), /damien-cavailles/)
  assert.equal(calls, 2)
})
