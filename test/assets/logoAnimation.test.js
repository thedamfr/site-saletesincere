import { readFile } from 'node:fs/promises'
import test from 'node:test'
import assert from 'node:assert/strict'

const logoUrl = new URL('../../public/images/logo-noname-web.svg', import.meta.url)
const replayScriptUrl = new URL('../../public/js/landing.js', import.meta.url)
const labScriptUrl = new URL('../../public/js/logo-lab.js', import.meta.url)
const verificationScriptUrl = new URL('../../scripts/check-logo-animation.mjs', import.meta.url)

test('the hero logo is revealed like a hand-drawn mark', async () => {
  const svg = await readFile(logoUrl, 'utf8')

  assert.match(svg, /class="logo-trace logo-trace-upper-fill"[^>]*d="M384,83[^\"]*217\.703,246\.969"/)
  assert.match(svg, /class="logo-trace logo-trace-upper-mid"[^>]*d="M384,83[^\"]*210\.661,263\.785"/)
  assert.match(svg, /id="logo-gesture-upper" class="logo-trace logo-trace-upper"[^>]*d="M384,83[^\"]*170\.5,340"/)
  assert.match(svg, /\.logo-trace-upper \{[\s\S]*?stroke-width: 72/)
  assert.match(svg, /\.logo-trace-upper \{[\s\S]*?stroke-linecap: butt/)
  assert.match(svg, /id="logo-gesture-loop" class="logo-trace logo-trace-loop"[^>]*d="M170\.5,340 C160,347 153,352 147,356[^\"]*87\.5,316\.5[^\"]*170\.5,340"/)
  assert.match(svg, /id="logo-gesture-return" class="logo-trace logo-trace-return"[^>]*d="M170\.5,340/)
  assert.match(svg, /stroke-dasharray: 446/)
  assert.match(svg, /stroke-dasharray: 342/)
  assert.match(svg, /stroke-dasharray: 361/)
  assert.match(svg, /stroke-dasharray: 356/)
  assert.match(svg, /stroke-dasharray: 403/)
  assert.match(svg, /@keyframes logo-draw-upper/)
  assert.match(svg, /@keyframes logo-draw-upper-fill/)
  assert.match(svg, /@keyframes logo-draw-upper-mid/)
  assert.match(svg, /@keyframes logo-draw-loop/)
  assert.match(svg, /@keyframes logo-draw-return/)
  assert.match(svg, /class="logo-trace logo-trace-upper-fill"/)
  assert.match(svg, /class="logo-trace logo-trace-upper-mid"/)
  assert.doesNotMatch(svg, /logo-lock|logo-crossing-block/)
  assert.doesNotMatch(svg, /id="logo-gesture"/)
  assert.match(svg, /class="logo-dot"/)
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

test('the animation lab can scrub each independent gesture segment', async () => {
  const script = await readFile(labScriptUrl, 'utf8')

  assert.match(script, /logo-gesture-upper/)
  assert.match(script, /logo-gesture-loop/)
  assert.match(script, /logo-gesture-return/)
  assert.match(script, /strokeDashoffset/)
  assert.match(script, /getPointAtLength/)
  assert.match(script, /requestAnimationFrame/)
})

test('the animation verification renders keyframes and checks the exact final mark', async () => {
  const script = await readFile(verificationScriptUrl, 'utf8')

  assert.match(script, /0\.2, 0\.36, 0\.4, 0\.44, 0\.52, 0\.64, 0\.8, 0\.96/)
  assert.match(script, /rsvg-convert/)
  assert.match(script, /compare/)
  assert.match(script, /pixelDifference/)
})
