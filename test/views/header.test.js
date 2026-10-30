import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import Handlebars from 'handlebars'

const viewsDirectory = new URL('../../server/views/', import.meta.url)
const handlebars = Handlebars.create()
handlebars.registerHelper('eq', (left, right) => left === right)
for (const filename of await readdir(new URL('partials/', viewsDirectory))) {
  if (!filename.endsWith('.hbs')) continue
  handlebars.registerPartial(path.basename(filename, '.hbs'), await readFile(new URL(`partials/${filename}`, viewsDirectory), 'utf8'))
}

const templates = new Map()
for (const filename of await readdir(viewsDirectory, { recursive: true })) {
  if (!filename.endsWith('.hbs') || filename.startsWith('partials/')) continue
  templates.set(filename, handlebars.compile(await readFile(new URL(filename, viewsDirectory), 'utf8')))
}

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]))
}

function getHeader(html) {
  const headers = [...html.matchAll(/<header\b([^>]*)>([\s\S]*?)<\/header>/g)]
    .filter(match => attributes(match[1]).class?.split(/\s+/).includes('site-header'))
  assert.equal(headers.length, 1, 'Each page must expose one shared site header')
  return headers[0][2]
}

function getNavigation(header) {
  const navigation = [...header.matchAll(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/g)]
  assert.equal(navigation.length, 1, 'The header must expose one navigation landmark')
  assert.equal(attributes(navigation[0][1])['aria-label'], 'Navigation principale')
  return [...navigation[0][2].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(match => ({
    ...attributes(match[1]),
    text: match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  }))
}

const expectedNavigation = [
  { text: 'Photographie', href: '/photographie' },
  { text: 'Podcast', href: '/podcast' },
  { text: 'À propos', href: '/damien-cavailles' },
  { text: 'Contact', href: '/#contact' }
]

for (const [filename, render] of templates) {
  test(`${filename} provides the same home logo and primary navigation`, () => {
    const html = render({})
    const header = getHeader(html)
    const links = getNavigation(header)
    assert.deepEqual(links.map(({ text, href }) => ({ text, href })), expectedNavigation)

    const home = [...header.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
      .find(match => attributes(match[1]).href === '/')
    assert.ok(home, 'The logo must lead to the home page')
    assert.equal(attributes(home[1])['aria-label'], 'Accueil Saleté Sincère')
    const image = home[2].match(/<img\b([^>]*)>/)
    assert.ok(image, 'The home link must display the official logo')
    assert.equal(attributes(image[1]).src, '/images/logo-salete-sincere-horizontal.png')
    assert.equal(attributes(image[1]).alt, 'Saleté Sincère')

    const stylesheets = [...html.matchAll(/<link\b([^>]*)>/g)]
      .map(match => attributes(match[1]))
      .filter(link => link.rel === 'stylesheet' && link.href === '/site-header.css?v=1')
    assert.equal(stylesheets.length, 1, 'The shared header stylesheet must load once on every page')
  })
}

test('the photography page identifies Photographie as the current page', () => {
  const links = getNavigation(getHeader(templates.get('photography.hbs')({})))
  assert.deepEqual(links.filter(link => link['aria-current']).map(link => [link.href, link['aria-current']]), [
    ['/photographie', 'page']
  ])
})

test('the author page identifies À propos as the current page', () => {
  const links = getNavigation(getHeader(templates.get('author.hbs')({})))
  assert.deepEqual(links.filter(link => link['aria-current']).map(link => [link.href, link['aria-current']]), [
    ['/damien-cavailles', 'page']
  ])
})

test('the podcast index identifies Podcast as the current page', () => {
  const links = getNavigation(getHeader(templates.get('podcast.hbs')({})))
  assert.deepEqual(links.filter(link => link['aria-current']).map(link => [link.href, link['aria-current']]), [
    ['/podcast', 'page']
  ])
})

test('an episode keeps the same navigation and identifies the podcast section as its current location', () => {
  const html = templates.get('podcast.hbs')({ episodeData: { season: 3, episode: 2, title: 'Un épisode' } })
  const links = getNavigation(getHeader(html))
  assert.deepEqual(links.map(({ text, href }) => ({ text, href })), expectedNavigation)
  assert.deepEqual(links.filter(link => link['aria-current']).map(link => [link.href, link['aria-current']]), [
    ['/podcast', 'location']
  ])
})

test('the home page does not mark a different destination as the current page', () => {
  const links = getNavigation(getHeader(templates.get('landing.hbs')({})))
  assert.deepEqual(links.filter(link => link['aria-current']), [])
})
