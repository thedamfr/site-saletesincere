// pg-boss 11: explicit limits apply to both new and already accepted jobs.
export const RECOVERY_JOB_OPTIONS = Object.freeze({
  expireInSeconds: 60,
  retryLimit: 3,
  retryDelay: 5,
  retryBackoff: false
})
export const RECOVERY_ATTEMPT_TIMEOUT_MS = 45_000
const activeAttempts = new WeakMap()

export function createRecoveryAttempt(owner) {
  const controller = new AbortController()
  const attempts = activeAttempts.get(owner) || new Set()
  activeAttempts.set(owner, attempts)
  attempts.add(controller)
  return {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(RECOVERY_ATTEMPT_TIMEOUT_MS)]),
    finish: () => attempts.delete(controller)
  }
}

export function abortRecoveryAttempts(owner) {
  for (const controller of activeAttempts.get(owner) || []) {
    controller.abort(Object.assign(new Error('Worker is stopping'), { code: 'WORKER_STOPPING' }))
  }
}

export async function rearmFailedRecoveryJobs(database) {
  // After the short retry budget is exhausted, one attempt per minute remains
  // eligible. A prolonged provider outage must not require a new visit or boot.
  // Lock the accepted row itself so multiple reconcilers cannot reset its state.
  const { rows } = await database.query(`
    WITH due AS (
      SELECT candidate.id
        FROM pgboss.job AS candidate
       WHERE candidate.name IN ('resolve-episode', 'op3-stats-refresh')
         AND candidate.state = 'failed'
         AND candidate.completed_on <= now() - interval '60 seconds'
         AND NOT EXISTS (
           SELECT 1 FROM pgboss.job AS other
            WHERE other.name = candidate.name AND other.id <> candidate.id
              AND (candidate.name = 'op3-stats-refresh' OR (
                other.data->>'season' = candidate.data->>'season'
                AND other.data->>'episode' = candidate.data->>'episode'
              ))
              AND (other.state IN ('created', 'retry', 'active')
                OR (other.created_on, other.id) > (candidate.created_on, candidate.id))
         )
       ORDER BY candidate.completed_on
       LIMIT 100 FOR UPDATE OF candidate SKIP LOCKED
    )
    UPDATE pgboss.job AS job
       SET state = 'retry', start_after = now(), completed_on = NULL,
           retry_limit = GREATEST(job.retry_limit, job.retry_count) + 1,
           retry_delay = 5, retry_backoff = false, expire_seconds = 60,
           keep_until = GREATEST(job.keep_until, now() + interval '14 days')
      FROM due WHERE job.id = due.id
      RETURNING job.id, job.name
  `)
  return { rearmed: rows.length }
}

export async function configureRecoveryQueue(boss, name) {
  if (!['resolve-episode', 'op3-stats-refresh'].includes(name)) {
    throw new TypeError('Unsupported recovery queue')
  }
  await boss.createQueue(name, { ...RECOVERY_JOB_OPTIONS })
  await boss.updateQueue(name, { ...RECOVERY_JOB_OPTIONS })
  // createQueue/updateQueue do not modify metadata captured on existing jobs.
  // Keep IDs, payloads, attempts and states. The supervisor owns expiration.
  await boss.getDb().executeSql(`
    UPDATE pgboss.job
       SET expire_seconds = $2, retry_limit = GREATEST(retry_limit, retry_count, $3), retry_delay = $4,
           retry_backoff = false
     WHERE name = $1 AND state IN ('created', 'retry', 'active')
       AND (expire_seconds <> $2 OR retry_limit < $3 OR retry_limit < retry_count OR retry_delay <> $4 OR retry_backoff)
  `, [name, RECOVERY_JOB_OPTIONS.expireInSeconds, RECOVERY_JOB_OPTIONS.retryLimit,
    RECOVERY_JOB_OPTIONS.retryDelay])
}
