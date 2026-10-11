import { refreshOp3StatsCache } from '../services/op3Service.js'
import { configureRecoveryQueue, RECOVERY_JOB_OPTIONS, createRecoveryAttempt } from './recoveryPolicy.js'

export const OP3_STATS_QUEUE = 'op3-stats-refresh'
const OP3_SCHEDULE_KEY = 'daily-v1'

export function isOp3Configured(env = process.env) {
  return Boolean(env.OP3_API_TOKEN && env.OP3_GUID)
}

export async function registerOp3StatsQueue(boss, fastify, {
  env = process.env,
  refresh = refreshOp3StatsCache
} = {}) {
  if (!isOp3Configured(env)) return { status: 'disabled' }
  if (!boss) throw new TypeError('OP3 stats queue requires the shared pg-boss instance')

  await configureRecoveryQueue(boss, OP3_STATS_QUEUE)
  await boss.work(OP3_STATS_QUEUE, { teamSize: 1 }, async () => {
    const attempt = createRecoveryAttempt(boss)
    try {
      const result = await refresh({
        pool: fastify.pg.pool,
        databaseState: fastify.databaseAvailability.getState(),
        token: env.OP3_API_TOKEN,
        podcastGuid: env.OP3_GUID,
        signal: attempt.signal
      })
      if (result?.reason === 'database_not_writable') {
        throw Object.assign(new Error('OP3 database is not writable'), { code: '25006' })
      }
      return result
    } finally {
      attempt.finish()
    }
  })
  await boss.schedule(OP3_STATS_QUEUE, '0 3 * * *', {}, {
    ...RECOVERY_JOB_OPTIONS,
    key: OP3_SCHEDULE_KEY,
    tz: 'Europe/Paris',
    singletonKey: OP3_SCHEDULE_KEY,
    singletonSeconds: 60
  })
  const { rows } = await boss.getDb().executeSql(`
    SELECT id FROM pgboss.job
     WHERE name = $1 AND state IN ('created', 'retry', 'active') LIMIT 1
  `, [OP3_STATS_QUEUE])
  if (!rows.length) {
    await boss.send(OP3_STATS_QUEUE, {}, {
      ...RECOVERY_JOB_OPTIONS,
      singletonKey: OP3_SCHEDULE_KEY,
      singletonSeconds: 60
    })
  }

  return { status: 'ready' }
}
