import { DatabaseState } from '../resilience/databaseAvailability.js'

const OP3_API_BASE_URL = 'https://op3.dev/api/1'
const POPULARITY_THRESHOLD = 10
const RECENT_SNAPSHOT_MS = 36 * 60 * 60 * 1000
const MAX_HISTORICAL_AGE_MS = 7 * 24 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
// OP3 is called only by the background worker; the paginated raw-download query
// can legitimately take longer than an interactive HTTP request.
const OP3_TIMEOUT_MS = 30000

let cachedShowUuid = null
let cachedPodcastGuid = null

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

function asValidDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function publicationKey(title, pubdate) {
  const date = asValidDate(pubdate)
  if (typeof title !== 'string' || !title.trim() || !date) return null
  return `${title.trim()}\u0000${date.toISOString().slice(0, 10)}`
}

function compareCandidates(left, right, metric) {
  const difference = right.stat[metric] - left.stat[metric]
  if (difference !== 0) return difference
  return new Date(right.episode.rawPubDate).getTime()
    - new Date(left.episode.rawPubDate).getTime()
}

function ageInMilliseconds(fetchedAt, now) {
  const fetchedDate = asValidDate(fetchedAt)
  if (!fetchedDate) return Number.POSITIVE_INFINITY
  return now.getTime() - fetchedDate.getTime()
}

export function selectPopularEpisode({ episodes, stats, now = new Date() }) {
  const nowDate = asValidDate(now)
  if (!nowDate || !Array.isArray(episodes) || !Array.isArray(stats)) return null

  const publishedEpisodes = episodes.filter((item) => {
    const publicationDate = asValidDate(item?.rawPubDate)
    return item?.itemGuid && publicationDate && publicationDate <= nowDate
  })
  if (publishedEpisodes.length < 3) return null

  const statsByGuid = new Map(stats.map((row) => [row?.itemGuid, row]))
  const candidates = publishedEpisodes
    .map((item) => ({ episode: item, stat: statsByGuid.get(item.itemGuid) }))
    .filter(({ stat: row }) => row && ageInMilliseconds(row.fetchedAt, nowDate) <= MAX_HISTORICAL_AGE_MS)

  const weekly = candidates
    .filter(({ stat: row }) => ageInMilliseconds(row.fetchedAt, nowDate) <= RECENT_SNAPSHOT_MS)
    .filter(({ stat: row }) => isNonNegativeInteger(row.downloads7) && row.downloads7 >= POPULARITY_THRESHOLD)
    .sort((left, right) => compareCandidates(left, right, 'downloads7'))[0]

  if (weekly) {
    return {
      kind: 'weekly',
      label: 'Le plus populaire cette semaine',
      downloads: weekly.stat.downloadsAll,
      weeklyDownloads: weekly.stat.downloads7,
      displayText: formatCumulativeDownloadsForDisplay(weekly.stat.downloadsAll),
      episode: weekly.episode
    }
  }

  const historical = candidates
    .filter(({ stat: row }) => isNonNegativeInteger(row.downloadsAll) && row.downloadsAll >= POPULARITY_THRESHOLD)
    .sort((left, right) => compareCandidates(left, right, 'downloadsAll'))[0]

  if (!historical) return null
  return {
    kind: 'allTime',
    label: "L'épisode le plus populaire",
    downloads: historical.stat.downloadsAll,
    displayText: formatCumulativeDownloadsForDisplay(historical.stat.downloadsAll),
    episode: historical.episode
  }
}

function formatCumulativeDownloadsForDisplay(downloads) {
  const displayText = formatDownloadsForDisplay(downloads)
  if (!displayText) return null
  return `Déjà ${downloads} téléchargements depuis sa sortie, mesurés par OP3`
}

export function formatDownloadsForDisplay(downloads) {
  if (!isNonNegativeInteger(downloads) || downloads < POPULARITY_THRESHOLD) return null
  return downloads === 1
    ? '1 téléchargement mesuré par OP3'
    : `${downloads} téléchargements mesurés par OP3`
}

export function getEpisodeDownloadProof(stats, now = new Date()) {
  const nowDate = asValidDate(now)
  if (
    !nowDate
    || !stats
    || ageInMilliseconds(stats.fetchedAt, nowDate) > MAX_HISTORICAL_AGE_MS
  ) return null
  const displayText = formatDownloadsForDisplay(stats.downloadsAll)
  return displayText
    ? { downloadsAll: stats.downloadsAll, displayText }
    : null
}

export const formatStatsForDisplay = formatDownloadsForDisplay

