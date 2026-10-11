import test from 'node:test'
import assert from 'node:assert/strict'
import { createBrevoClient } from '../../server/newsletter/brevoClient.js'

function clientReturning(data, status = 200) {
  return createBrevoClient({ listId: 3, finalListId: 4, apiKey: 'qualification-only', fetchFn: async () => new Response(JSON.stringify(data), { status }) })
}

test('contact lookup distinguishes current lists and blocked contacts', async () => {
  const client = clientReturning({ listIds: [4], emailBlacklisted: true })
  assert.deepEqual(await client.lookup('reader@example.test'), { kind: 'found', inTempList: false, inFinalList: true, blocked: true })
})

test('HTTP 201 with an individual list failure is never accepted as success', async () => {
  const client = clientReturning({ contacts: { success: [], failure: ['reader@example.test'] } }, 201)
  assert.equal((await client.addToList('reader@example.test')).kind, 'uncertain')
})

test('list success must identify the requested contact', async () => {
  const client = clientReturning({ contacts: { success: ['reader@example.test'], failure: [] } }, 201)
  assert.equal((await client.addToList('reader@example.test')).kind, 'submitted')
  assert.equal((await client.addToList('another@example.test')).kind, 'uncertain')
})

test('a transient server error and unreadable success remain uncertain', async () => {
  assert.equal((await clientReturning({}, 503).create('reader@example.test')).kind, 'uncertain')
  assert.equal((await clientReturning({}, 201).addToList('reader@example.test')).kind, 'uncertain')
})

test('a deadline aborts the remote call without exposing its error details', async () => {
  const controller = new AbortController()
  const client = createBrevoClient({ listId: 3, apiKey: 'qualification-only', fetchFn: async (_url, { signal }) => {
    assert.equal(signal, controller.signal)
    controller.abort()
    throw new Error('private details and contact address')
  } })
  assert.deepEqual(await client.create('reader@example.test', { signal: controller.signal }), { kind: 'uncertain', code: 'request_timeout' })
})

test('only explicit mutation rejections allow another attempt', async () => {
  assert.deepEqual(await clientReturning({ code: 'duplicate_parameter' }, 400).create('reader@example.test'), { kind: 'duplicate', code: 'contact_exists' })
  assert.deepEqual(await clientReturning({}, 429).create('reader@example.test'), { kind: 'deferred', code: 'remote_rate_limited' })
  assert.deepEqual(await clientReturning({}, 403).create('reader@example.test'), { kind: 'rejected', code: 'remote_403' })
})
