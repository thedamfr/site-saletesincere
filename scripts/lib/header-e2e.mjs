import assert from 'node:assert/strict'
import path from 'node:path'

const routes = ['/', '/podcast', '/damien-cavailles', '/laboratoire-du-geste', '/newsletter', '/newsletter/confirmed']
const widths = [320, 390, 768, 1440]
const expectedLinks = [
  { text: 'Podcast', href: '/podcast' },
  { text: 'À propos', href: '/damien-cavailles' },
  { text: 'Contact', href: '/#contact' }
]

async function readHeader(page) {
  await page.locator('.site-logo img').evaluate(async image => {
    await image.decode()
    await document.fonts.ready
  })
  const links = await page.getByRole('navigation', { name: 'Navigation principale', exact: true })
    .getByRole('link').evaluateAll(elements => elements.map(element => ({
      text: element.textContent.trim(), href: element.getAttribute('href')
    })))
  assert.deepEqual(links, expectedLinks)
  assert.equal(await page.locator('.site-header').getByRole('link', { name: 'Accueil Saleté Sincère', exact: true }).getAttribute('href'), '/')
  return page.locator('.site-header').evaluate(header => {
    const bounds = element => {
      const rectangle = element.getBoundingClientRect()
      return Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.round(rectangle[key] * 100) / 100]))
    }
    const appearance = element => {
      const style = getComputedStyle(element)
      return Object.fromEntries([
        'color', 'backgroundColor', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight',
        'letterSpacing', 'borderBottomColor', 'borderBottomWidth', 'borderRadius'
      ].map(key => [key, style[key]]))
    }
    const image = header.querySelector('.site-logo img')
    const elements = [header, header.querySelector('.site-header-inner'), header.querySelector('.site-logo'),
      image, header.querySelector('.site-navigation'), ...header.querySelectorAll('.site-navigation a')]
    return {
      geometry: elements.map(bounds),
      appearance: elements.map(appearance),
      logo: { src: image.getAttribute('src'), alt: image.alt, width: image.naturalWidth, height: image.naturalHeight },
      fits: elements.every(element => {
        const rectangle = element.getBoundingClientRect()
        return rectangle.left >= -0.5 && rectangle.right <= innerWidth + 0.5
      }) && header.scrollWidth <= header.clientWidth,
      loadedOswald: document.fonts.check('16px Oswald')
    }
  })
}

async function visit(page, base, route) {
  const response = await page.goto(base + route)
  assert.equal(response.status(), 200, `The public page must load: ${route}`)
  assert.equal(new URL(page.url()).pathname, route)
}

async function assertContact(page, base) {
  assert.equal(new URL(page.url()).origin, new URL(base).origin)
  assert.equal(new URL(page.url()).pathname, '/')
  assert.equal(new URL(page.url()).hash, '#contact')
  assert.equal(await page.locator('#contact').evaluate(element => {
    const rectangle = element.getBoundingClientRect()
    return rectangle.bottom > 0 && rectangle.top < innerHeight
  }), true, 'Contact must bring the visitor to the contact section')
}

async function assertNoStorage(context, page) {
  assert.deepEqual(await context.cookies(), [], 'Header navigation must not require cookies')
  assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
    { local: 0, session: 0 }, 'Header navigation must not persist browser state')
}

function preventWrites(context, writes) {
  return context.route('**/*', async route => {
    const request = route.request()
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
      await route.abort('blockedbyclient')
      return
    }
    await route.continue()
  })
}

