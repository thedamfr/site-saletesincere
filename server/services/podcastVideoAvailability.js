const SPOTIFY_EPISODE_ID_PATTERN = /^[A-Za-z0-9]{1,64}$/

// Spotify oEmbed and the documented YouTube API expose video availability,
// but not the exact playback resolution. These labels are editorial facts
// confirmed for the episodes concerned and remain independent per platform.
const EDITORIAL_VIDEO_QUALITY = Object.freeze({
  '3:1': Object.freeze({ spotify: 'HD' }),
  '3:2': Object.freeze({ spotify: '4K', youtube: '4K' })
})

function parseSpotifyEpisodeUrl(value) {
  try {
    const url = new URL(value)
    const pathParts = url.pathname.split('/').filter(Boolean)
    if (
      url.protocol !== 'https:'
      || url.hostname !== 'open.spotify.com'
      || url.port
      || pathParts.length !== 2
      || pathParts[0] !== 'episode'
      || !SPOTIFY_EPISODE_ID_PATTERN.test(pathParts[1])
    ) {
      return null
    }

    return new URL(`https://open.spotify.com/episode/${pathParts[1]}`)
  } catch {
    return null
  }
}

function iframeReferencesSpotifyVideo(iframeUrl, episodeId) {
  try {
    const url = new URL(iframeUrl)
    return url.protocol === 'https:'
      && url.hostname === 'open.spotify.com'
      && url.pathname === `/embed/episode/${episodeId}/video`
  } catch {
    return false
  }
}

/**
 * Checks Spotify's public oEmbed representation for a direct episode URL.
 *
 * Returns true or false only for a successful, valid response. Network errors,
 * invalid inputs and malformed responses return null so callers can retry.
 */
export async function inspectSpotifyEpisodeVideo(spotifyEpisodeUrl, {
  fetchImpl = fetch,
  timeoutMs = 5000
} = {}) {
  const episodeUrl = parseSpotifyEpisodeUrl(spotifyEpisodeUrl)
  if (!episodeUrl) return null

  const oEmbedUrl = new URL('https://open.spotify.com/oembed')
  oEmbedUrl.searchParams.set('url', episodeUrl.toString())

  let response
  try {
    response = await fetchImpl(oEmbedUrl, {
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch {
    return null
  }
  if (!response?.ok) return null

  let data
  try {
    data = await response.json()
  } catch {
    return null
  }

  if (!data || typeof data !== 'object') return null
  const episodeId = episodeUrl.pathname.split('/').at(-1)
  return data.type === 'video'
    || iframeReferencesSpotifyVideo(data.iframe_url, episodeId)
}

export function getEpisodeVideoQuality(season, episode, platform) {
  if (!Number.isInteger(season) || !Number.isInteger(episode)) return null
  if (platform !== 'spotify' && platform !== 'youtube') return null
  return EDITORIAL_VIDEO_QUALITY[`${season}:${episode}`]?.[platform] || null
}
