import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchPodcastFromRSS } from '../../server/services/castopodRSS.js'

test('reads channel description without requiring an episode or another request', async () => {
  let requests = 0
  const podcast = await fetchPodcastFromRSS(5000, async () => {
    requests++
    return { ok: true, text: async () => '<rss><channel><description><![CDATA[<p>La description du <b>podcast</b> &amp; ses récits.</p>]]></description></channel></rss>' }
  })
  assert.equal(requests, 1)
  assert.equal(podcast.description, 'La description du podcast & ses récits.')
  assert.deepEqual(podcast.descriptionParagraphs, ['La description du podcast & ses récits.'])
  assert.deepEqual(podcast.episodes, [])
})

test('preserves separate HTML blocks as normalized plain-text paragraphs', async () => {
  const description = '<div><p>Premier <strong>paragraphe</strong>.</p><p>Deuxième &amp; troisième.</p><ul><li>Un choix.</li><li>Un autre<br />Une suite.</li></ul><p> </p></div>'
  const podcast = await fetchPodcastFromRSS(5000, async () => ({
    ok: true,
    text: async () => `<rss><channel><description><![CDATA[${description}]]></description></channel></rss>`
  }))

  assert.deepEqual(podcast.descriptionParagraphs, [
    'Premier paragraphe.',
    'Deuxième & troisième.',
    'Un choix.',
    'Un autre',
    'Une suite.'
  ])
  assert.equal(podcast.description, 'Premier paragraphe.Deuxième & troisième.Un choix.Un autreUne suite.')
})

test('decodes entities and separates plain text only at blank lines', async () => {
  const description = '  Du texte &amp; &quot;des récits&quot;\n sur une ligne.\n\nUn second paragraphe.\r\n \r\nL&#39;épilogue.  '
  const podcast = await fetchPodcastFromRSS(5000, async () => ({
    ok: true,
    text: async () => `<rss><channel><description><![CDATA[${description}]]></description></channel></rss>`
  }))

  assert.deepEqual(podcast.descriptionParagraphs, [
    'Du texte & "des récits" sur une ligne.',
    'Un second paragraphe.',
    "L'épilogue."
  ])
})

test('returns no paragraphs for a missing or empty description', async () => {
  for (const description of ['', '<description />', '<description><![CDATA[ <p> </p><br> ]]></description>']) {
    const podcast = await fetchPodcastFromRSS(5000, async () => ({
      ok: true,
      text: async () => `<rss><channel>${description}</channel></rss>`
    }))

    assert.deepEqual(podcast.descriptionParagraphs, [])
    assert.equal(podcast.description, '')
  }
})