async function fetchJson(fetchImpl, url, token, signal) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), OP3_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, {
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'SaleteSincere/1.0'
      }
    })
    if (!response?.ok) {
      throw new Error(`OP3 request failed with status ${response?.status || 'unknown'}`)
    }
    return await response.json()
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('OP3 request timed out')
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

function validateShowInfo(data) {
  if (!data || typeof data.showUuid !== 'string' || !/^[a-f0-9]{32}$/i.test(data.showUuid)) {
    throw new Error('OP3 show response is invalid')
  }
  if (!Array.isArray(data.episodes)) {
    throw new Error('OP3 show episode response is invalid')
  }
  return data
}

function validateAggregate(data, showUuid) {
  if (!data || data.showUuid !== showUuid || !Array.isArray(data.episodes)) {
    throw new Error('OP3 aggregate response is invalid')
  }
  const seenGuids = new Set()
  const validEpisodes = []
  for (const item of data.episodes) {
    if (
      typeof item?.itemGuid !== 'string'
      || !item.itemGuid.trim()
      || !publicationKey(item.title, item.pubdate)
      || seenGuids.has(item.itemGuid)
    ) {
      throw new Error('OP3 aggregate episode is invalid')
    }
    seenGuids.add(item.itemGuid)
    if (isNonNegativeInteger(item.downloadsAll)) validEpisodes.push(item)
  }
  return validEpisodes
}

async function fetchRecentDownloads({ fetchImpl, token, showUuid, now, signal }) {
  const start = new Date(now.getTime() - THIRTY_DAYS_MS)
  let continuationToken = null
  const seenTokens = new Set()
  const rows = []

  do {
    signal?.throwIfAborted()
    const url = new URL(`${OP3_API_BASE_URL}/downloads/show/${showUuid}`)
    url.searchParams.set('start', start.toISOString())
    url.searchParams.set('end', now.toISOString())
    url.searchParams.set('limit', '20000')
    url.searchParams.set('format', 'json')
    url.searchParams.set('bots', 'exclude')
    if (continuationToken) url.searchParams.set('continuationToken', continuationToken)

    const data = await fetchJson(fetchImpl, url, token, signal)
    if (!data || !Array.isArray(data.rows)) {
      throw new Error('OP3 downloads response is invalid')
    }
    for (const row of data.rows) {
      const time = asValidDate(row?.time)
      if (typeof row?.episodeId !== 'string' || !row.episodeId || !time) {
        throw new Error('OP3 download row is invalid')
      }
      rows.push({ episodeId: row.episodeId, time })
    }

    continuationToken = data.continuationToken || null
    if (continuationToken) {
      if (typeof continuationToken !== 'string' || seenTokens.has(continuationToken)) {
        throw new Error('OP3 continuation token is invalid')
      }
      seenTokens.add(continuationToken)
    }
  } while (continuationToken)

  return rows
}

export async function fetchOp3Snapshot({
  fetchImpl = fetch,
  token = process.env.OP3_API_TOKEN,
  podcastGuid = process.env.OP3_GUID,
  now = new Date(),
  signal
} = {}) {
  if (!token || !podcastGuid) throw new Error('OP3 configuration is incomplete')
  const nowDate = asValidDate(now)
  if (!nowDate) throw new TypeError('Invalid OP3 snapshot time')

  let showInfo
  if (cachedShowUuid && cachedPodcastGuid === podcastGuid) {
    showInfo = await fetchJson(
      fetchImpl,
      `${OP3_API_BASE_URL}/shows/${encodeURIComponent(cachedShowUuid)}?episodes=include`,
      token, signal
    )
  } else {
    showInfo = await fetchJson(
      fetchImpl,
      `${OP3_API_BASE_URL}/shows/${encodeURIComponent(podcastGuid)}?episodes=include`,
      token, signal
    )
  }
  const validatedShow = validateShowInfo(showInfo)
  cachedShowUuid = validatedShow.showUuid
  cachedPodcastGuid = podcastGuid

  const aggregate = validateAggregate(await fetchJson(
    fetchImpl,
    `${OP3_API_BASE_URL}/queries/episode-download-counts?showUuid=${validatedShow.showUuid}`,
    token, signal
  ), validatedShow.showUuid)
  const recentDownloads = await fetchRecentDownloads({
    fetchImpl,
    token,
    showUuid: validatedShow.showUuid,
    now: nowDate,
    signal
  })

  const showEpisodesByKey = new Map()
  for (const item of validatedShow.episodes) {
    const key = publicationKey(item?.title, item?.pubdate)
    if (!key || typeof item?.id !== 'string' || !item.id) continue
    showEpisodesByKey.set(key, showEpisodesByKey.has(key) ? null : item.id)
  }

  const countsByEpisodeId = new Map()
  for (const download of recentDownloads) {
    const counts = countsByEpisodeId.get(download.episodeId) || { downloads7: 0, downloads30: 0 }
    const age = nowDate.getTime() - download.time.getTime()
    if (age >= 0 && age <= THIRTY_DAYS_MS) counts.downloads30 += 1
    if (age >= 0 && age <= SEVEN_DAYS_MS) counts.downloads7 += 1
    countsByEpisodeId.set(download.episodeId, counts)
  }

  const episodes = aggregate.flatMap((item) => {
    const episodeId = showEpisodesByKey.get(publicationKey(item.title, item.pubdate))
    if (!episodeId) return []
    const counts = countsByEpisodeId.get(episodeId) || { downloads7: 0, downloads30: 0 }
    return [{
      itemGuid: item.itemGuid,
      downloads7: counts.downloads7,
      downloads30: counts.downloads30,
      downloadsAll: item.downloadsAll
    }]
  })

  if (episodes.length === 0) throw new Error('OP3 response is invalid: no episode mapping')
  return { episodes, fetchedAt: nowDate }
}

