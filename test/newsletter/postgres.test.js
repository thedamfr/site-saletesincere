import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { createNewsletterRepository } from '../../server/newsletter/newsletterRepository.js'
import { createNewsletterService } from '../../server/newsletter/newsletterService.js'

const optionsFile = process.env.NEWSLETTER_TEST_DATABASE_OPTIONS

test('newsletter journal on isolated PostgreSQL', { skip: !optionsFile }, async t => {
  const options = JSON.parse(await readFile(optionsFile, 'utf8'))
  assert.ok(['127.0.0.1', 'localhost'].includes(options.host), 'qualification requires a local test database or tunnel')
  const admin = new pg.Pool({ ...options, connectionTimeoutMillis: 2000, query_timeout: 3000 })
  const schema = `newsletter_test_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA ${schema}`)
  const database = new pg.Pool({ ...options, options: `-c search_path=${schema}`, connectionTimeoutMillis: 2000, query_timeout: 3000 })
  t.after(async () => {
    await database.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  })
  const migration = await readFile(new URL('../../sql/011_newsletter_requests.sql', import.meta.url), 'utf8')
  await database.query(migration)
  const repository = createNewsletterRepository(database)

  await t.test('migration reapplication retains durable requests and their state', async () => {
    const row = await repository.register('migration@example.test', 3)
    await repository.claim(row.id, 'create_contact')
    await database.query(migration)
    assert.equal((await repository.get(row.id)).state, 'sending')
  })

  await t.test('unique identity and compare-and-swap permit only one mutation claim', async () => {
    const submissions = await Promise.all(Array.from({ length: 5 }, () => repository.register('concurrent@example.test', 3)))
    assert.equal(new Set(submissions.map(row => row.id)).size, 1)
    const claims = await Promise.all(submissions.map(row => repository.claim(row.id, 'create_contact')))
    assert.equal(claims.filter(Boolean).length, 1)
  })

  await t.test('each permitted attempt is retained across retry and migration reapplication', async () => {
    const row = await repository.register('attempt-history@example.test', 3)
    await repository.claim(row.id, 'create_contact')
    await repository.transition(row.id, 'ready', 'remote_rate_limited', ['sending'])
    await repository.claim(row.id, 'add_to_list')
    let attempts = await database.query('SELECT id, phase, attempted_at FROM newsletter_attempts WHERE request_id = $1 ORDER BY attempted_at', [row.id])
    assert.deepEqual(attempts.rows.map(attempt => attempt.phase), ['create_contact', 'add_to_list'])
    assert.equal(new Set(attempts.rows.map(attempt => attempt.id)).size, 2)
    await database.query(migration)
    attempts = await database.query('SELECT id FROM newsletter_attempts WHERE request_id = $1', [row.id])
    assert.equal(attempts.rows.length, 2)
    assert.equal((await repository.get(row.id)).state, 'sending')
    await assert.rejects(database.query('DELETE FROM newsletter_attempts WHERE request_id = $1', [row.id]), { code: '55000' })
    await assert.rejects(database.query("UPDATE newsletter_attempts SET phase = 'create_contact' WHERE request_id = $1", [row.id]), { code: '55000' })
    await assert.rejects(database.query('TRUNCATE newsletter_attempts'), { code: '55000' })
  })

  await t.test('a failed attempt insertion rolls back the mutation barrier atomically', async () => {
    const row = await repository.register('atomic-attempt@example.test', 3)
    await database.query("ALTER TABLE newsletter_attempts ADD CONSTRAINT qualification_insert_failure CHECK (phase <> 'create_contact') NOT VALID")
    try {
      await assert.rejects(repository.claim(row.id, 'create_contact'), { code: '23514' })
      assert.equal((await repository.get(row.id)).state, 'ready')
      const attempts = await database.query('SELECT id FROM newsletter_attempts WHERE request_id = $1', [row.id])
      assert.equal(attempts.rows.length, 0)
    } finally {
      await database.query('ALTER TABLE newsletter_attempts DROP CONSTRAINT qualification_insert_failure')
    }
  })

  await t.test('read-only transactions fail registration before any external call', async () => {
    const client = await database.connect()
    let externalCalls = 0
    try {
      await client.query('BEGIN READ ONLY')
      const service = createNewsletterService({ database: client, brevo: {
        listId: 3, checkConfig: () => ({ valid: true }),
        lookup: async () => { externalCalls++; return { kind: 'not_found' } }
      } })
      assert.equal((await service.subscribe('readonly@example.test')).state, 'unavailable')
      assert.equal(externalCalls, 0)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  await t.test('private journal has no PUBLIC table grants', async () => {
    const result = await database.query(`
      SELECT count(*)::int AS grants
      FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      WHERE c.oid IN ('newsletter_requests'::regclass, 'newsletter_attempts'::regclass) AND a.grantee = 0`)
    assert.equal(result.rows[0].grants, 0)
  })

  await t.test('a replacement service reconciles interrupted writes without a mutation', async () => {
    const row = await repository.register('recovery@example.test', 3)
    await repository.claim(row.id, 'create_contact')
    await database.query("UPDATE newsletter_requests SET next_attempt_at = clock_timestamp() - interval '1 second' WHERE id = $1", [row.id])
    let mutations = 0
    const service = createNewsletterService({ repository, brevo: {
      listId: 3, checkConfig: () => ({ valid: true }),
      lookup: async () => ({ kind: 'found', inTempList: true, inFinalList: false, blocked: false }),
      create: async () => { mutations++; return { kind: 'submitted' } }
    } })
    await service.recover()
    assert.equal((await repository.get(row.id)).state, 'submitted')
    assert.equal(mutations, 0)
  })
})
