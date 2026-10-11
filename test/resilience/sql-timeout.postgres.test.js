import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const optionsPath = process.env.RESILIENCE_TEST_DATABASE_OPTIONS

test('the real application pool cancels a blocked SQL write before its client deadline and recovers', {
  skip: !optionsPath, timeout: 15_000
}, async t => {
  const options = JSON.parse(await readFile(optionsPath, 'utf8'))
  const schema = `sql_timeout_${randomUUID().replaceAll('-', '')}`
  const previousDisabledWorker = process.env.DISABLE_WORKER
  process.env.DISABLE_WORKER = 'true'
  const admin = new pg.Client({ ...options, connectionTimeoutMillis: 3000, query_timeout: 5000 })
  let app
  t.after(async () => {
    await app?.close()
    try {
      await admin.query('ROLLBACK')
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    } finally {
      await admin.end()
      if (previousDisabledWorker === undefined) delete process.env.DISABLE_WORKER
      else process.env.DISABLE_WORKER = previousDisabledWorker
    }
  })
  await admin.connect()
  await admin.query(`CREATE SCHEMA ${schema}`)
  await admin.query(`CREATE TABLE ${schema}.result (id integer PRIMARY KEY, value integer NOT NULL)`)
  await admin.query(`INSERT INTO ${schema}.result VALUES (1, 0)`)
  const url = new URL('postgresql://localhost')
  url.hostname = options.host
  url.port = String(options.port)
  url.username = options.user
  url.password = options.password
  url.pathname = `/${options.database}`
  const { buildApp } = await import('../../server.js')
  app = await buildApp({ databaseUrl: url.href, databaseConfigured: true,
    storageEnabled: false, initializeStorage: false, wallEnabled: false })
  await app.ready()
  const pid = (await app.pg.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  await admin.query('BEGIN')
  await admin.query(`UPDATE ${schema}.result SET value=1 WHERE id=1`)

  await assert.rejects(app.pg.query(`UPDATE ${schema}.result SET value=2 WHERE id=1`),
    error => error.code === '57014' && /statement timeout/.test(error.message))

  const waiting = await admin.query(`SELECT pid FROM pg_stat_activity
    WHERE pid=$1 AND wait_event_type='Lock'`, [pid])
  assert.equal(waiting.rowCount, 0, 'The server must stop waiting, not just reject the client promise')
  await admin.query('ROLLBACK')
  assert.equal((await admin.query(`SELECT value FROM ${schema}.result WHERE id=1`)).rows[0].value, 0)
  await app.pg.query(`UPDATE ${schema}.result SET value=2 WHERE id=1`)
  assert.equal((await app.pg.query(`SELECT value FROM ${schema}.result WHERE id=1`)).rows[0].value, 2)
})
