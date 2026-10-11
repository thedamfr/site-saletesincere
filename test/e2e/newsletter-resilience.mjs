import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

/** Golden Journeys use the real HTTP app, PostgreSQL and an external Brevo fixture. */
export async function exerciseNewsletter(h, f) {
  const scenario = async (name, callback) => {
    await h.freshProcess(); // Independent case; preserve every durable row and effect.
    return h.scenario(name, callback);
  }
  const unique = Date.now().toString(36)
  const emailFor = name => `${name}-${unique}@example.test`
  const configure = (target, overrides = {}) => f.configure({ brevo: {
    target, hold: null, unavailable: false, hideContact: false, partialFailure: false, blocked: false, ...overrides
  } })
  const state = async email => {
    const { rows } = await h.sql('SELECT state FROM newsletter_requests WHERE email = $1 ORDER BY created_at DESC LIMIT 1', [email])
    return rows[0]?.state
  }
  const submit = email => h.request('/newsletter/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email }).toString(),
    signal: AbortSignal.timeout(30_000)
  })
  const recoveryBudget = (journey, trigger, started = performance.now()) => {
    const remaining = () => {
      const budget = 300_000 - (performance.now() - started)
      assert.ok(budget > 0, `${journey}: shared recovery deadline exceeded`)
      return budget
    }
    return {
      remaining,
      async waitFor(predicate, label) {
        await h.waitFor(predicate, label, remaining())
      },
      complete(state) {
        const elapsedMs = Math.round(performance.now() - started)
        remaining()
        h.events.push({ operation: 'newsletter business result', journey, trigger, state, elapsedMs })
      }
    }
  }

  await scenario('Golden Journey newsletter : double soumission concurrente et identité unique', async () => {
    const email = emailFor('concurrent')
    await configure(email)
    const before = await f.snapshot()
    const responses = await Promise.all([submit(email), submit(email.toUpperCase())])
    assert.ok(responses.every(response => [200, 202].includes(response.status)))
    await h.waitFor(async () => await state(email) === 'submitted', 'concurrent newsletter submissions completed')
    const requests = await h.sql('SELECT count(*)::int AS count FROM newsletter_requests WHERE email = $1', [email])
    const attempts = await h.sql(`
      SELECT count(*)::int AS count FROM newsletter_attempts a
      JOIN newsletter_requests r ON r.id = a.request_id WHERE r.email = $1`, [email])
    assert.equal(requests.rows[0].count, 1)
    assert.equal(attempts.rows[0].count, 1)
    const after = await f.snapshot()
    assert.equal(after.effects, before.effects + 1)
    assert.equal(after.mutationsAttempted, before.mutationsAttempted + 1)
  })

  await scenario('Golden Journey newsletter : demande durable et retour tardif de Brevo', async () => {
    const email = emailFor('ready')
    const before = (await f.snapshot()).effects
    await configure(email, { unavailable: true })
    const response = await submit(email)
    assert.equal(response.status, 202)
    assert.match(await response.text(), /demande est enregistrée/)
    assert.equal(await state(email), 'ready')
    assert.equal((await f.snapshot()).effects, before)
    await h.restartApp()
    await configure(email)
    const recovery = recoveryBudget('ready', 'Brevo available')
    await recovery.waitFor(async () => await state(email) === 'submitted', 'newsletter ready resumed after Brevo recovery')
    assert.equal((await f.snapshot()).effects, before + 1)
    assert.equal((await submit(email)).status, 200)
    assert.equal((await f.snapshot()).effects, before + 1)
    recovery.complete('submitted')
  })

  await scenario('Golden Journey newsletter : contact bloqué sans réactivation ni tentative', async () => {
    const email = emailFor('blocked')
    await configure(email, { blocked: true })
    const before = await f.snapshot()
    const response = await submit(email)
    assert.equal(response.status, 422)
    assert.match(await response.text(), /Aucun nouvel envoi/)
    assert.equal(await state(email), 'rejected')
    const attempts = await h.sql(`
      SELECT count(*)::int AS count FROM newsletter_attempts a
      JOIN newsletter_requests r ON r.id = a.request_id WHERE r.email = $1`, [email])
    assert.equal(attempts.rows[0].count, 0)
    const after = await f.snapshot()
    assert.equal(after.effects, before.effects)
    assert.equal(after.mutationsAttempted, before.mutationsAttempted)
  })

  await scenario('Golden Journey newsletter : crash après effet avant réponse et déduplication', async () => {
    const email = emailFor('after-effect')
    const snapshotBefore = await f.snapshot()
    const before = snapshotBefore.effects
    await configure(email, { hold: 'after-effect' })
    const pendingResponse = submit(email).catch(() => null)
    await h.waitFor(async () => {
      const snapshot = await f.snapshot()
      return snapshot.waiting > 0 && snapshot.effects === before + 1
    }, 'Brevo effect persisted while response is held', 20_000)
    assert.ok(['sending', 'uncertain'].includes(await state(email)))
    const recovery = recoveryBudget('after-effect', 'application crash requested')
    await h.restartApp()
    recovery.remaining()
    await configure(email)
    await pendingResponse
    await recovery.waitFor(async () => await state(email) === 'submitted', 'newsletter reconciled after response loss')
    assert.equal((await submit(email.toUpperCase())).status, 200)
    assert.equal((await f.snapshot()).effects, before + 1)
    assert.equal((await f.snapshot()).mutationsAttempted, snapshotBefore.mutationsAttempted + 1)
    recovery.complete('submitted')
  })

  await scenario('Golden Journey newsletter : résultat absent, second crash et aucun renvoi', async () => {
    const email = emailFor('uncertain')
    await configure(email, { hold: 'before-effect', hideContact: true })
    const pendingResponse = submit(email).catch(() => null)
    await h.waitFor(async () => (await f.snapshot()).waiting > 0 && ['sending', 'uncertain'].includes(await state(email)), 'Brevo request held before effect', 20_000)
    assert.ok(['sending', 'uncertain'].includes(await state(email)))
    const recovery = recoveryBudget('uncertain', 'first application crash requested')
    await h.restartApp()
    recovery.remaining()
    await configure(email, { hideContact: true })
    await pendingResponse
    await recovery.waitFor(async () => await state(email) === 'uncertain', 'newsletter uncertainty persisted')
    const afterInterruption = await f.snapshot()
    await h.restartApp()
    recovery.remaining()
    const response = await submit(email)
    assert.equal(response.status, 202)
    assert.match(await response.text(), /aucun nouvel envoi/)
    assert.equal(await state(email), 'uncertain')
    assert.equal((await f.snapshot()).effects, afterInterruption.effects)
    assert.equal((await f.snapshot()).mutationsAttempted, afterInterruption.mutationsAttempted)
    recovery.complete('uncertain')
  })

  await scenario('Golden Journey newsletter : échec individuel dans une réponse HTTP 201', async () => {
    const email = emailFor('partial')
    const before = (await f.snapshot()).effects
    await configure(email, { partialFailure: true })
    const response = await submit(email)
    assert.equal(response.status, 202)
    assert.match(await response.text(), /aucun nouvel envoi/)
    assert.equal(await state(email), 'uncertain')
    assert.equal((await f.snapshot()).effects, before)
  })

  await scenario('Golden Journey newsletter : PostgreSQL en lecture seule refuse tout effet', async () => {
    const email = emailFor('readonly')
    const before = await f.snapshot()
    await configure(email)
    const restoredAt = await h.withReadOnlyDatabase(async () => {
      await h.assertRoutingReadiness();
      for (const path of ['/', '/podcast']) assert.equal((await h.request(path)).status, 200)
      const response = await submit(email)
      assert.equal(response.status, 503)
      assert.match(await response.text(), /n’a pas pu être enregistrée/)
      assert.equal(await state(email), undefined)
      const refused = await f.snapshot()
      assert.equal(refused.effects, before.effects)
      assert.equal(refused.mutationsAttempted, before.mutationsAttempted)
    })
    const recovery = recoveryBudget('readonly', 'PostgreSQL writes restored', restoredAt)
    assert.equal((await submit(email)).status, 200)
    assert.equal(await state(email), 'submitted')
    assert.equal((await submit(email.toUpperCase())).status, 200)
    const after = await f.snapshot()
    assert.equal(after.effects, before.effects + 1)
    assert.equal(after.mutationsAttempted, before.mutationsAttempted + 1)
    recovery.complete('submitted')
  })
}
