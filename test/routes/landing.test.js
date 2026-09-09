import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
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
    assertContains(response.body, /logo-salete-sincere-horizontal\.png/)
    assertContains(response.body, /class="landing-hero-mark"[^>]*data-logo-replay[^>]*aria-label="Rejouer l’animation du logo"/)
    assertContains(response.body, /data-logo-animation[^>]*src="\/images\/logo-noname-web\.svg\?v=s-gesture-5"[^>]*alt=""[^>]*aria-hidden="true"/)
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