export async function refreshOp3StatsCache({
  pool,
  databaseState,
  fetchImpl = fetch,
  token = process.env.OP3_API_TOKEN,
  podcastGuid = process.env.OP3_GUID,
  now = new Date(),
  signal
} = {}) {
  if (!token || !podcastGuid) return { status: 'disabled' }
  if (databaseState !== DatabaseState.READ_WRITE) {
    return { status: 'skipped', reason: 'database_not_writable' }
  }
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('OP3 refresh requires a PostgreSQL pool')
  }

  const snapshot = await fetchOp3Snapshot({ fetchImpl, token, podcastGuid, now, signal })
  signal?.throwIfAborted()
  const client = await pool.connect()
  let transactionStarted = false
  let transactionError
  try {
    await client.query('BEGIN')
    transactionStarted = true
    for (const item of snapshot.episodes) {
      signal?.throwIfAborted()
      await client.query(`
        INSERT INTO op3_stats (
          item_guid, downloads_7, downloads_30, downloads_all, fetched_at
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (item_guid) DO UPDATE SET
          downloads_7 = EXCLUDED.downloads_7,
          downloads_30 = EXCLUDED.downloads_30,
          downloads_all = EXCLUDED.downloads_all,
          fetched_at = EXCLUDED.fetched_at
      `, [
        item.itemGuid,
        item.downloads7,
        item.downloads30,
        item.downloadsAll,
        snapshot.fetchedAt
      ])
    }
    signal?.throwIfAborted()
    await client.query('COMMIT')
    return { status: 'updated', updatedCount: snapshot.episodes.length }
  } catch (error) {
    transactionError = error
    if (transactionStarted) await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release(transactionError)
  }
}

export async function getEpisodeStats(pool, itemGuid) {
  if (!pool || typeof pool.query !== 'function' || !itemGuid) return null
  const result = await pool.query(`
    SELECT item_guid, downloads_7, downloads_30, downloads_all, fetched_at
    FROM op3_stats
    WHERE item_guid = $1
  `, [itemGuid])
  const row = result.rows[0]
  return row ? mapCacheRow(row) : null
}

export async function getEpisodeStatsForGuids(pool, itemGuids) {
  if (!pool || typeof pool.query !== 'function' || !Array.isArray(itemGuids) || itemGuids.length === 0) {
    return []
  }
  const result = await pool.query(`
    SELECT item_guid, downloads_7, downloads_30, downloads_all, fetched_at
    FROM op3_stats
    WHERE item_guid = ANY($1::text[])
  `, [itemGuids])
  return result.rows.map(mapCacheRow)
}

function mapCacheRow(row) {
  return {
    itemGuid: row.item_guid,
    downloads7: row.downloads_7,
    downloads30: row.downloads_30,
    downloadsAll: row.downloads_all,
    fetchedAt: row.fetched_at
  }
}

export async function initOP3Service() {
  return process.env.OP3_API_TOKEN && process.env.OP3_GUID
    ? { status: 'configured' }
    : { status: 'disabled' }
}

export async function updateOP3StatsCache(pool, options = {}) {
  const result = await refreshOp3StatsCache({
    pool,
    databaseState: DatabaseState.UNKNOWN,
    ...options
  })
  return result.updatedCount || 0
}
