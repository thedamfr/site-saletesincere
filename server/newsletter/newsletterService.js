import { createBrevoClient } from './brevoClient.js'
import { createNewsletterRepository } from './newsletterRepository.js'

/** The journal decides whether a mutation may be attempted, including after a crash. */
export function createNewsletterService({
  database,
  repository = createNewsletterRepository(database),
  brevo = createBrevoClient(),
  recoveryIntervalMs = 30_000,
  timeoutMs = 10_000,
  logger
} = {}) {
  let timer = null
  let recovery = null
  let stopped = false
  const shutdown = new AbortController()
  const active = new Set()

  function report(row, state = row.state) {
    return { requestId: row.id, state }
  }

  function log(code, row) {
    logger?.warn?.({ event: 'newsletter_recovery', code, requestId: row?.id, state: row?.state }, 'newsletter_recovery')
  }

  async function reconcile(row, signal) {
    if (row.state === 'sending') {
      row = await repository.transition(row.id, 'uncertain', 'interrupted_send', ['sending'])
    }
    if (row.state !== 'uncertain') return report(row)
    const contact = await brevo.lookup(row.email, { signal })
    if (contact.kind === 'found' && (contact.inTempList || contact.inFinalList)) {
      const saved = await repository.transition(row.id, 'submitted', null, ['uncertain', 'sending'])
      return report(saved)
    }
    // A 404 or an absent list does not prove that no external effect occurred.
    const saved = await repository.transition(row.id, 'uncertain', contact.code || 'remote_result_unknown', ['uncertain'])
    return report(saved)
  }

  async function processRow(initialRow, signal) {
    let row = initialRow
    try {
      if (['submitted', 'rejected'].includes(row.state)) return report(row)
      if (['sending', 'uncertain'].includes(row.state)) return await reconcile(row, signal)

      const contact = await brevo.lookup(row.email, { signal })
      if (contact.kind === 'unavailable') {
        row = await repository.transition(row.id, 'ready', contact.code || 'dependency_unavailable', ['ready'])
        return report(row)
      }
      if (contact.kind === 'found' && contact.blocked) {
        row = await repository.transition(row.id, 'rejected', 'contact_blocked', ['ready'])
        return report(row)
      }
      if (contact.kind === 'found' && (contact.inTempList || contact.inFinalList)) {
        row = await repository.transition(row.id, 'submitted', null, ['ready'])
        return report(row)
      }
      if (!['found', 'not_found'].includes(contact.kind) || signal.aborted || stopped) return report(row)

      const phase = contact.kind === 'not_found' ? 'create_contact' : 'add_to_list'
      const claimed = await repository.claim(row.id, phase)
      if (!claimed) return report(await repository.get(row.id))
      row = claimed
      if (signal.aborted || stopped) {
        return report(await repository.transition(row.id, 'uncertain', 'interrupted_send', ['sending']))
      }
      const result = phase === 'create_contact'
        ? await brevo.create(row.email, { signal })
        : await brevo.addToList(row.email, { signal })
      if (result.kind === 'submitted') {
        return report(await repository.transition(row.id, 'submitted', null, ['sending', 'uncertain']))
      }
      if (result.kind === 'duplicate' || result.kind === 'deferred') {
        // An explicit rejection proves this particular mutation had no effect.
        return report(await repository.transition(row.id, 'ready', result.code, ['sending', 'uncertain']))
      }
      if (result.kind === 'rejected') {
        return report(await repository.transition(row.id, 'rejected', result.code, ['sending', 'uncertain']))
      }
      row = await repository.transition(row.id, 'uncertain', result.code || 'remote_result_unknown', ['sending'])
      return await reconcile(row, signal)
    } catch {
      log('processing_unavailable', row)
      if (['sending', 'uncertain'].includes(row.state)) {
        try { await repository.transition(row.id, 'uncertain', 'processing_unavailable', ['sending']) } catch { /* sending remains a durable barrier */ }
        return report(row, 'uncertain')
      }
      return report(row, 'ready')
    }
  }

  function run(operation) {
    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(timeoutMs)])
    const work = operation(signal)
    active.add(work)
    work.finally(() => active.delete(work)).catch(() => {})
    return work
  }

  async function subscribe(email) {
    if (stopped || !brevo.checkConfig().valid) return { state: 'unavailable' }
    if (typeof email !== 'string' || !email.trim()) return { state: 'rejected' }
    return run(async signal => {
      let row
      try {
        row = await repository.register(email.trim().toLowerCase(), brevo.listId)
      } catch {
        log('journal_unavailable')
        return { state: 'unavailable' }
      }
      return processRow(row, signal)
    })
  }

  function recover() {
    if (stopped || !brevo.checkConfig().valid) return Promise.resolve()
    if (recovery) return recovery
    recovery = (async () => {
      try {
        const rows = await repository.due(20, brevo.listId)
        for (const row of rows) {
          if (stopped) break
          await run(signal => processRow(row, signal))
        }
      } catch {
        log('journal_unavailable')
      }
    })().finally(() => { recovery = null })
    return recovery
  }

  function start() {
    if (timer || stopped) return
    void recover()
    timer = setInterval(() => { void recover() }, recoveryIntervalMs)
    timer.unref?.()
  }

  async function stop() {
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
    shutdown.abort()
    await Promise.allSettled([...active, ...(recovery ? [recovery] : [])])
  }

  return { subscribe, recover, start, stop }
}
