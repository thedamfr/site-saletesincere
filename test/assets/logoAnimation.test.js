import { readFile } from 'node:fs/promises'
import test from 'node:test'
import assert from 'node:assert/strict'

const logoUrl = new URL('../../public/images/logo-noname-web.svg', import.meta.url)
const replayScriptUrl = new URL('../../public/js/landing.js', import.meta.url)

test('the hero logo is revealed like a hand-drawn mark', async () => {
  const svg = await readFile(logoUrl, 'utf8')

  assert.match(svg, /id="logo-gesture" class="logo-trace"[^>]*d="M384,83/)
  assert.match(svg, /145,326[^>]*145,326/)
  assert.match(svg, /stroke-width: 100/)
  assert.match(svg, /stroke-dasharray: 1400/)
  assert.match(svg, /from \{ stroke-dashoffset: 1400; \}/)
  assert.doesNotMatch(svg, /logo-trace-loop|logo-trace-main/)
  assert.match(svg, /class="logo-dot"/)
  assert.match(svg, /@keyframes logo-draw/)
  assert.match(svg, /@keyframes logo-dot/)
  assert.match(svg, /@keyframes logo-finish/)
  assert.match(svg, /class="logo-reveal-finish"/)
  assert.match(svg, /prefers-reduced-motion: reduce/)
})

test('the hero logo animation can be replayed from its control', async () => {
  const script = await readFile(replayScriptUrl, 'utf8')

  assert.match(script, /addEventListener\('click'/)
  assert.match(script, /closest\('\.landing-hero'\)/)
  assert.match(script, /getBoundingClientRect/)
  assert.match(script, /searchParams\.set\('replay'/)
  assert.match(script, /requestAnimationFrame/)
})
