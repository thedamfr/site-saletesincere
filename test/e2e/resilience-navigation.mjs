import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export async function navigation({ browser, stateDir, outputDir, episodes, suffix }) {
  const episode = episodes.filter(item => item.episode > 0)
    .toSorted((left, right) => Date.parse(right.date) - Date.parse(left.date))[0];
  assert.ok(episode, 'A published fixture episode is required for navigation');
  const episodePath = `/podcast/${episode.season}/${episode.episode}`;
  const playerId = `${episode.season}-${episode.episode}`;
  const context = await browser.newContext();
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname === 'cdn.jsdelivr.net' && url.pathname === '/npm/wavesurfer.js@7/dist/wavesurfer.esm.js') {
      return route.fulfill({ contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body: await readFile(`${stateDir}/wavesurfer.esm.js`) });
    }
    if (url.hostname === 'media.invalid') {
      const response = await fetch(`http://127.0.0.1:31857/upstream/${encodeURIComponent(url.href)}`);
      return route.fulfill({ status: response.status, contentType: response.headers.get('content-type'), body: Buffer.from(await response.arrayBuffer()) });
    }
    if (['open.spotify.com', 'podcasts.apple.com', 'www.deezer.com'].includes(url.hostname)) return route.fulfill({ contentType: 'text/html', body: '<h1>Plateforme simulée</h1>' });
    return route.abort();
  });
  try {
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:31856/');
    await page.getByRole('link', { name: 'Podcast', exact: true }).first().click();
    assert.equal(new URL(page.url()).hash, '#podcast');
    await page.locator('a[href="/podcast"]').first().click();
    await page.waitForURL('**/podcast');
    assert.equal(new URL(page.url()).pathname, '/podcast');
    await page.locator(`a[href="${episodePath}"]`).first().click();
    await page.getByRole('heading', { name: episode.title, exact: false }).first().waitFor();
    await page.waitForFunction(id => document.getElementById(id)?.style.display === 'none', `waveform-loader-${playerId}`);
    await page.getByRole('button', { name: 'Lire l’épisode', exact: true }).click();
    await page.getByRole('button', { name: 'Mettre en pause', exact: true }).waitFor();
    await page.waitForFunction(id => document.getElementById(id)?.textContent.startsWith('0:01'), `time-${playerId}`);
    await page.getByRole('button', { name: 'Mettre en pause', exact: true }).click();
    const spotify = page.locator('a[href^="https://open.spotify.com/episode/"]').first();
    assert.equal(await spotify.getAttribute('href'), episode.spotify);
    await page.screenshot({ path: `${outputDir}/podcast-${suffix}.png`, fullPage: true });
    const target = await spotify.getAttribute('target');
    if (target === '_blank') {
      const popup = context.waitForEvent('page');
      await spotify.click();
      const destination = await popup;
      await destination.waitForLoadState();
      assert.equal(new URL(destination.url()).hostname, 'open.spotify.com');
      await destination.close();
    } else {
      await spotify.click();
      assert.equal(new URL(page.url()).hostname, 'open.spotify.com');
    }
  } finally { await context.close(); }
}
