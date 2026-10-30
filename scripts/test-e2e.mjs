import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import { runHeaderGoldenJourneys } from './lib/header-e2e.mjs'
import { runFooterGoldenJourneys } from './lib/footer-e2e.mjs'

// Never load a developer's credentials or production database configuration.
process.env.DOTENV_CONFIG_PATH = '/dev/null'
process.env.DISABLE_WORKER = 'true'
process.env.DISABLE_STORAGE = 'true'
process.env.DISABLE_WALL = 'true'
const { buildApp } = await import('../server.js')
const episode = {
  season: 3, episode: 2, title: 'Épisode de qualification du header',
  description: 'Contenu RSS simulé pour vérifier la navigation publique.',
  image: '/images/charbon-wafer-cover.png', duration: '12:00',
  pubDate: '27 octobre 2026', rawPubDate: '2026-10-27', audioUrl: '',
  episodeLink: '/podcast/3/2'
}
const unavailableDatabase = async () => { throw Object.assign(new Error('Database intentionally unavailable in E2E'), { code: 'ECONNREFUSED' }) }
const app = await buildApp({ databaseConfigured: false, initializeStorage: false, storageEnabled: false,
  databaseAdapter: { query: unavailableDatabase, connect: unavailableDatabase },
  podcastEpisodesFetcher: async () => [episode],
  episodeFetcher: async (season, number) => season === 3 && number === 2 ? episode : null,
  op3PublicStatsEnabled: false, youtubeEpisodeResolutionEnabled: false })
const local = await app.listen({ port: 0, host: '127.0.0.1' })
const base = (process.env.E2E_BASE_URL || local).replace(/\/$/, '')
let browser
const output = process.env.E2E_OUTPUT || '/tmp/site-author-e2e'
await mkdir(output, { recursive: true })
const outcomes = []
const startedAt = new Date().toISOString()
const headerResults = {}
const footerResults = {}
let failure
let browserVersion

async function candidateIdentity() {
  const cwd = new URL('../', import.meta.url)
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd, encoding: 'utf8' })
    .split('\0').filter(Boolean)
  // Include the generated author content actually served by the local app.
  files.push('server/generated/author.json')
  const digest = createHash('sha256')
  for (const filename of [...new Set(files)].sort()) {
    let content
    try { content = await readFile(new URL(filename, cwd)) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      content = Buffer.from('[absent]')
    }
    digest.update(filename + '\0').update(createHash('sha256').update(content).digest('hex')).update('\0')
  }
  return { sourceCommit, fingerprint: digest.digest('hex'), files: files.length,
    dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim()) }
}

