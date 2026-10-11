import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerOp3StatsQueue } from '../../server/queues/op3StatsQueue.js'
import { DatabaseState } from '../../server/resilience/databaseAvailability.js'

function createBoss() {
  const calls = []
  let handler = null
  return {
    calls,
    get handler() { return handler },
    async createQueue(...args) { calls.push(['createQueue', ...args]) },
    async updateQueue() {},
    getDb: () => ({ executeSql: async () => ({ rows: [] }) }),
    async work(...args) {
      handler = args.at(-1)
      calls.push(['work', ...args.slice(0, -1)])
    },
    async schedule(...args) { calls.push(['schedule', ...args]) },
    async send(...args) { calls.push(['send', ...args]); return 'job-id' }
  }
}

describe('registerOp3StatsQueue', () => {
  test('is silently disabled when OP3 configuration is incomplete', async () => {
    const boss = createBoss()

    const result = await registerOp3StatsQueue(boss, {
      pg: { pool: {} },
      databaseAvailability: { getState: () => DatabaseState.READ_WRITE }
    }, { env: {} })

    assert.deepEqual(result, { status: 'disabled' })
    assert.deepEqual(boss.calls, [])
  })

  test('registers the worker, daily schedule and initial deduplicated job on the supplied singleton', async () => {
    const boss = createBoss()
    const fastify = {
      pg: { pool: { name: 'shared-pool' } },
      databaseAvailability: { getState: () => DatabaseState.READ_WRITE }
    }

    const result = await registerOp3StatsQueue(boss, fastify, {
      env: { OP3_API_TOKEN: 'test-token', OP3_GUID: 'test-guid' },
      refresh: async () => ({ status: 'updated', updatedCount: 2 })
    })

    assert.deepEqual(result, { status: 'ready' })
    assert.equal(boss.calls[0][0], 'createQueue')
    assert.equal(boss.calls[0][1], 'op3-stats-refresh')
    assert.equal(boss.calls[0][2].expireInSeconds, 60)
    assert.deepEqual(boss.calls[1], ['work', 'op3-stats-refresh', { teamSize: 1 }])
    assert.equal(boss.calls[2][0], 'schedule')
    assert.equal(boss.calls[2][1], 'op3-stats-refresh')
    assert.equal(boss.calls[2][2], '0 3 * * *')
    assert.deepEqual(boss.calls[2][4], {
      key: 'daily-v1',
      tz: 'Europe/Paris',
      singletonKey: 'daily-v1',
      singletonSeconds: 60,
      expireInSeconds: 60, retryLimit: 3, retryDelay: 5, retryBackoff: false
    })
    assert.deepEqual(boss.calls[3], [
      'send',
      'op3-stats-refresh',
      {},
      { singletonKey: 'daily-v1', singletonSeconds: 60,
        expireInSeconds: 60, retryLimit: 3, retryDelay: 5, retryBackoff: false }
    ])
  })

  test('refreshes through the shared Fastify pool and current database state', async () => {
    const boss = createBoss()
    const pool = { name: 'shared-pool' }
    const received = []
    const fastify = {
      pg: { pool },
      databaseAvailability: { getState: () => DatabaseState.READ_ONLY }
    }

    await registerOp3StatsQueue(boss, fastify, {
      env: { OP3_API_TOKEN: 'test-token', OP3_GUID: 'test-guid' },
      async refresh(options) {
        received.push(options)
        return { status: 'skipped', reason: 'database_not_writable' }
      }
    })
    await assert.rejects(boss.handler([{ id: 'job-id', data: {} }]), /not writable/)
    assert.equal(received[0].pool, pool)
    assert.equal(received[0].databaseState, DatabaseState.READ_ONLY)
    assert.equal(received[0].token, 'test-token')
    assert.equal(received[0].podcastGuid, 'test-guid')
  })
})
