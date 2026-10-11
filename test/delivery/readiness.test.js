import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkReadiness } from '../../scripts/delivery/readiness.mjs'
import { smoke } from '../../scripts/delivery/smoke.mjs'

const degraded = { ok: true, mode: 'degraded', database: { state: 'unavailable' }, episodeWorker: { state: 'retry_scheduled' } }

test('HTTP readiness admits usable degraded pages while release validation still rejects degradation', async () => {
  const fetchImpl = async () => Response.json(degraded)
  assert.equal(await checkReadiness({ fetchImpl }), true)
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    await assert.rejects(smoke('http://qualification.invalid'), /Health is not normal/)
  } finally {
    globalThis.fetch = original
  }
})

test('HTTP readiness rejects failed, malformed and unreachable HTTP', async () => {
  for (const fetchImpl of [
    async () => Response.json({ ok: false }),
    async () => Response.json(degraded, { status: 503 }),
    async () => new Response('not JSON'),
    async () => { throw new Error('unreachable') }
  ]) assert.equal(await checkReadiness({ fetchImpl }), false)
})
