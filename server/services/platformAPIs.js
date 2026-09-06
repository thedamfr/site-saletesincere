/**
 * Platform APIs - Services de résolution des deeplinks podcast
 * Phase 1 TDD - Implémentation minimale
 */

export async function getSpotifyToken() {
  const clientId = process.env.SPOTIFY_CLIENT_ID
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error('Missing Spotify credentials')
  }

  const authString = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${authString}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  })

  if (!response.ok) {
    throw new Error(`Spotify auth failed: ${response.status}`)
  }

  const data = await response.json()
  return data.access_token
}

export async function searchSpotifyEpisode(episodeDate) {
  const token = await getSpotifyToken()
  const showId = process.env.SPOTIFY_SHOW_ID
  
  const response = await fetch(`https://api.spotify.com/v1/shows/${showId}/episodes?limit=50`, {
    headers: { 'Authorization': `Bearer ${token}` }
  })
  
  if (!response.ok) {
    return null
  }
  
  const data = await response.json()
  const episode = data.items.find(ep => ep.release_date === episodeDate)
  
  return episode ? episode.external_urls.spotify : null
}

export async function searchAppleEpisode(episodeDate) {
  const podcastId = process.env.APPLE_PODCAST_ID
  
  const response = await fetch(
    `https://itunes.apple.com/lookup?id=${podcastId}&entity=podcastEpisode&limit=200`
  )
  
  if (!response.ok) {
    return null
  }
  
  const data = await response.json()
  const episodes = data.results.filter(item => item.wrapperType === 'podcastEpisode')
  const episode = episodes.find(ep => ep.releaseDate.split('T')[0] === episodeDate)
  
  return episode ? episode.trackViewUrl : null
}

export async function searchDeezerEpisode(episodeDate) {
  const showId = process.env.DEEZER_SHOW_ID
  
  const response = await fetch(`https://api.deezer.com/podcast/${showId}/episodes?limit=50`)
  
  if (!response.ok) {
    return null
  }
  
  const data = await response.json()
  const episode = data.data.find(ep => ep.release_date.split(' ')[0] === episodeDate)
  
  return episode ? `https://www.deezer.com/fr/episode/${episode.id}` : null
}

export function isYouTubeEpisodeResolutionConfigured(env = process.env) {
  return Boolean(env.YOUTUBE_API_KEY && env.YOUTUBE_UPLOADS_PLAYLIST_ID)
}

function descriptionReferencesEpisode(description, season, episode) {
  if (typeof description !== 'string') return false

  const episodeUrlPattern = /https:\/\/saletesincere\.fr\/podcast\/(\d+)\/(\d+)/g
  const canonicalUrl = `https://saletesincere.fr/podcast/${season}/${episode}`
  return Array.from(description.matchAll(episodeUrlPattern)).some((match) => (
    match[0] === canonicalUrl
  ))
}

/**
 * Resolves a YouTube episode from the channel uploads playlist.
 *
 * The publication title and date are deliberately ignored. The contract is the
 * canonical smartlink URL in the YouTube description, for example:
 * https://saletesincere.fr/podcast/3/1
 */
function getYouTubeMaxResThumbnailUrl(snippet, videoId) {
  const thumbnail = snippet?.thumbnails?.maxres
  if (!thumbnail?.url || thumbnail.width < 1200 || thumbnail.height < 675) return null

  try {
    const url = new URL(thumbnail.url)
    const isSixteenByNine = Math.abs((thumbnail.width / thumbnail.height) - (16 / 9)) < 0.01
    if (
      url.protocol !== 'https:'
      || url.hostname !== 'i.ytimg.com'
      || url.pathname !== `/vi/${videoId}/maxresdefault.jpg`
      || !isSixteenByNine
    ) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

export async function searchYouTubeEpisodeMedia(season, episode, {
  apiKey = process.env.YOUTUBE_API_KEY,
  uploadsPlaylistId = process.env.YOUTUBE_UPLOADS_PLAYLIST_ID,
  fetchImpl = fetch,
  maxPages = 20
} = {}) {
  if (!apiKey || !uploadsPlaylistId) return null
  if (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 0) {
    return null
  }

  let pageToken = null
  const visitedTokens = new Set()

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems')
    url.searchParams.set('part', 'snippet')
    url.searchParams.set('playlistId', uploadsPlaylistId)
    url.searchParams.set('maxResults', '50')
    url.searchParams.set('key', apiKey)
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    let response
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(5000) })
    } catch {
      return null
    }
    if (!response.ok) return null

    let data
    try {
      data = await response.json()
    } catch {
      return null
    }

    const matchingItem = Array.isArray(data?.items)
      ? data.items.find(({ snippet }) => (
          descriptionReferencesEpisode(snippet?.description, season, episode)
          && /^[A-Za-z0-9_-]{11}$/.test(snippet?.resourceId?.videoId || '')
        ))
      : null

    if (matchingItem) {
      const videoId = matchingItem.snippet.resourceId.videoId
      return {
        url: `https://www.youtube.com/watch?v=${videoId}`,
        thumbnailUrl: getYouTubeMaxResThumbnailUrl(matchingItem.snippet, videoId)
      }
    }

    const nextPageToken = data?.nextPageToken
    if (!nextPageToken || visitedTokens.has(nextPageToken)) return null
    visitedTokens.add(nextPageToken)
    pageToken = nextPageToken
  }

  return null
}

export async function searchYouTubeEpisode(season, episode, options = {}) {
  const media = await searchYouTubeEpisodeMedia(season, episode, options)
  return media?.url || null
}

export function buildPodcastAddictLink(audioUrl) {
  if (!audioUrl || audioUrl.trim() === '') {
    throw new Error('audioUrl required')
  }
  
  const encodedUrl = encodeURIComponent(audioUrl)
  const podcastId = process.env.PODCASTADDICT_PODCAST_ID
  
  return `https://podcastaddict.com/episode/${encodedUrl}&podcastId=${podcastId}`
}

export function buildFallbackLinks() {
  const spotifyShowId = process.env.SPOTIFY_SHOW_ID
  const applePodcastId = process.env.APPLE_PODCAST_ID
  const deezerShowId = process.env.DEEZER_SHOW_ID
  const podcastAddictId = process.env.PODCASTADDICT_PODCAST_ID
  const pocketCastsUuid = process.env.POCKETCASTS_PODCAST_UUID
  const castopodUrl = process.env.CASTOPOD_RSS_URL || 'https://podcasts.saletesincere.fr/@charbonwafer/feed.xml'
  
  return {
    spotify: `https://open.spotify.com/show/${spotifyShowId}`,
    apple: `https://podcasts.apple.com/fr/podcast/id${applePodcastId}`,
    deezer: `https://www.deezer.com/fr/show/${deezerShowId}`,
    podcastAddict: `https://podcastaddict.com/podcast/${podcastAddictId}`,
    antennapod: castopodUrl,
    pocketCasts: `https://pca.st/podcast/${pocketCastsUuid}`,
    overcast: `https://overcast.fm/itunes${applePodcastId}`,
    castopod: castopodUrl
  }
}
