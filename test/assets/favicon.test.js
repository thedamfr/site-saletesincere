import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Jimp } from 'jimp'

const publicUrl = new URL('../../public/', import.meta.url)
const viewsUrl = new URL('../../server/views/', import.meta.url)

const publicPageTemplates = [
  'landing.hbs',
  'podcast.hbs',
  'index.hbs',
  'layout.hbs',
  'manifeste.hbs',
  'newsletter/subscribe.hbs',
  'newsletter/pending.hbs',
  'newsletter/confirmed.hbs',
  'newsletter/error.hbs'
]

describe('Saleté Sincère favicon', () => {
  test('uses a static square SVG derived from the existing brand mark', async () => {
    const source = await readFile(new URL('favicon.svg', publicUrl), 'utf8')

    assert.match(source, /viewBox="0 0 512 512"/)
    assert.match(source, /fill="#F2F2EF"/)
    assert.match(source, /fill="#0B0B0B"/)
    assert.doesNotMatch(source, /animation|<mask/)
  })

  test('provides correctly sized PNG fallbacks', async () => {
    const ico = await readFile(new URL('favicon.ico', publicUrl))
    const favicon = await Jimp.read(new URL('favicon-32x32.png', publicUrl))
    const appleTouchIcon = await Jimp.read(new URL('apple-touch-icon.png', publicUrl))

    assert.deepEqual([...ico.subarray(0, 4)], [0, 0, 1, 0])
    assert.deepEqual(
      [favicon.bitmap.width, favicon.bitmap.height],
      [32, 32]
    )
    assert.deepEqual(
      [appleTouchIcon.bitmap.width, appleTouchIcon.bitmap.height],
      [180, 180]
    )
  })

  test('declares the favicon set on every public HTML template', async () => {
    for (const template of publicPageTemplates) {
      const source = await readFile(new URL(template, viewsUrl), 'utf8')

      assert.match(
        source,
        /<link rel="icon" href="\/favicon\.ico" sizes="16x16 32x32 48x48">/,
        `${template} should declare the ICO fallback`
      )
      assert.match(
        source,
        /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/,
        `${template} should declare the SVG favicon`
      )
      assert.match(
        source,
        /<link rel="icon" href="\/favicon-32x32\.png" sizes="32x32" type="image\/png">/,
        `${template} should declare the PNG favicon`
      )
      assert.match(
        source,
        /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png" sizes="180x180">/,
        `${template} should declare the Apple touch icon`
      )
    }
  })
})
