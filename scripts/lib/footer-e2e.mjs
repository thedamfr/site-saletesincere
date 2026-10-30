import assert from 'node:assert/strict'
import path from 'node:path'

const routes = ['/', '/photographie', '/podcast', '/damien-cavailles', '/laboratoire-du-geste', '/newsletter', '/newsletter/confirmed', '/offre-production-podcast/']
const widths = [320, 390, 768, 1440]
const expectedLinks = [
  { text: 'Accueil', href: '/' },
  { text: 'Photographie', href: '/photographie' },
  { text: 'Podcast', href: '/podcast' },
  { text: 'À propos', href: '/damien-cavailles' },
  { text: 'Laboratoire du geste', href: '/laboratoire-du-geste' },
  { text: 'Contact', href: '/#contact' },
  { text: "Besoin d'un producteur sur mon podcast ?", href: '/offre-production-podcast/' }
]

async function visit(page, base, route) {
  const response = await page.goto(base + route)
  assert.equal(response.status(), 200, `The public page must load: ${route}`)
  assert.equal(new URL(page.url()).pathname, route)
}

async function readFooter(page) {
  const footer = page.getByRole('contentinfo')
  assert.equal(await footer.count(), 1, 'Every page must expose one contentinfo landmark')
  await footer.scrollIntoViewIfNeeded()
  await footer.locator('img').evaluate(async image => {
    await image.decode()
    await document.fonts.ready
  })
  const links = await footer.getByRole('navigation', { name: 'Navigation de pied de page', exact: true })
    .getByRole('link').evaluateAll(elements => elements.map(element => ({ text: element.textContent.trim(), href: element.getAttribute('href') })))
  assert.deepEqual(links, expectedLinks)
  assert.equal(await footer.getByRole('link', { name: 'Accueil Saleté Sincère', exact: true }).getAttribute('href'), '/')
  assert.equal(await footer.getByRole('link', { name: 'damien@saletesincere.fr', exact: true }).getAttribute('href'), 'mailto:damien@saletesincere.fr')
  return footer.evaluate(element => {
    const origin = element.getBoundingClientRect()
    const elements = [element, ...element.querySelectorAll('.site-footer-inner, img, nav, a, p')]
    const bounds = node => {
      const rectangle = node.getBoundingClientRect()
      return Object.fromEntries(Object.entries({ x: rectangle.x - origin.x, y: rectangle.y - origin.y,
        width: rectangle.width, height: rectangle.height }).map(([key, value]) => [key, Math.round(value * 100) / 100]))
    }
    const appearance = node => {
      const style = getComputedStyle(node)
      return Object.fromEntries(['color', 'backgroundColor', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight',
        'letterSpacing', 'borderTopColor', 'borderTopWidth', 'borderRadius', 'textDecorationLine'].map(key => [key, style[key]]))
    }
    const image = element.querySelector('img')
    return {
      text: element.textContent.replace(/\s+/g, ' ').trim(),
      geometry: elements.map(bounds),
      appearance: elements.map(appearance),
      logo: { src: image.getAttribute('src'), alt: image.alt, width: image.naturalWidth, height: image.naturalHeight },
      outsideMain: element.parentElement === document.body,
      fits: elements.every(node => {
        const rectangle = node.getBoundingClientRect()
        return rectangle.left >= -0.5 && rectangle.right <= innerWidth + 0.5
      }) && element.scrollWidth <= element.clientWidth
    }
  })
}

async function assertContact(page, base) {
  assert.equal(page.url(), base + '/#contact')
  assert.equal(await page.locator('#contact').evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return bounds.bottom > 0 && bounds.top < innerHeight
  }), true, 'The footer Contact link must reach the visible contact section')
}

async function assertNoStorage(context, page) {
  assert.deepEqual(await context.cookies(), [], 'Footer navigation must not require cookies')
  assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
    { local: 0, session: 0 }, 'Footer navigation must not persist browser state')
}

