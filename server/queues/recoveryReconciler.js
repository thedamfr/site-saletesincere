import { isValidEpisodeIntent } from './episodeIntentBuffer.js'
import { isEpisodeCacheComplete } from './episodeQueue.js'
import { getOGImageS3Key } from '../services/ogImageLayout.js'
import { rearmFailedRecoveryJobs } from './recoveryPolicy.js'

export function createRecoveryReconciler({
  fetchEpisodes, database, enqueue, canRun = () => true,
  storageEnabled = false, youtubeResolutionEnabled = false,
  intervalMs = 30_000, logger, now = Date.now
}) {
  let stopped = false
  let active = null
  let timer = null
  let status = { state: 'idle', queued: 0, pending: 0, failed: 0, rearmed: 0, lastCompletedAt: null }
  const keyOf = value => `${value.season}:${value.episode}`

  function schedule() {
    if (stopped || timer) return
    timer = setTimeout(() => { timer = null; void reconcile() }, intervalMs)
    timer.unref?.()
  }

  function reconcile() {
    if (stopped) return Promise.resolve(status)
    if (active) return active
    active = Promise.resolve().then(async () => {
      if (!canRun()) return status
      status = { ...status, state: 'reconciling' }
      const { rearmed } = await rearmFailedRecoveryJobs(database)
      status = { ...status, rearmed }
      const episodes = await fetchEpisodes()
      if (stopped || !canRun()) return status
      // RSS is the durable source of desired enrichment, including trailers.
      // pg-boss remains the durable acceptance boundary and owns retries.
      const cacheRows = await database.query('SELECT * FROM episode_links')
      const jobRows = await database.query(`
        SELECT DISTINCT ON (data->>'season', data->>'episode') state, data
          FROM pgboss.job WHERE name = 'resolve-episode'
          ORDER BY data->>'season', data->>'episode', created_on DESC
      `)
      const cache = new Map(cacheRows.rows.map(row => [keyOf(row), row]))
      const jobs = new Map(jobRows.rows.map(row => [keyOf(row.data), row]))
      const result = { state: 'ready', queued: 0, pending: 0, failed: 0, rearmed, lastCompletedAt: null }
      for (const episode of episodes) {
        if (stopped || !canRun()) break
        const intent = {
          season: episode.season, episode: episode.episode,
          episodeDate: episode.rawPubDate, title: episode.title,
          imageUrl: episode.image ?? null, audioUrl: episode.audioUrl ?? null,
          itemGuid: episode.itemGuid ?? null, feedLastBuildDate: episode.feedLastBuildDate ?? null
        }
        if (!isValidEpisodeIntent(intent)) continue
        const cached = cache.get(keyOf(intent))
        if (isEpisodeCacheComplete(cached, {
          expectedOgImageS3Key: getOGImageS3Key(intent),
          feedLastBuildDate: intent.feedLastBuildDate,
          storageEnabled, youtubeResolutionEnabled, now: now()
        })) continue
        const previous = jobs.get(keyOf(intent))
        if (previous && ['created', 'retry', 'active'].includes(previous.state)) {
          result.pending += 1
          continue
        }
        const sameRevision = (previous?.data?.feedLastBuildDate ?? null) === intent.feedLastBuildDate
        if (previous?.state === 'failed' && sameRevision) {
          result.failed += 1
          continue
        }
        // A successfully persisted partial response is not an excuse to poll
        // external platforms forever. A new RSS revision or a visit can refresh it.
        if (previous?.state === 'completed' && sameRevision && cached) continue
        const accepted = await enqueue(intent)
        if (accepted?.queued) result.queued += 1
        else if (accepted?.reason !== 'ALREADY_QUEUED') result.pending += 1
      }
      result.lastCompletedAt = new Date(now()).toISOString()
      status = result
      logger?.info?.({ event: 'episode_recovery_reconciled', ...result }, 'episode_recovery_reconciled')
      return status
    }).catch(error => {
      status = { ...status, state: 'retry_scheduled' }
      logger?.warn?.({ event: 'episode_recovery_failed', errorCode: error?.code || error?.name || 'UNKNOWN' }, 'episode_recovery_failed')
      return status
    }).finally(() => {
      active = null
      schedule()
    })
    return active
  }

  return {
    reconcile,
    getStatus: () => ({ ...status }),
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      if (active) await active
      status = { ...status, state: 'stopped' }
    }
  }
}
