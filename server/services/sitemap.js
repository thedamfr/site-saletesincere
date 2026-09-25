const ORIGIN = 'https://saletesincere.fr'
const STATIC_PATHS = ['/', '/damien-cavailles', '/photographie', '/podcast', '/laboratoire-du-geste']
const TTL = 60 * 60 * 1000
const RETRY = 5 * 60 * 1000

export function createSitemap({ fetchEpisodes, now = Date.now }) {
  let cached = null
  let refreshAt = 0
  let pending = null
  return async function getSitemap() {
    if (now() < refreshAt) {
      if (cached) return cached
      throw new Error('Sitemap temporarily unavailable')
    }
    if (!pending) {
      pending = (async () => {
        try {
          const episodes = await fetchEpisodes(5000)
          if (!Array.isArray(episodes)) throw new Error('Invalid episode feed')
          const paths = new Set(STATIC_PATHS)
          for (const item of episodes) {
            if (Number.isSafeInteger(item?.season) && item.season > 0 && Number.isSafeInteger(item?.episode) && item.episode > 0) {
              paths.add(`/podcast/${item.season}/${item.episode}`)
            }
          }
          cached = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            + [...paths].map(path => `  <url><loc>${ORIGIN}${path}</loc></url>`).join('\n') + '\n</urlset>\n'
          refreshAt = now() + TTL
          return cached
        } catch {
          refreshAt = now() + RETRY
          if (cached) return cached
          throw new Error('Sitemap temporarily unavailable')
        }
      })().finally(() => { pending = null })
    }
    return pending
  }
}
