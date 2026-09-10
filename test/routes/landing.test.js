import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Jimp } from 'jimp'
import { buildApp } from '../../server.js'

const apps = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

async function createApp(podcastEpisodesFetcher = async () => []) {
  const app = await buildApp({
    initializeStorage: false,
    databaseConfigured: false,
    podcastEpisodesFetcher
  })
  apps.push(app)
  return app
}

function publishedEpisodes() {
  return [
    {
      season: 3,
      episode: 3,
      title: 'CHARBON - Pourquoi faire carrière dans l’intégration ERP en 2025 ?',
      duration: '48:12'
    },
    {
      season: 3,
      episode: 2,
      title: 'WAFER — La face cachée des fichiers produit',
      duration: '34:28'
    },
    {
      season: 3,
      episode: 1,
      title: 'FISSURE : De consultant à fondateur : le grand écart',
      duration: '52:13'
    },
    {
      season: 2,
      episode: 9,
      title: 'Un épisode qui ne doit pas apparaître',
      duration: '29:00'
    }
  ]
}

function assertContains(body, pattern) {
  assert.ok(pattern.test(body), `Expected landing HTML to match ${pattern}`)
}

function assertExcludes(body, pattern) {
  assert.ok(!pattern.test(body), `Expected landing HTML not to match ${pattern}`)
}

