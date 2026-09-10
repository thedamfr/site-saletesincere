import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Jimp } from 'jimp'
import { chromium } from 'playwright'

// Uses the browser's real CSS timeline, also scrubbed by the laboratory.
const browser = await chromium.launch({ headless: true, channel: process.env.LOGO_BROWSER_CHANNEL || undefined })
const outputDirectory = path.join(os.tmpdir(), 'salete-logo-browser-check')
await mkdir(outputDirectory, { recursive: true })
const svg = await readFile(new URL('../public/images/logo-noname-web.svg', import.meta.url), 'utf8')
const shape = svg.match(/id="logo-shape" d="([^"]+)"/)[1]
const width = 748, height = 621
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'no-preference' })
const style = '<style>html,body{margin:0;background:white}svg{display:block;width:748px;height:621px}</style>'
const capture = async () => Jimp.read(await page.screenshot())
const inkAt = (bitmap, x, y) => {
  const offset = (Math.round(y * height / 413.65) * width + Math.round(x * width / 498.62)) * 4
  return 255 - bitmap.data[offset]
}
const advance = async progress => page.evaluate(time => {
  for (const animation of document.querySelector('svg').getAnimations({ subtree: true })) {
    animation.pause()
    animation.currentTime = time
  }
}, progress * 3600)

function countInkComponents(bitmap) {
  const visited = new Uint8Array(width * height)
  const queue = new Int32Array(width * height)
  let components = 0
  for (let pixel = 0; pixel < visited.length; pixel++) {
    if (visited[pixel] || bitmap.data[pixel * 4] >= 200) continue
    let head = 0, tail = 1
    queue[0] = pixel
    visited[pixel] = 1
    while (head < tail) {
      const current = queue[head++]
      const x = current % width, y = Math.floor(current / width)
      for (const next of [x > 0 ? current - 1 : -1, x < width - 1 ? current + 1 : -1, y > 0 ? current - width : -1, y < height - 1 ? current + width : -1]) {
        if (next < 0 || visited[next] || bitmap.data[next * 4] >= 200) continue
        visited[next] = 1
        queue[tail++] = next
      }
    }
    if (tail >= 8) components++
  }
  return components
}

