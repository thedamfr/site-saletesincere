import { XMLParser } from 'fast-xml-parser'

const RSS_URL = 'https://podcasts.saletesincere.fr/@charbonwafer/feed.xml'
const MAX_DESCRIPTION_LENGTH = 400
const HLS_MEDIA_TYPES = new Set([
  'application/mpegurl',
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl'
])

function decodeAndNormalizeText(value = '') {
  return String(value)
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function extractItemGuid(guid) {
  if (typeof guid === 'string' || typeof guid === 'number') return String(guid)
  return guid?.['#text'] ? String(guid['#text']) : null
}

function asArray(value) {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function hasHttpSource(alternateEnclosure) {
  return asArray(alternateEnclosure?.['podcast:source']).some((source) => {
    const uri = source?.['@_uri']
    if (typeof uri !== 'string') return false

    try {
      const url = new URL(uri)
      return url.protocol === 'https:' || url.protocol === 'http:'
    } catch {
      return false
    }
  })
}

function extractVideoFormats(item) {
  const videoFormats = { mp4: false, hls: false }

  for (const alternateEnclosure of asArray(item?.['podcast:alternateEnclosure'])) {
    if (!hasHttpSource(alternateEnclosure)) continue

    const mediaType = String(alternateEnclosure?.['@_type'] || '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase()
    if (mediaType === 'video/mp4') videoFormats.mp4 = true
    if (HLS_MEDIA_TYPES.has(mediaType)) videoFormats.hls = true
  }

  return videoFormats
}

function mapEpisodeItem(item, feedLastBuildDate) {
  const durationSeconds = Number.parseInt(item?.['itunes:duration'], 10)
  const publicationDate = new Date(item?.pubDate)
  const season = Number.parseInt(item?.['itunes:season'], 10)
  const episode = item?.['itunes:episode']
    ? Number.parseInt(item['itunes:episode'], 10)
    : 0
  if (
    !Number.isInteger(season)
    || !Number.isInteger(episode)
    || Number.isNaN(publicationDate.getTime())
  ) return null

  const descriptionRaw = decodeAndNormalizeText(item.description)
  const isTruncated = descriptionRaw.length > MAX_DESCRIPTION_LENGTH
  const description = isTruncated
    ? `${descriptionRaw.substring(0, MAX_DESCRIPTION_LENGTH).trim()}...`
    : descriptionRaw
  const videoFormats = extractVideoFormats(item)

  return {
    season,
    episode,
    episodeType: item['itunes:episodeType'] || 'full',
    title: decodeAndNormalizeText(item.title),
    description,
    isTruncated,
    pubDate: formatDateFrench(publicationDate),
    rawPubDate: publicationDate.toISOString().split('T')[0],
    duration: formatDuration(durationSeconds),
    image: item['itunes:image']?.['@_href'] || null,
    audioUrl: item.enclosure?.['@_url'] || '',
    episodeLink: item.link || '',
    itemGuid: extractItemGuid(item.guid),
    feedLastBuildDate,
    hasVideo: videoFormats.mp4 || videoFormats.hls,
    videoFormats
  }
}

async function fetchRssEpisodes(timeout, fetchImpl) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetchImpl(RSS_URL, {
      signal: controller.signal,
      redirect: 'manual'
    })
    if (!response.ok) throw new Error(`RSS fetch failed: ${response.status}`)

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_'
    })
    const rss = parser.parse(await response.text())
    const channel = rss.rss?.channel
    const items = channel?.item || []
    const itemsArray = Array.isArray(items) ? items : [items]
    return itemsArray
      .map((item) => mapEpisodeItem(item, channel?.lastBuildDate || null))
      .filter(Boolean)
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function fetchPublishedEpisodesFromRSS(timeout = 5000, fetchImpl = fetch) {
  const episodes = await fetchRssEpisodes(timeout, fetchImpl)
  return episodes
    .filter((item) => item.itemGuid && item.episode >= 1 && item.episodeType === 'full')
    .sort((left, right) => new Date(right.rawPubDate) - new Date(left.rawPubDate))
}

export async function fetchEpisodeFromRSS(
  season,
  episode,
  timeout = 5000,
  fetchImpl = fetch
) {
  const episodes = await fetchRssEpisodes(timeout, fetchImpl)
  return episodes.find((item) => item.season === season && item.episode === episode) || null
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

function formatDateFrench(date) {
  const months = [
    'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
    'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'
  ]
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`
}

/**
 * @typedef {Object} EpisodeData
 * @property {number} season
 * @property {number} episode
 * @property {string} episodeType
 * @property {string} title
 * @property {string} description
 * @property {boolean} isTruncated
 * @property {string} pubDate
 * @property {string} rawPubDate
 * @property {string} duration
 * @property {string|null} image
 * @property {string} audioUrl
 * @property {string} episodeLink
 * @property {string|null} itemGuid
 * @property {string|null} feedLastBuildDate
 * @property {boolean} hasVideo
 * @property {{mp4: boolean, hls: boolean}} videoFormats
 */
