import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRecoveryReconciler } from '../../server/queues/recoveryReconciler.js'

const episode = { season: 2, episode: 0, rawPubDate: '2026-10-11', title: 'Bande annonce',
  image: null, audioUrl: 'https://example.test/audio.mp3', itemGuid: 'trailer-guid', feedLastBuildDate: '2026-10-11' }

test('reconstructs lost intentions from RSS after a fresh process without a visit', async () => {
  const accepted = []
  const reconciler = createRecoveryReconciler({
    fetchEpisodes: async () => [episode],
    database: { query: async () => ({ rows: [] }) },
    enqueue: async intent => { accepted.push(intent); return { queued: true } },
    storageEnabled: false
  })
  const result = await reconciler.reconcile()
  await reconciler.stop()
  assert.equal(result.queued, 1)
  assert.equal(accepted[0].episode, 0)
  assert.equal(accepted[0].itemGuid, 'trailer-guid')
})

test('retains failed reconstruction for the next cycle and avoids overlapping fetches', async () => {
  let completeFetch
  let fetches = 0
  const reconciler = createRecoveryReconciler({
    fetchEpisodes: () => { fetches += 1; return new Promise(resolve => { completeFetch = resolve }) },
    database: { query: async () => ({ rows: [] }) },
    enqueue: async () => ({ queued: false, reason: 'QUEUE_ERROR' }),
    storageEnabled: false
  })
  const first = reconciler.reconcile()
  const second = reconciler.reconcile()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fetches, 1)
  completeFetch([episode])
  const result = await first
  await second
  assert.equal(result.pending, 1)
  await reconciler.stop()
  assert.equal(reconciler.getStatus().state, 'stopped')
})

test('reports an exhausted durable job instead of recreating unlimited retries', async () => {
  let enqueued = false
  const reconciler = createRecoveryReconciler({
    fetchEpisodes: async () => [episode],
    database: { query: async sql => ({ rows: sql.includes('pgboss.job') ? [{
      state: 'failed', data: { season: 2, episode: 0, feedLastBuildDate: '2026-10-11' }
    }] : [] }) },
    enqueue: async () => { enqueued = true; return { queued: true } }, storageEnabled: false
  })
  const result = await reconciler.reconcile()
  await reconciler.stop()
  assert.equal(enqueued, false)
  assert.equal(result.failed, 1)
})

test('rearms durable episode and OP3 work before an unavailable RSS can block reconstruction', async () => {
  const order = []
  const reconciler = createRecoveryReconciler({
    database: { query: async () => { order.push('durable-retry'); return { rows: [{ id: 'preserved-id' }] } } },
    fetchEpisodes: async () => { order.push('rss'); throw new Error('RSS unavailable') },
    enqueue: async () => assert.fail('No new jobs while RSS is unavailable')
  })
  const result = await reconciler.reconcile()
  await reconciler.stop()
  assert.deepEqual(order, ['durable-retry', 'rss'])
  assert.equal(result.rearmed, 1)
  assert.equal(result.state, 'retry_scheduled')
})