describe('GET / landing redesign', () => {
  test('renders the light Saleté Sincère identity and all required sections', async () => {
    const app = await createApp()

    const response = await app.inject({ method: 'GET', url: '/' })

    assert.equal(response.statusCode, 200)
    assertContains(response.body, /class="landing-page"/)
    assertContains(response.body, /<link rel="stylesheet" href="\/style\.css\?v=s-gesture-11">/)
    assertContains(response.body, /logo-salete-sincere-horizontal\.png/)
    assertContains(response.body, /class="landing-hero-mark"[^>]*data-logo-replay[^>]*aria-label="Rejouer l’animation du logo"/)
    assertContains(response.body, /data-logo-animation[^>]*src="\/images\/logo-noname-web\.svg\?v=s-gesture-11"[^>]*alt=""[^>]*aria-hidden="true"/)
    assertContains(response.body, /<script src="\/js\/landing\.js" defer><\/script>/)
    assertContains(response.body, /On gratte la surface pour retrouver la saleté sincère\./i)
    assertContains(response.body, /250 à 400 € par séance/)
    assertContains(response.body, /en fonction des projets/)
    assertContains(response.body, /Épouser le cadre corporate et relations publiques/i)
    assertContains(response.body, /Les personnes se sentent à l’aise pour s’exprimer/i)
    assertExcludes(response.body, /Cette alchimie agence/i)
    assertExcludes(response.body, /Une marque éditoriale pour un meilleur réel/i)
    assertExcludes(response.body, /—/)
    assertContains(response.body, /Damien Cavaillès - Saleté Sincère 2026/)
    assertContains(response.body, /Logo par/)
    assertContains(response.body, /href="https:\/\/www\.instagram\.com\/eva\.navaux\/"[^>]*>Eva « Blaster » Navaux<\/a>/)
    assertContains(response.body, /Photos par/)
    assertContains(response.body, /NCLS\.tv/)
    assertContains(response.body, /Charlotte Coppens/)
    assertContains(response.body, /class="landing-footer-identity">[\s\S]*Damien Cavaillès - Saleté Sincère 2026[\s\S]*class="landing-credits"/)
    assertContains(response.body, /TVA intracommunautaire FR19995042363/)
    assertExcludes(response.body, /Sale-wall/i)
    assertExcludes(response.body, /href="\/wall"/)

    const podcastPosition = response.body.indexOf('id="podcast"')
    const experiencePosition = response.body.indexOf('id="experience"')
    assert.ok(podcastPosition > 0)
    assert.ok(experiencePosition > podcastPosition)
  })

  test('exposes the supplied Saleté Sincère image in complete social metadata', async () => {
    const app = await createApp()

    const response = await app.inject({ method: 'GET', url: '/' })
    const description = 'Saleté Sincère : journalisme, production éditoriale et prise de parole dans la tech, avec Damien Cavaillès.'

    assert.equal(response.statusCode, 200)
    assertContains(response.body, /<link rel="canonical" href="https:\/\/saletesincere\.fr\/">/)
    assertContains(response.body, new RegExp(`<meta name="description" content="${description}">`))
    assertContains(response.body, /<meta name="author" content="Damien Cavaillès">/)
    assertContains(response.body, /<meta name="date" content="2026-09-09">/)
    assertContains(response.body, /<meta property="og:type" content="website">/)
    assertContains(response.body, /<meta property="og:locale" content="fr_FR">/)
    assertContains(response.body, /<meta property="og:site_name" content="Saleté Sincère">/)
    assertContains(response.body, /<meta property="og:url" content="https:\/\/saletesincere\.fr\/">/)
    assertContains(response.body, /<meta property="og:title" content="Saleté Sincère">/)
    assertContains(response.body, /<meta property="article:author" content="Damien Cavaillès">/)
    assertContains(response.body, /<meta property="article:published_time" content="2026-09-09T00:00:00\+02:00">/)
    assertContains(response.body, new RegExp(`<meta property="og:description" content="${description}">`))
    assertContains(response.body, /<meta property="og:image" content="https:\/\/saletesincere\.fr\/cdn-cgi\/image\/width=1200,height=627,fit=cover,quality=85,format=png\/images\/shareimg\.jpg">/)
    assertContains(response.body, /<meta property="og:image:type" content="image\/jpeg">/)
    assertContains(response.body, /<meta property="og:image:width" content="1200">/)
    assertContains(response.body, /<meta property="og:image:height" content="627">/)
    assertContains(response.body, /<meta property="og:image:alt" content="Damien Cavaillès au micro avec le logo Saleté Sincère">/)
    assertContains(response.body, /<meta name="twitter:card" content="summary_large_image">/)
    assertContains(response.body, /<meta name="twitter:title" content="Saleté Sincère">/)
    assertContains(response.body, new RegExp(`<meta name="twitter:description" content="${description}">`))
    assertContains(response.body, /<meta name="twitter:image" content="https:\/\/saletesincere\.fr\/cdn-cgi\/image\/width=1200,height=627,fit=cover,quality=85,format=png\/images\/shareimg\.jpg">/)
    assertContains(response.body, /<meta name="twitter:image:alt" content="Damien Cavaillès au micro avec le logo Saleté Sincère">/)
    assert.ok(description.length >= 100)
  })

  test('serves the original JPEG source used by Cloudflare', async () => {
    const app = await createApp()

    const response = await app.inject({ method: 'GET', url: '/images/shareimg.jpg' })

    assert.equal(response.statusCode, 200)
    assert.match(response.headers['content-type'], /^image\/jpeg/)

    const image = await Jimp.read(response.rawPayload)
    assert.deepEqual([image.bitmap.width, image.bitmap.height], [1920, 1080])
  })

  test('renders at most three real RSS episodes with format, duration and links', async () => {
    const app = await createApp(async () => publishedEpisodes())

    const response = await app.inject({ method: 'GET', url: '/' })

    assert.equal(response.statusCode, 200)
    assertContains(response.body, /href="\/podcast\/3\/3"/)
    assertContains(response.body, />CHARBON</)
    assertContains(response.body, />WAFER</)
    assertContains(response.body, />FISSURE</)
    assertContains(response.body, /48:12/)
    assertContains(response.body, /34:28/)
    assertContains(response.body, /52:13/)
    assertExcludes(response.body, /Un épisode qui ne doit pas apparaître/)
  })

  test('keeps the landing available when the RSS feed is unavailable', async () => {
    const app = await createApp(async () => {
      throw new Error('RSS unavailable')
    })

    const response = await app.inject({ method: 'GET', url: '/' })

    assert.equal(response.statusCode, 200)
    assertContains(response.body, /Charbon &amp; Wafer/)
    assertContains(response.body, /href="\/podcast"/)
    assertExcludes(response.body, /landing-episode-list/)
  })
})
