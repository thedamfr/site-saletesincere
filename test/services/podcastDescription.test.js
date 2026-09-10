import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getPodcastDescription } from '../../server/services/podcastDescription.js'

test('keeps short descriptions complete without an expansion control', () => {
  assert.deepEqual(getPodcastDescription(['Un texte court.']), {
    preview: 'Un texte court.', paragraphs: ['Un texte court.'], expandable: false
  })
})

test('previews long descriptions at a word boundary and retains every paragraph', () => {
  const paragraphs = ['Un récit concret. '.repeat(16).trim(), 'La fin du récit.']
  const description = getPodcastDescription(paragraphs)
  assert.equal(description.expandable, true)
  assert.ok(description.preview.length <= 200)
  assert.ok(paragraphs.join(' ').startsWith(description.preview + ' '))
  assert.deepEqual(description.paragraphs, paragraphs)
})

test('uses plain description when structured paragraphs are unavailable', () => {
  assert.deepEqual(getPodcastDescription(undefined, 'Une description.'), {
    preview: 'Une description.', paragraphs: ['Une description.'], expandable: false
  })
  assert.deepEqual(getPodcastDescription([], ''), {
    preview: '', paragraphs: [], expandable: false
  })
})
