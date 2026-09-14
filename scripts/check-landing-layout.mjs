import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium, webkit } from 'playwright'
import Handlebars from 'handlebars'

const engine = process.env.LANDING_BROWSER || 'chromium'
assert.ok(['chromium', 'webkit'].includes(engine), 'LANDING_BROWSER must be chromium or webkit')
const browser = await { chromium, webkit }[engine].launch({
  channel: engine === 'chromium' ? process.env.LOGO_BROWSER_CHANNEL : undefined
})

try {
  const template = await readFile(new URL('../server/views/landing.hbs', import.meta.url), 'utf8')
  const html = Handlebars.compile(template)({ landingEpisodes: [] })
  const assets = new Map([['/', { body: html, contentType: 'text/html' }]])
  const files = new Set(['/style.css', '/js/landing.js', ...[...html.matchAll(/src="(\/images\/[^"?]+)/g)].map(match => match[1])])
  const types = { css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg' }
  for (const file of files) {
    assets.set(file, {
      body: await readFile(new URL(`../public${file}`, import.meta.url)),
      contentType: types[file.split('.').at(-1)]
    })
  }

  for (const isMobile of [true, false]) {
    const context = await browser.newContext({ isMobile, hasTouch: isMobile, reducedMotion: 'reduce' })
    await context.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin !== 'http://landing.test') return route.abort()
      return route.fulfill(assets.get(url.pathname) || { status: 404, body: '' })
    })
    const page = await context.newPage()
    const widths = isMobile ? [320, 375, 390, 420, 430, 680] : [768, 1024, 1400]
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('http://landing.test/')
      const layout = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        pageWidth: document.documentElement.scrollWidth,
        logo: document.querySelector('[data-logo-replay]').getBoundingClientRect().toJSON()
      }))
      assert.equal(layout.pageWidth, layout.viewport, `${engine}: the home must not overflow horizontally at ${width}px`)
      if (isMobile) assert.ok(layout.logo.right > width, 'The oversized logo must still extend past the screen edge')

      await page.evaluate(() => window.scrollTo(500, 0))
      assert.equal(await page.evaluate(() => window.scrollX), 0, 'Horizontal scrolling must remain blocked')
      const control = page.getByRole('button', { name: 'Rejouer l’animation du logo' })
      await control.focus()
      assert.equal(await page.evaluate(() => window.scrollX), 0, 'Focusing the oversized logo must not shift the page')
      await control.press('Enter')
      await page.waitForFunction(() => document.querySelector('[data-logo-animation]').src.includes('replay=1'))
      await page.getByRole('link', { name: 'Contact', exact: true }).first().click()
      assert.ok(await page.evaluate(() => window.scrollY > 0), 'Vertical navigation must still reach the contact section')
      assert.equal(await page.evaluate(() => window.scrollX), 0, 'Anchor navigation must not shift the page horizontally')
    }
    await context.close()
  }
  console.log(`${engine}: landing layout passed from 320px to 1400px; oversized logo, keyboard replay and vertical navigation preserved`)
} finally {
  await browser.close()
}