const candidate = await candidateIdentity()
try {
  browser = await chromium.launch({ chromiumSandbox: true,
    channel: process.env.E2E_BROWSER_CHANNEL || undefined,
    executablePath: process.env.E2E_BROWSER_EXECUTABLE || undefined })
  browserVersion = browser.version()
  const context = await browser.newContext({ acceptDownloads: true })
  const page = await context.newPage()
  await page.goto(base)
  await page.getByRole('link', { name: 'À propos', exact: true }).first().click()
  await page.getByRole('heading', { name: 'Damien Cavaillès', exact: true }).waitFor()
  assert.equal(new URL(page.url()).pathname, '/damien-cavailles')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Télécharger le portrait HD' }).click()
  const download = await downloadPromise
  assert.equal(download.suggestedFilename(), 'damien-cavailles-portrait-officiel.jpg')
  assert.deepEqual(await readFile(await download.path()), await readFile(new URL('../public/images/damien-podcast.jpg', import.meta.url)))
  const editorialLinks = await page.locator('.author-editing li a').evaluateAll(links => links.map(link => link.href))
  for (const articleId of ['daeab20db002', 'b6cfac4140cd', 'd197e9354854', 'd4e52966927d', '16e712199858', 'aad66a0b17f6']) {
    assert.ok(editorialLinks.some(link => link.endsWith(articleId)), `Missing confirmed editorial reference: ${articleId}`)
  }
  assert.equal(new Set(editorialLinks).size, editorialLinks.length, 'Editorial references must not be duplicated')
  for (const articleId of ['73c41b446880', 'eeff51c3bf42', '12eee042c47e']) {
    assert.ok(!editorialLinks.some(link => link.endsWith(articleId)), 'Incorrect editorial attribution must be removed')
  }
  assert.deepEqual(await page.locator('.author-section h2').allTextContents(), [
    'Travail d’éditeur', 'Articles signés', 'Interviews et mentions', 'Webinars et tables rondes'
  ])
  const interviews = page.locator('.author-section').filter({ has: page.getByRole('heading', { name: 'Interviews et mentions', exact: true }) })
  assert.deepEqual(await interviews.locator('li > a:first-child').evaluateAll(links => links.map(link => link.href)), [
    'https://taleez.com/guide/e-book-le-futur-du-travail-secrit-aujourdhui-sylvain-colas?utm_campaign=MKT-Partner-HrSingularity',
    'https://estamitech.fr/episode/4907ac1d-aaf2-4078-8a69-6a406548c5eb',
    'https://www.youtube.com/watch?v=LPsWR4d4TKg',
    'https://alliance-emploi.org/podcast-ressources#ep17',
    'https://shows.acast.com/au-refuge/episodes/damien-cavailles-welovedevs-au-refuge',
    'https://podcast.ausha.co/tech-rocks/et-si-les-developpeurs-avaient-le-droit-au-bonheur-damien-cavailles-welovedevs-youen-chene-webvert-s05ep18'
  ])
  assert.match(await interviews.locator('li').first().textContent(), /Interviewé.*Sylvain Colas.*À paraître/s)
  const bookLinks = [
    ['Lire sur Taleez', 'https://taleez.com/guide/e-book-le-futur-du-travail-secrit-aujourdhui-sylvain-colas?utm_campaign=MKT-Partner-HrSingularity'],
    ['Voir sur Amazon', 'https://amzn.eu/d/023n3GF4']
  ]
  for (const [name, destination] of bookLinks) {
    const link = interviews.locator('li').first().getByRole('link', { name, exact: true })
    assert.equal(await link.isVisible(), true, `Book destination must be explicitly visible: ${name}`)
    await context.route(destination, route => route.fulfill({ contentType: 'text/html', body: '<h1>Livre de Sylvain Colas</h1>' }))
    await link.click()
    assert.equal(page.url(), destination)
    await page.goBack()
    await page.getByRole('heading', { name: 'Damien Cavaillès', exact: true }).waitFor()
  }
  console.log('Golden Journey — auteur → liens explicites Taleez et Amazon → retour : OK')
  // Follow a real editorial link; only the external publisher is simulated.
  const article = page.locator('.author-prose a[href^="https://medium.com/"]').first()
  const destination = await article.getAttribute('href')
  await context.route('https://medium.com/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Publication externe</h1>' }))
  await article.click()
  assert.equal(page.url(), destination)
  await page.goBack()
  await page.reload()
  await page.getByRole('heading', { name: 'Damien Cavaillès', exact: true }).waitFor()
  await page.getByRole('navigation', { name: 'Navigation principale', exact: true }).getByRole('link', { name: 'Podcast', exact: true }).click()
  await page.getByRole('link', { name: 'À propos', exact: true }).first().click()
  await page.getByRole('link', { name: 'Me contacter', exact: true }).click()
  assert.equal(new URL(page.url()).hash, '#contact')
  assert.equal(await page.locator('#contact').isVisible(), true)
  console.log('Golden Journey — navigation accueil/podcast → auteur → portrait original → référence éditoriale → contact : OK')
  outcomes.push('Golden Journey — auteur, téléchargement du portrait original, références éditoriales et contact : OK')
  await context.close()

  const noJs = await browser.newContext({ javaScriptEnabled: false })
  const staticPage = await noJs.newPage()
  for (const width of [320, 390, 1440]) {
    await staticPage.setViewportSize({ width, height: 960 })
    await staticPage.goto(`${base}/damien-cavailles`)
    for (const [name] of bookLinks) {
      assert.equal(await staticPage.getByRole('link', { name, exact: true }).isVisible(), true, `${name} must remain visible without JavaScript at ${width}px`)
    }
    await staticPage.locator('.author-work-photo').scrollIntoViewIfNeeded()
    await staticPage.getByRole('contentinfo').scrollIntoViewIfNeeded()
    await staticPage.waitForFunction(() => [...document.images].every(img => img.complete && img.naturalWidth > 0))
    assert.equal(await staticPage.evaluate(() => document.documentElement.scrollWidth), width)
    await staticPage.screenshot({ path: `${output}/author-${width}.png`, fullPage: true })
  }
  await staticPage.goto(`${base}/damien-cavailles/`)
  assert.equal(new URL(staticPage.url()).pathname, '/damien-cavailles')
  const canonical = await staticPage.locator('link[rel="canonical"]').getAttribute('href')
  assert.equal(canonical, 'https://saletesincere.fr/damien-cavailles')
  const schema = JSON.parse(await staticPage.locator('script[type="application/ld+json"]').textContent())
  assert.equal(schema.mainEntity.name, 'Damien Cavaillès')
  const robots = await noJs.request.get(`${base}/robots.txt`)
  assert.equal(robots.status(), 200)
  assert.match(await robots.text(), /Sitemap: https:\/\/saletesincere.fr\/sitemap.xml/)
  const sitemap = await noJs.request.get(`${base}/sitemap.xml`)
  assert.equal(sitemap.status(), 200)
  assert.match(await sitemap.text(), /<loc>https:\/\/saletesincere.fr\/damien-cavailles<\/loc>/)
  console.log('Golden Journey — lecture sans JavaScript, mobile, redirection canonique et découverte robots/sitemap : OK')
  outcomes.push('Golden Journey — auteur sans JavaScript, responsive, redirection canonique, robots et sitemap : OK')
  await noJs.close()
  await runHeaderGoldenJourneys(browser, { base, output, localTarget: base === local, outcomes, results: headerResults })
  await runFooterGoldenJourneys(browser, { base, output, localTarget: base === local, outcomes, results: footerResults })
  for (const outcome of outcomes.slice(2)) console.log(outcome)
} catch (error) {
  failure = { name: error.name, message: error.message }
  throw error
} finally {
  await browser?.close()
  await app.close()
  const finalCandidate = await candidateIdentity()
  const candidateUnchanged = candidate.fingerprint === finalCandidate.fingerprint
    && candidate.sourceCommit === finalCandidate.sourceCommit
  const status = failure || !candidateUnchanged ? 'failed' : 'passed'
  const report = {
    status, startedAt, finishedAt: new Date().toISOString(), command: 'npm run test:e2e',
    environment: { node: process.version, browser: browserVersion, target: base === local ? 'isolated-loopback' : new URL(base).origin,
      chromiumSandbox: true, dotenv: 'disabled', database: 'unavailable fixture', worker: 'disabled' },
    candidate, candidateUnchanged, finalCandidate, outcomes, header: headerResults, footer: footerResults, failure,
    limitations: ['RSS et épisode simulés ; aucun service PostgreSQL, stockage objet, OP3 ou worker sollicité.',
      'La publication Medium externe est simulée. Les polices Google restent des ressources réseau avec leur repli local.',
      'Aucun formulaire newsletter soumis ; aucune écriture métier, lecture audio ni envoi email qualifiés.',
      ...(base === local ? [] : ['La cible distante est une option explicite ; son contenu ne peut pas être assimilé au fingerprint local. Le scénario épisode simulé y est omis.'])]
  }
  const qualificationSummary = status === 'passed'
    ? 'Header et footer communs, navigation et parcours auteur vérifiés sur la révision candidate ci-dessous.'
    : 'Qualification incomplète : seuls les Golden Journeys listés comme terminés ont réussi ; aucun succès global n’est établi.'
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2) + '\n')
  await writeFile(`${output}/summary.md`, `# Qualification des Golden Journeys\n\n## Summary\n\nStatut : **${status}**. ${outcomes.length} Golden Journeys terminés. ${qualificationSummary} ${candidateUnchanged ? 'Le contenu candidat est resté identique pendant la suite.' : 'Le contenu candidat a changé pendant la suite : requalification nécessaire.'}\n\n## Synthèse\n\n- Commande : \`npm run test:e2e\`.\n- SHA de base : \`${candidate.sourceCommit}\` ; modifications locales : ${candidate.dirty ? 'oui' : 'non'}.\n- Fingerprint SHA-256 du contenu testé : \`${candidate.fingerprint}\`.\n- Environnement : Node ${process.version}, Chromium ${browserVersion || 'non démarré'}, sandbox active ; ${base === local ? 'serveur loopback isolé' : 'cible distante explicite'}.\n- Couverture du header : sept pages, 320 / 390 / 768 / 1440 px ; logo, géométrie, couleurs et typographie. Mesures terminées : ${headerResults.measurements?.length || 0} / 28.\n- Couverture du footer : huit pages aux mêmes largeurs ; géométrie relative, identité, navigation, clavier et reprise sans JavaScript. Mesures terminées : ${footerResults.measurements?.length || 0} / 32.\n- Couverture prévue : navigation réelle, états actifs, clavier/focus, rechargement et navigation sans JavaScript ; absence de stockage navigateur et d’envoi newsletter. Les succès effectivement obtenus sont listés ci-dessous.\n${outcomes.map(outcome => '- ' + outcome).join('\n')}\n${failure ? '\nÉchec : ' + failure.name + '. Consulter le résultat JSON pour le détail.\n' : ''}\nLimites : ${report.limitations.join(' ')}\n\n## Annexes\n\n- [Résultats, mesures et identité candidate](results.json).\n${[...(headerResults.screenshots || []), ...(footerResults.screenshots || [])].map(filename => `- [Capture ${filename}](${filename}).`).join('\n')}\n- Captures auteur : [320 px](author-320.png), [390 px](author-390.png), [1440 px](author-1440.png).\n`)
  if (!candidateUnchanged && !failure) throw new Error('Candidate content changed during E2E qualification; run the suite again')
}
