import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import Handlebars from 'handlebars'

const render = Handlebars.compile(await readFile(new URL('../../server/views/podcast.hbs', import.meta.url), 'utf8'))

test('podcast provides a main landmark, platform navigation and a home link', () => {
  const html = render({})
  assert.match(html, /href="#contenu"/)
  assert.match(html, /<main id="contenu"/)
  assert.match(html, /href="\/" aria-label="Accueil Saleté Sincère"/)
  assert.match(html, /id="plateformes"[^>]*aria-labelledby="platform-title"/)
})

test('episode play button has an accessible name', () => {
  const html = render({ episodeData: { season: 3, episode: 1, title: 'Exemple', audioUrl: 'https://example.com/audio.mp3' } })
  assert.match(html, /<button id="playBtn-3-1"\s+type="button" aria-label="Lire l’épisode"/)
})

test('episode page leads with its own title without the podcast hero', () => {
  const html = render({ episodeData: { season: 3, episode: 2, title: 'Titre de l’épisode' } })
  assert.doesNotMatch(html, /class="podcast-hero"/)
  assert.match(html, /<h1[^>]*>Titre de l’épisode<\/h1>/)
})

test('podcast introduction renders escaped RSS description', () => {
  const html = render({ podcastDescription: 'Description RSS <script>test</script>' })
  assert.match(html, /Description RSS &lt;script&gt;test&lt;\/script&gt;/)
  assert.doesNotMatch(html, /laboratoire éditorial/)
})
