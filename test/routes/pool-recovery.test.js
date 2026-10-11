import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../../server.js'
import { createDatabaseAvailability, DatabaseState } from '../../server/resilience/databaseAvailability.js'

test('an idle PostgreSQL connection failure leaves public HTTP alive and reports degradation', async () => {
  const pool = new EventEmitter()
  const availability = createDatabaseAvailability({
    probe: async () => DatabaseState.UNAVAILABLE,
    initialState: DatabaseState.READ_WRITE
  })
  const app = await buildApp({
    initializeStorage: false,
    databaseConfigured: false,
    databaseAdapter: { pool },
    databaseAvailability: availability,
    podcastEpisodesFetcher: async () => []
  })
  try {
    assert.doesNotThrow(() => pool.emit('error', Object.assign(
      new Error('connection terminated unexpectedly'), { code: '57P01' }
    )))
    const home = await app.inject('/')
    const health = await app.inject('/health')
    assert.equal(home.statusCode, 200)
    assert.equal(health.statusCode, 200)
    assert.equal(health.json().database.state, 'unavailable')
  } finally {
    await app.close()
  }
  assert.equal(pool.listenerCount('error'), 0)
})