export async function runHeaderGoldenJourneys(browser, { base, output, localTarget, outcomes, results = {} }) {
  const measurements = []
  const screenshots = []
  const writes = []
  Object.assign(results, { routes, widths, measurements, screenshots, writes })
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } })
  await preventWrites(context, writes)
  try {
    const page = await context.newPage()
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 })
      let reference
      for (const route of routes) {
        await visit(page, base, route)
        const actual = await readHeader(page)
        assert.equal(actual.fits, true, `The entire header must fit at ${width}px on ${route}`)
        assert.ok(actual.logo.width > 0 && actual.logo.height > 0, 'The real logo must load')
        if (!reference) reference = actual
        assert.deepEqual(actual, reference, `Header dimensions, colors, typography and logo must match at ${width}px on ${route}`)
        measurements.push({ route, width, ...actual })
        if ((width === 390 && ['/', '/podcast', '/damien-cavailles'].includes(route))
          || (route === '/damien-cavailles' && [320, 1440].includes(width))) {
          const filename = `header-${route === '/' ? 'home' : route.slice(1)}-${width}.png`
          await page.screenshot({ path: path.join(output, filename) })
          screenshots.push(filename)
        }
      }
    }
    outcomes.push('Golden Journey — même en-tête sur six pages publiques aux largeurs 320, 390, 768 et 1440 px : OK')

    await page.setViewportSize({ width: 390, height: 900 })
    for (const route of routes) {
      await visit(page, base, route)
      await page.locator('.site-header').getByRole('link', { name: 'Accueil Saleté Sincère', exact: true }).click()
      await page.waitForURL(base + '/')
      assert.match(await page.locator('h1').innerText(), /On gratte la surface/i)
      await page.getByRole('navigation', { name: 'Navigation principale', exact: true }).getByRole('link', { name: 'Podcast', exact: true }).click()
      await page.waitForURL(base + '/podcast')
      assert.match(await page.locator('h1').innerText(), /Charbon/i)
      assert.equal(await page.locator('.site-navigation a[aria-current="page"]').getAttribute('href'), '/podcast')
      await page.getByRole('navigation', { name: 'Navigation principale', exact: true }).getByRole('link', { name: 'À propos', exact: true }).click()
      await page.waitForURL(base + '/damien-cavailles')
      assert.equal(await page.locator('h1').innerText(), 'Damien Cavaillès')
      assert.equal(await page.locator('.site-navigation a[aria-current="page"]').getAttribute('href'), '/damien-cavailles')
      await page.getByRole('navigation', { name: 'Navigation principale', exact: true }).getByRole('link', { name: 'Contact', exact: true }).click()
      await page.waitForURL(base + '/#contact')
      await assertContact(page, base)
    }
    if (localTarget) {
      await visit(page, base, '/podcast/3/2')
      assert.equal(await page.locator('h1').innerText(), 'Épisode de qualification du header')
      assert.equal(await page.locator('.site-navigation a[aria-current="location"]').getAttribute('href'), '/podcast')
      await page.getByRole('navigation', { name: 'Navigation principale', exact: true }).getByRole('link', { name: 'Podcast', exact: true }).click()
      await page.waitForURL(base + '/podcast')
    }
    await assertNoStorage(context, page)
    outcomes.push(`Golden Journey — depuis chaque page : logo → accueil → podcast → À propos → contact, état actif${localTarget ? ' et retour depuis un épisode local' : ''} : OK`)

    await visit(page, base, '/')
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('href')), '#contenu')
    for (const href of ['/', '/podcast', '/damien-cavailles', '/#contact']) {
      await page.keyboard.press('Tab')
      const focused = await page.evaluate(() => {
        const element = document.activeElement
        const style = getComputedStyle(element)
        return { href: element.getAttribute('href'), inHeader: Boolean(element.closest('.site-header')),
          visible: element.matches(':focus-visible') && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 }
      })
      assert.deepEqual(focused, { href, inHeader: true, visible: true }, `Keyboard focus must identify ${href}`)
    }
    await page.keyboard.press('Enter')
    await assertContact(page, base)
    outcomes.push('Golden Journey — lien d’évitement puis logo et navigation au clavier, focus visible et activation de Contact : OK')
  } finally {
    await context.close()
  }

  const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 320, height: 900 } })
  await preventWrites(noJs, writes)
  try {
    const page = await noJs.newPage()
    for (const route of routes) {
      await visit(page, base, route)
      const before = await readHeader(page)
      const response = await page.reload()
      assert.equal(response.status(), 200)
      assert.deepEqual(await readHeader(page), before, `Header must survive reload without JavaScript on ${route}`)
      await page.getByRole('navigation', { name: 'Navigation principale', exact: true }).getByRole('link', { name: 'À propos', exact: true }).click()
      await page.waitForURL(base + '/damien-cavailles')
      assert.equal(await page.locator('h1').innerText(), 'Damien Cavaillès')
      await page.getByRole('navigation', { name: 'Navigation principale', exact: true }).getByRole('link', { name: 'Contact', exact: true }).click()
      await page.waitForURL(base + '/#contact')
      await assertContact(page, base)
    }
    await assertNoStorage(noJs, page)
    assert.deepEqual(writes, [], 'No newsletter subscription or other mutation may be attempted')
    outcomes.push('Golden Journey — consultation anonyme sans JavaScript, rechargement, navigation et contact sans cookie ni stockage : OK')
  } finally {
    await noJs.close()
  }
  return results
}
