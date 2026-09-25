import { readFileSync } from 'node:fs'
import { createSitemap } from '../services/sitemap.js'

// Generated at build time. No Markdown parser or source files are used at runtime.
let author
try {
  author = JSON.parse(readFileSync(new URL('../generated/author.json', import.meta.url), 'utf8'))
} catch {
  // A missing build must not prevent HTTP liveness or unrelated routes from starting.
}
const canonical = 'https://saletesincere.fr/damien-cavailles'

export function registerAuthorSeo(app, { fetchEpisodes, pageLimiter }) {
  const getSitemap = createSitemap({ fetchEpisodes })
  app.get('/damien-cavailles', { config: { rateLimit: pageLimiter } }, async (request, reply) => {
    if (!author) return reply.code(503).header('Cache-Control', 'no-store').header('Retry-After', '300').send('Page temporairement indisponible')
    const structuredData = JSON.stringify({
      '@context': 'https://schema.org', '@type': 'ProfilePage', url: canonical,
      mainEntity: {
        '@type': 'Person', '@id': `${canonical}#person`, name: author.name,
        url: canonical, description: author.role,
        image: 'https://saletesincere.fr/images/damien-podcast.jpg',
        sameAs: ['https://www.linkedin.com/in/damiencavailles/', 'https://welovedevs.com/author/damien/']
      }
    }).replace(/</g, '\\u003c')
    return reply.header('Cache-Control', 'public, max-age=300').view('author.hbs', { ...author, canonical, structuredData })
  })
  app.get('/damien-cavailles/', async (request, reply) => reply.code(301).redirect('/damien-cavailles'))
  app.get('/damien-cavailles/portrait.jpg', async (request, reply) => reply
    .header('Content-Disposition', 'attachment; filename="damien-cavailles-portrait-officiel.jpg"')
    .sendFile('images/damien-podcast.jpg'))
  app.get('/robots.txt', async (request, reply) => reply.type('text/plain; charset=utf-8')
    .send('User-agent: *\nAllow: /\n\nSitemap: https://saletesincere.fr/sitemap.xml\n'))
  app.get('/sitemap.xml', async (request, reply) => {
    try {
      return reply.type('application/xml; charset=utf-8').header('Cache-Control', 'public, max-age=300').send(await getSitemap())
    } catch {
      return reply.code(503).header('Retry-After', '300').header('Cache-Control', 'no-store').send('Sitemap temporairement indisponible')
    }
  })
}
