import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configureRecoveryQueue, rearmFailedRecoveryJobs, RECOVERY_JOB_OPTIONS } from '../../server/queues/recoveryPolicy.js'

test('bounds legacy unfinished jobs and queue defaults without deleting accepted work', async () => {
  const calls = []
  const boss = {
    createQueue: async (...args) => calls.push(['create', ...args]),
    updateQueue: async (...args) => calls.push(['update', ...args]),
    getDb: () => ({ executeSql: async (...args) => { calls.push(['sql', ...args]); return { rows: [] } } })
  }
  await configureRecoveryQueue(boss, 'resolve-episode')
  assert.deepEqual(calls[0], ['create', 'resolve-episode', RECOVERY_JOB_OPTIONS])
  assert.deepEqual(calls[1], ['update', 'resolve-episode', RECOVERY_JOB_OPTIONS])
  const [, sql, params] = calls[2]
  assert.match(sql, /state IN \('created', 'retry', 'active'\)/)
  assert.doesNotMatch(sql, /DELETE|TRUNCATE/)
  assert.equal(params[0], 'resolve-episode')
  assert.equal(params[1], 60)
})

test('refuses to modify an unrelated queue', async () => {
  await assert.rejects(configureRecoveryQueue({}, 'newsletter'), /Unsupported recovery queue/)
})

test('rearms exhausted work with a durable cooldown and retained attempt history', async () => {
  let statement
  const result = await rearmFailedRecoveryJobs({ query: async sql => {
    statement = sql
    return { rows: [{ id: 'same-accepted-id', name: 'op3-stats-refresh' }] }
  } })
  assert.equal(result.rearmed, 1)
  assert.match(statement, /interval '60 seconds'/)
  assert.match(statement, /FOR UPDATE OF candidate SKIP LOCKED/)
  assert.match(statement, /retry_limit = GREATEST\(job.retry_limit, job.retry_count\) \+ 1/)
  assert.doesNotMatch(statement, /retry_count\s*=|DELETE|TRUNCATE/)
})
