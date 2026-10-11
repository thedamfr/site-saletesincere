import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import view from '@fastify/view'
import formbody from '@fastify/formbody'
import handlebars from 'handlebars'
import { fileURLToPath } from 'node:url'
import newsletterRoutes from '../../server/newsletter/routes.js'

async function appFor(t, state) {
  let calls = 0
  const app = Fastify()
  await app.register(formbody)
  await app.register(view, {
    engine: { handlebars },
    root: fileURLToPath(new URL('../../server/views', import.meta.url)),
    viewExt: 'hbs'
  })
  await app.register(newsletterRoutes, {
    prefix: '/newsletter', recoveryEnabled: false,
    service: { subscribe: async () => { calls++; return { state } }, stop: async () => {} }
  })
  t.after(() => app.close())
  return { app, calls: () => calls }
}

test('submitted response confirms the request without promising email delivery', async t => {
  const { app } = await appFor(t, 'submitted')
  const response = await app.inject({ method: 'POST', url: '/newsletter/subscribe', payload: { email: 'reader@example.test' } })
  assert.equal(response.statusCode, 200)
  assert.match(response.body, /Votre demande a été prise en compte/)
  assert.doesNotMatch(response.body, /Un email de confirmation a été envoyé/)
})

for (const state of ['ready', 'sending', 'uncertain']) {
  test(`${state} returns a durable acknowledgement without claiming completion`, async t => {
    const { app } = await appFor(t, state)
    const response = await app.inject({ method: 'POST', url: '/newsletter/subscribe', payload: { email: 'reader@example.test' } })
    assert.equal(response.statusCode, 202)
    assert.match(response.body, /Votre demande est enregistrée/)
    assert.doesNotMatch(response.body, /Un email de confirmation a été envoyé/)
    if (state === 'ready') assert.match(response.body, /reprendra automatiquement/)
    else assert.match(response.body, /aucun nouvel envoi/)
  })
}

test('unavailable journal returns 503 and does not claim the request is stored', async t => {
  const { app } = await appFor(t, 'unavailable')
  const response = await app.inject({ method: 'POST', url: '/newsletter/subscribe', payload: { email: 'reader@example.test' } })
  assert.equal(response.statusCode, 503)
  assert.match(response.body, /n’a pas pu être enregistrée/)
})

test('invalid and empty requests fail validation before subscription', async t => {
  const { app, calls } = await appFor(t, 'submitted')
  for (const payload of [{ email: 'invalid' }, {}]) {
    const response = await app.inject({ method: 'POST', url: '/newsletter/subscribe', payload })
    assert.equal(response.statusCode, 400)
  }
  assert.equal(calls(), 0)
})

test('a rejected contact has a generic public response without claiming an email', async t => {
  const { app } = await appFor(t, 'rejected')
  const response = await app.inject({ method: 'POST', url: '/newsletter/subscribe', payload: { email: 'reader@example.test' } })
  assert.equal(response.statusCode, 422)
  assert.match(response.body, /Aucun nouvel envoi/)
  assert.doesNotMatch(response.body, /blocklist|blocked|Brevo|stack/)
})
