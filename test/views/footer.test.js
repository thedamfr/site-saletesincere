import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import Handlebars from 'handlebars'

const directory = new URL('../../server/views/', import.meta.url)
const engine = Handlebars.create()
engine.registerHelper('eq', (left, right) => left === right)
for (const filename of await readdir(new URL('partials/', directory))) {
  if (filename.endsWith('.hbs')) engine.registerPartial(path.basename(filename, '.hbs'), await readFile(new URL(`partials/${filename}`, directory), 'utf8'))
}

const expectedLinks = [
  ['Accueil', '/'], ['Photographie', '/photographie'], ['Podcast', '/podcast'],
  ['À propos', '/damien-cavailles'], ['Laboratoire du geste', '/laboratoire-du-geste'],
  ['Contact', '/#contact'], ["Besoin d'un producteur sur mon podcast ?", '/offre-production-podcast/']
]
const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]))
const text = html => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
const templates = new Map()
for (const filename of await readdir(directory, { recursive: true })) {
  if (filename.endsWith('.hbs') && !filename.startsWith('partials/')) {
    templates.set(filename, engine.compile(await readFile(new URL(filename, directory), 'utf8')))
  }
}

function getFooter(html) {
  const footers = [...html.matchAll(/<footer\b([^>]*)>([\s\S]*?)<\/footer>/g)]
  assert.equal(footers.length, 1, 'Every page must expose one footer')
  assert.ok(attributes(footers[0][1]).class?.split(/\s+/).includes('site-footer'), 'Every page must use the shared site footer')
  assert.ok(footers[0].index > html.lastIndexOf('</main>'), 'The site footer must be outside the main content')
  return footers[0][0]
}

for (const [filename, render] of templates) {
  test(`${filename} provides the shared footer, navigation, contact and legal identity`, () => {
    const html = render({})
    const footer = getFooter(html)
    const navigation = [...footer.matchAll(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/g)]
    assert.equal(navigation.length, 1)
    assert.equal(attributes(navigation[0][1])['aria-label'], 'Navigation de pied de page')
    const links = [...navigation[0][2].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
    assert.deepEqual(links.map(match => [text(match[2]), attributes(match[1]).href]), expectedLinks)
    assert.doesNotMatch(footer, /aria-current=/, 'The footer content must stay the same on every page')
    const home = [...footer.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
      .find(match => attributes(match[1])['aria-label'] === 'Accueil Saleté Sincère')
    assert.ok(home)
    assert.equal(attributes(home[1]).href, '/')
    const logo = home[2].match(/<img\b([^>]*)>/)
    assert.ok(logo)
    assert.equal(attributes(logo[1]).src, '/images/logo-salete-sincere-horizontal.png')
    assert.equal(attributes(logo[1]).alt, 'Saleté Sincère')
    assert.match(footer, /href="mailto:damien@saletesincere\.fr"/)
    assert.match(text(footer), /Damien Cavaillès · Saleté Sincère/)
    assert.match(text(footer), /SIRET 99504236300011/)
    assert.match(text(footer), /TVA intracommunautaire FR19995042363/)
    assert.match(text(footer), /60 rue François Ier, 75008 Paris/)
    const credit = [...footer.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
      .find(match => attributes(match[1]).href === 'https://www.instagram.com/eva.navaux/')
    assert.ok(credit)
    assert.equal(text(credit[2]), 'Eva « Blaster » Navaux')
    assert.equal(attributes(credit[1]).target, '_blank')
    assert.ok(attributes(credit[1]).rel.split(/\s+/).includes('noopener'))
    assert.ok(attributes(credit[1]).rel.split(/\s+/).includes('noreferrer'))
    const sheets = [...html.matchAll(/<link\b([^>]*)>/g)].map(match => attributes(match[1]))
      .filter(link => link.rel === 'stylesheet' && link.href === '/site-footer.css?v=1')
    assert.equal(sheets.length, 1)
  })
}

test('every page and episode renders exactly the same footer content', () => {
  const reference = getFooter(templates.get('landing.hbs')({})).replace(/\s+/g, ' ').trim()
  for (const [filename, render] of templates) {
    assert.equal(getFooter(render({})).replace(/\s+/g, ' ').trim(), reference, filename)
  }
  assert.equal(getFooter(templates.get('podcast.hbs')({ episodeData: { season: 3, episode: 2, title: 'Un épisode' } }))
    .replace(/\s+/g, ' ').trim(), reference)
})

test('the unavailable wall retains the shared footer and its public destinations', () => {
  const render = templates.get('index.hbs')
  assert.equal(getFooter(render({ wallUnavailable: true })), getFooter(render({ wallUnavailable: false })))
})
