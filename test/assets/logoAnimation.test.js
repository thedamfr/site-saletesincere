import { readFile } from 'node:fs/promises'
import test from 'node:test'
import assert from 'node:assert/strict'
import { XMLParser, XMLValidator } from 'fast-xml-parser'

const logoUrl = new URL('../../public/images/logo-noname-web.svg', import.meta.url)
const replayScriptUrl = new URL('../../public/js/landing.js', import.meta.url)

test('the standalone logo is valid SVG with two self-contained passage masks', async () => {
  const source = await readFile(logoUrl, 'utf8')
  assert.equal(XMLValidator.validate(source), true)
  const { svg } = new XMLParser({ ignoreAttributes: false }).parse(source)
  const masks = svg.defs.mask
  const traces = svg.g.path
  assert.equal(masks.length, 2)
  const ids = new Set(masks.map(mask => mask['@_id']))
  for (const trace of traces) {
    const id = trace['@_mask'].match(/^url\(#(.+)\)$/)?.[1]
    assert.ok(ids.has(id), 'Every stroke must reference one of the two passage masks')
    assert.equal(trace['@_pathLength'], '1', 'Stroke lengths must be normalized for every renderer')
  }
  assert.equal(svg.script, undefined, 'The image must remain usable without JavaScript')
})

// Pixel coverage, timing, seams and reduced motion are checked in a real browser:
// npm run check:logo-animation
test('the hero logo animation can be replayed from its control', async () => {
  const script = await readFile(replayScriptUrl, 'utf8')
  assert.match(script, /addEventListener\('click'/)
  assert.match(script, /closest\('\.landing-hero'\)/)
  assert.match(script, /getBoundingClientRect/)
  assert.match(script, /searchParams\.set\('replay'/)
  assert.match(script, /requestAnimationFrame/)
})
