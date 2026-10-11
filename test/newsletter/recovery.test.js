import test from 'node:test'
import assert from 'node:assert/strict'
import { createNewsletterService } from '../../server/newsletter/newsletterService.js'

function memoryRepository() {
  const records = new Map()
  let sequence = 0
  return {
    records,
    async register(email, listId) {
      let row = [...records.values()].find(row => row.email === email && row.list_id === listId)
      if (!row) {
        row = { id: String(++sequence), email, list_id: listId, state: 'ready', phase: null }
        records.set(row.id, row)
      }
      return { ...row }
    },
    async get(id) { return { ...records.get(id) } },
    async claim(id, phase) {
      const row = records.get(id)
      if (row.state !== 'ready') return null
      Object.assign(row, { state: 'sending', phase })
      return { ...row }
    },
    async transition(id, state, code, expectedStates = ['ready', 'sending', 'uncertain']) {
      const row = records.get(id)
      if (expectedStates.includes(row.state)) Object.assign(row, { state, last_error_code: code })
      return { ...row }
    },
    async due() { return [...records.values()].filter(row => ['ready', 'sending', 'uncertain'].includes(row.state)).map(row => ({ ...row })) }
  }
}

function fixture(overrides = {}) {
  const repository = memoryRepository()
  const effects = []
  const brevo = {
    listId: 3,
    checkConfig: () => ({ valid: true }),
    lookup: async () => ({ kind: 'not_found' }),
    create: async (email) => { effects.push(email); return { kind: 'submitted' } },
    addToList: async (email) => { effects.push(email); return { kind: 'submitted' } },
    ...overrides
  }
  return { repository, effects, brevo, service: createNewsletterService({ repository, brevo }) }
}

test('acknowledged submissions survive a new service and repeated normalized emails without a second effect', async () => {
  const { repository, brevo, effects, service } = fixture()
  assert.equal((await service.subscribe('  READER@example.test  ')).state, 'submitted')
  const replacement = createNewsletterService({ repository, brevo })
  assert.equal((await replacement.subscribe('reader@example.test')).state, 'submitted')
  assert.deepEqual(effects, ['reader@example.test'])
  assert.equal(repository.records.size, 1)
})

test('database rejection prevents every external call', async () => {
  let externalCalls = 0
  const { service, repository } = fixture({ lookup: async () => { externalCalls++; return { kind: 'not_found' } } })
  repository.register = async () => { throw new Error('private database detail') }
  assert.equal((await service.subscribe('reader@example.test')).state, 'unavailable')
  assert.equal(externalCalls, 0)
})

test('the sending barrier is durable before the remote mutation', async () => {
  const { service, repository, brevo } = fixture()
  brevo.create = async () => {
    const row = [...repository.records.values()][0]
    assert.equal(row.state, 'sending')
    assert.equal(row.phase, 'create_contact')
    return { kind: 'submitted' }
  }
  assert.equal((await service.subscribe('reader@example.test')).state, 'submitted')
})

test('a crash at the sending barrier is reconciled only by reads, including after a second replacement', async () => {
  const { repository, brevo, effects } = fixture()
  const row = await repository.register('reader@example.test', 3)
  await repository.claim(row.id, 'create_contact')
  const first = createNewsletterService({ repository, brevo })
  await first.recover()
  assert.equal((await repository.get(row.id)).state, 'uncertain')
  const second = createNewsletterService({ repository, brevo })
  assert.equal((await second.subscribe('reader@example.test')).state, 'uncertain')
  await second.recover()
  assert.deepEqual(effects, [])
  brevo.lookup = async () => ({ kind: 'found', inTempList: true, inFinalList: false, blocked: false })
  await second.recover()
  assert.equal((await repository.get(row.id)).state, 'submitted')
  assert.deepEqual(effects, [])
})

test('response loss after the effect never sends a second mutation', async () => {
  const { repository, brevo, effects, service } = fixture()
  brevo.create = async email => { effects.push(email); return { kind: 'uncertain', code: 'network_error' } }
  assert.equal((await service.subscribe('reader@example.test')).state, 'uncertain')
  assert.equal((await service.subscribe('reader@example.test')).state, 'uncertain')
  brevo.lookup = async () => ({ kind: 'found', inTempList: false, inFinalList: true, blocked: false })
  const replacement = createNewsletterService({ repository, brevo })
  await replacement.recover()
  assert.equal((await replacement.subscribe('reader@example.test')).state, 'submitted')
  assert.equal(effects.length, 1)
})

test('ready requests resume after a dependency returns', async () => {
  const { service, repository, brevo, effects } = fixture({ lookup: async () => ({ kind: 'unavailable', code: 'network_error' }) })
  assert.equal((await service.subscribe('reader@example.test')).state, 'ready')
  brevo.lookup = async () => ({ kind: 'not_found' })
  const replacement = createNewsletterService({ repository, brevo })
  await replacement.recover()
  assert.equal((await replacement.subscribe('reader@example.test')).state, 'submitted')
  assert.equal(effects.length, 1)
})

test('simultaneous submissions can claim only one external mutation', async () => {
  const { service, effects } = fixture()
  await Promise.all([service.subscribe('reader@example.test'), service.subscribe('READER@example.test')])
  assert.equal(effects.length, 1)
})

test('blocked contacts are never added or unblocked', async () => {
  const { service, effects } = fixture({ lookup: async () => ({ kind: 'found', blocked: true, inTempList: false, inFinalList: false }) })
  assert.equal((await service.subscribe('reader@example.test')).state, 'rejected')
  assert.deepEqual(effects, [])
})

test('a failed local acknowledgement after remote acceptance remains recoverable by reads', async () => {
  const { service, repository, brevo, effects } = fixture()
  const transition = repository.transition
  repository.transition = async (...args) => {
    if (args[1] === 'submitted') throw new Error('database unavailable')
    return transition(...args)
  }
  assert.equal((await service.subscribe('reader@example.test')).state, 'uncertain')
  repository.transition = transition
  brevo.lookup = async () => ({ kind: 'found', inTempList: true, inFinalList: false, blocked: false })
  await createNewsletterService({ repository, brevo }).recover()
  assert.equal([...repository.records.values()][0].state, 'submitted')
  assert.equal(effects.length, 1)
})

test('startup recovery is single-flight and shutdown aborts an in-flight lookup', async () => {
  const { repository, brevo } = fixture()
  await repository.register('reader@example.test', 3)
  let announceLookup
  const lookupStarted = new Promise(resolve => { announceLookup = resolve })
  let lookups = 0
  brevo.lookup = async (_email, { signal }) => {
    lookups++
    announceLookup()
    return new Promise(resolve => {
      signal.addEventListener('abort', () => resolve({ kind: 'unavailable', code: 'request_timeout' }), { once: true })
    })
  }
  const service = createNewsletterService({ repository, brevo, recoveryIntervalMs: 10 })
  service.start()
  await lookupStarted
  const first = service.recover()
  const second = service.recover()
  assert.equal(first, second)
  await service.stop()
  assert.equal(lookups, 1)
  assert.equal((await service.subscribe('reader@example.test')).state, 'unavailable')
  assert.equal([...repository.records.values()][0].state, 'ready')
})