try {
  await page.setContent(`${style}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 498.62 413.65"><path d="${shape}"/></svg>`)
  const reference = (await capture()).bitmap
  const defs = svg.match(/<defs>[\s\S]*?<\/defs>/)[0]
  await page.setContent(`${style}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 498.62 413.65">${defs}<g clip-path="url(#logo-silhouette)"><rect width="499" height="414" mask="url(#logo-mask-blue)"/><rect width="499" height="414" fill="white" mask="url(#logo-mask-red)"/></g></svg>`)
  const blueOnly = (await capture()).bitmap
  await page.setContent(`${style}${svg}`)
  await advance(0)
  const blank = (await capture()).bitmap
  assert.equal(blank.data.filter((value, index) => index % 4 !== 3 && value < 250).length, 0, 'At 0%, no ink may be visible')

  for (const progress of [0.36, 0.42, 0.48]) {
    await advance(progress)
    const frame = (await capture()).bitmap
    for (const [x, y] of [[75, 310], [250, 350], [385, 155]]) {
      assert.ok(inkAt(frame, x, y) < 5, `At ${progress * 100}%, the future blue surface at ${x},${y} must remain empty`)
    }
  }

  // Before any finishing effect: the strokes themselves must cover the logo.
  await advance(0.96)
  const drawn = (await capture()).bitmap
  let missingInteriorPixels = 0, spillPixels = 0
  for (let i = 0; i < reference.data.length; i += 4) {
    if (reference.data[i] < 5 && drawn.data[i] > 15) missingInteriorPixels++
    if (reference.data[i] > 250 && drawn.data[i] < 240) spillPixels++
  }
  assert.equal(missingInteriorPixels, 0, 'The animated strokes must cover every interior pixel without a final logo overlay')
  assert.equal(spillPixels, 0, 'The strokes must remain inside the original silhouette')

  const snapshots = new Set([0, 10, 20, 30, 36, 42, 48, 52, 60, 68, 80, 96, 100])
  const images = []
  let previous
  for (let percent = 0; percent <= 100; percent++) {
    await advance(percent / 100)
    const frame = await capture()
    if (percent <= 52) {
      let prematureBluePixels = 0
      for (let i = 0; i < blueOnly.data.length; i += 4) {
        if (blueOnly.data[i] < 5 && frame.bitmap.data[i] < 240) prematureBluePixels++
      }
      assert.equal(prematureBluePixels, 0, `The red stroke must never fill the blue surface at ${percent}%`)
    }
    if (percent <= 96) assert.ok(countInkComponents(frame.bitmap) <= 1, `No detached ink fragments at ${percent}%`)
    if (previous && percent <= 96) {
      let disappearingPixels = 0
      for (let i = 0; i < frame.bitmap.data.length; i += 4) {
        if (previous.data[i] < 30 && frame.bitmap.data[i] > 230) disappearingPixels++
      }
      assert.equal(disappearingPixels, 0, `The stroke must not disappear at ${percent}%`)
    }
    previous = frame.bitmap
    if (snapshots.has(percent)) {
      await frame.write(path.join(outputDirectory, `frame-${String(percent).padStart(3, '0')}.png`))
      images.push({ percent, url: await frame.getBase64('image/png') })
    }
  }

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setContent(`${style}${svg}`)
  const reduced = (await capture()).bitmap
  for (let i = 0; i < reference.data.length; i += 4) {
    assert.ok(reference.data[i] > 5 || reduced.data[i] < 15, 'Reduced motion must show the complete static logo')
  }
  await page.setViewportSize({ width: 1400, height: 1080 })
  await page.setContent(`<style>body{margin:0;background:#eee;font:16px sans-serif}main{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;padding:8px}figure{margin:0;background:white}img{width:100%;display:block}figcaption{text-align:center;padding:6px}</style><main>${images.map(({ percent, url }) => `<figure><img src="${url}"><figcaption>${percent}%</figcaption></figure>`).join('')}</main>`)
  await page.screenshot({ path: path.join(outputDirectory, 'contact-sheet.png'), fullPage: true })

  // Exercise the actual lab script and controls without requiring a running server.
  const assets = new Map(await Promise.all([
    ['/laboratoire-du-geste', '../server/views/logo-lab.hbs', 'text/html'],
    ['/js/logo-lab.js', '../public/js/logo-lab.js', 'text/javascript'],
    ['/logo-lab.css', '../public/logo-lab.css', 'text/css'],
    ['/images/logo-noname-web.svg', '../public/images/logo-noname-web.svg', 'image/svg+xml']
  ].map(async ([url, file, contentType]) => [url, { body: await readFile(new URL(file, import.meta.url), 'utf8'), contentType }])) )
  await page.route('http://logo.test/**', route => {
    const asset = assets.get(new URL(route.request().url()).pathname)
    return route.fulfill(asset || { status: 404, body: '' })
  })
  await page.goto('http://logo.test/laboratoire-du-geste')
  await page.waitForSelector('.logo-lab-guides circle')
  for (const percent of [0, 36, 48, 52, 60, 68, 96, 100]) {
    await page.locator('[data-logo-progress]').evaluate((input, value) => {
      input.value = String(value * 10)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, percent)
    const state = await page.evaluate(value => {
      const traces = [...document.querySelectorAll('.logo-trace')]
      const active = traces.find(trace => value < Number(trace.dataset.end)) || traces.at(-1)
      const marker = document.querySelector('.logo-lab-guides circle')
      const drawn = Math.min(1, Math.max(0, 1 - Number.parseFloat(getComputedStyle(active).strokeDashoffset)))
      const point = active.getPointAtLength(active.getTotalLength() * drawn)
      return {
        distance: Math.hypot(Number(marker.getAttribute('cx')) - point.x, Number(marker.getAttribute('cy')) - point.y),
        colorMatches: marker.getAttribute('fill') === active.dataset.guideColor,
        times: document.querySelector('.lab-stage svg').getAnimations({ subtree: true }).map(animation => animation.currentTime)
      }
    }, percent / 100)
    assert.ok(state.distance < 0.01 && state.colorMatches, 'The marker must follow the actual active stroke')
    assert.equal(state.times.length, 4, 'The lab must use the four actual SVG animations, also under reduced motion')
    assert.ok(state.times.every(time => Math.abs(time - percent * 36) < 0.01), 'All SVG animations must share the scrubber time')
  }
  await page.getByRole('checkbox').uncheck()
  assert.equal(await page.locator('.logo-lab-guides').isVisible(), false)
  await page.getByRole('button', { name: 'Recommencer' }).click()
  assert.equal(await page.locator('[data-logo-progress]').inputValue(), '0')
  for (const width of [320, 390, 800, 1400]) {
    await page.setViewportSize({ width, height: 900 })
    const fitsViewport = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    assert.ok(fitsViewport, `The public lab must not overflow horizontally at ${width}px`)
  }
  console.log(JSON.stringify({ checkedFrames: 101, missingInteriorPixels, spillPixels, detachedFragments: 0, prematureBluePixels: 0, reducedMotion: 'passed', labControls: 'passed', responsiveLayout: 'passed', outputDirectory }, null, 2))
} finally {
  await browser.close()
}