async function preventWrites(context, writes) {
  await context.route('**/*', async route => {
    const request = route.request()
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
}

export async function runFooterGoldenJourneys(browser, { base, output, localTarget, outcomes, results = {} }) {
  const measurements = [], screenshots = [], writes = []
  Object.assign(results, { routes, widths, measurements, screenshots, writes })
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } })
  await preventWrites(context, writes)
  try {
    const page = await context.newPage()
    const references = new Map()
    // Resize each loaded page instead of reloading it for every width. This
    // keeps the combined header/footer journey within newsletter rate limits.
    for (const route of routes) {
      await visit(page, base, route)
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 })
        const actual = await readFooter(page)
        assert.equal(actual.fits, true, `Footer must fit horizontally at ${width}px on ${route}`)
        assert.equal(actual.outsideMain, true, `Footer must sit outside page content containers on ${route}`)
        assert.ok(actual.logo.width > 0 && actual.logo.height > 0, 'The footer logo must load')
        if (!references.has(width)) references.set(width, actual)
        assert.deepEqual(actual, references.get(width), `Footer content, relative geometry and styles must match at ${width}px on ${route}`)
        measurements.push({ route, width, ...actual })
        if (width === 390 && ['/', '/damien-cavailles', '/offre-production-podcast/'].includes(route)) {
          const filename = `footer-${route === '/' ? 'home' : route.replace(/^\/|\/$/g, '')}-${width}.png`
          await page.getByRole('contentinfo').screenshot({ path: path.join(output, filename) })
          screenshots.push(filename)
        }
      }
    }
    await page.setViewportSize({ width: 390, height: 900 })
    if (localTarget) {
      await visit(page, base, '/podcast/3/2')
      assert.deepEqual(await readFooter(page), references.get(390), 'An episode must retain the same footer')
    }
    outcomes.push('Golden Journey — même footer sur huit pages publiques à 320/390/768/1440 px, contenu, styles et géométrie relative : OK')

    // Follow every shared internal destination once, from successive real pages.
    for (const index of [1, 2, 3, 4, 6, 5, 0]) {
      const { text, href } = expectedLinks[index]
      await page.getByRole('contentinfo').getByRole('navigation').getByRole('link', { name: text, exact: true }).click()
      await page.waitForURL(base + href)
      if (href === '/#contact') await assertContact(page, base)
      else await page.locator('main h1').waitFor()
    }
    await page.getByRole('contentinfo').getByRole('link', { name: 'Accueil Saleté Sincère', exact: true }).click()
    await page.waitForURL(base + '/')
    await visit(page, base, '/damien-cavailles')
    const footer = page.getByRole('contentinfo')
    await footer.getByRole('link', { name: 'Accueil Saleté Sincère', exact: true }).focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    const destinations = await footer.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('href')))
    for (let index = 0; index < destinations.length; index++) {
      if (index) await page.keyboard.press('Tab')
      const focused = await page.evaluate(() => {
        const active = document.activeElement, style = getComputedStyle(active)
        return { href: active.getAttribute('href'), inFooter: Boolean(active.closest('.site-footer')),
          visible: active.matches(':focus-visible') && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 }
      })
      assert.deepEqual(focused, { href: destinations[index], inFooter: true, visible: true })
    }
    await footer.getByRole('navigation').getByRole('link', { name: 'Contact', exact: true }).focus()
    await page.keyboard.press('Enter')
    await page.waitForURL(base + '/#contact')
    await assertContact(page, base)
    await assertNoStorage(context, page)
    outcomes.push('Golden Journey — liens réels du footer, retour accueil, ordre clavier, focus visible et activation de Contact ; email vérifié sans envoi : OK')
  } finally {
    await context.close()
  }

  const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 320, height: 900 } })
  await preventWrites(noJs, writes)
  try {
    const page = await noJs.newPage()
    for (const route of routes) {
      await visit(page, base, route)
      const before = await readFooter(page)
      assert.equal((await page.reload()).status(), 200)
      assert.deepEqual(await readFooter(page), before, `Footer must survive reload without JavaScript on ${route}`)
    }
    await page.getByRole('contentinfo').getByRole('link', { name: 'Contact', exact: true }).click()
    await page.waitForURL(base + '/#contact')
    await assertContact(page, base)
    await page.getByRole('contentinfo').getByRole('link', { name: expectedLinks[6].text, exact: true }).click()
    await page.waitForURL(base + expectedLinks[6].href)
    await page.locator('main h1').waitFor()
    await assertNoStorage(noJs, page)
    assert.deepEqual(writes, [], 'No form submission or email request may be sent')
    outcomes.push('Golden Journey — footer sans JavaScript sur huit pages, rechargement, contact et offre podcast, sans cookie ni stockage navigateur : OK')
  } finally {
    await noJs.close()
  }
  return results
}
