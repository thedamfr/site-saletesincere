import http from 'node:http';
import { readFile, open } from 'node:fs/promises';

export const fixtureEpisodes = [0, 1, 2].map(episode => ({
  season: 91, episode, guid: `qualification-s91e${episode}`,
  title: `Qualification épisode ${episode}`, date: `2025-01-0${episode + 1}`,
  spotify: `https://open.spotify.com/episode/${String(episode + 1).padStart(22, '0')}`
}));

// This provider lives on the controller, outside the VM that is cut. Its journal
// and effect counters survive guest restarts. It never sends a real email.
export async function startFixture({ port = 31857, output }) {
  let config = { brevo: {}, platforms: {}, rss: {}, op3: {} };
  const contacts = new Map();
  let effects = 0;
  let mutationsAttempted = 0;
  const calls = {};
  const waiters = new Set();
  let sequence = 0;
  if (output) {
    try {
      const previous = JSON.parse(await readFile(output, 'utf8'));
      for (const [email, contact] of previous.contacts) contacts.set(email, contact);
      effects = previous.effects;
      mutationsAttempted = previous.mutationsAttempted;
      sequence = previous.sequence;
      Object.assign(calls, previous.calls);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const json = (res, value, status = 200) => {
    if (res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  let saving = Promise.resolve();
  const save = () => {
    if (!output) return Promise.resolve();
    const snapshot = JSON.stringify({ effects, mutationsAttempted, sequence, calls, contacts: [...contacts] });
    saving = saving.then(async () => {
      const file = await open(output, 'w', 0o600);
      try { await file.writeFile(snapshot); await file.sync(); } finally { await file.close(); }
    });
    return saving;
  };
  const pause = async (kind, email) => {
    if (kind === 'brevo' && config.brevo.target && config.brevo.target !== email) return;
    await new Promise(resolve => waiters.add({ kind, resolve }));
  };
  const server = http.createServer(async (req, res) => {
    try {
      const route = new URL(req.url, 'http://fixture.invalid');
      if (!route.pathname.startsWith('/upstream/')) return json(res, { error: 'unknown_fixture_route' }, 404);
      const upstream = new URL(decodeURIComponent(route.pathname.slice('/upstream/'.length)));
      calls[upstream.hostname] = (calls[upstream.hostname] || 0) + 1;
      if (upstream.hostname === 'brevo.invalid') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        const email = body.email || body.emails?.[0] || decodeURIComponent(upstream.pathname.split('/').at(-1));
        if (!email.endsWith('@example.test')) return json(res, { code: 'invalid_parameter' }, 400);
        const targeted = !config.brevo.target || config.brevo.target === email;
        if (targeted && config.brevo.unavailable) return json(res, { code: 'service_unavailable' }, 503);
        if (req.method === 'GET') {
          if (targeted && config.brevo.blocked) return json(res, { id: 200, email, listIds: [], emailBlacklisted: true });
          if (targeted && config.brevo.hideContact) return json(res, { code: 'document_not_found' }, 404);
          if (targeted && config.brevo.partialFailure) return json(res, { id: 100, email, listIds: [], emailBlacklisted: false });
          const contact = contacts.get(email);
          return contact ? json(res, contact) : json(res, { code: 'document_not_found' }, 404);
        }
        const adding = /\/contacts\/lists\/\d+\/contacts\/add$/.test(upstream.pathname);
        mutationsAttempted++;
        if (!adding && (contacts.has(email) || (targeted && config.brevo.partialFailure))) {
          return json(res, { code: 'duplicate_parameter' }, 400);
        }
        if (targeted && config.brevo.hold === 'before-effect') await pause('brevo', email);
        if (res.destroyed) return;
        if (targeted && config.brevo.partialFailure) return json(res, { contacts: { success: [], failure: [email] } }, 201);
        const contact = contacts.get(email) || { id: ++sequence, email, listIds: [], emailBlacklisted: false };
        const lists = adding ? [Number(upstream.pathname.split('/')[4])] : body.listIds;
        for (const list of lists || []) if (!contact.listIds.includes(list)) { contact.listIds.push(list); effects++; }
        contacts.set(email, contact);
        await save();
        if (targeted && config.brevo.hold === 'after-effect') await pause('brevo', email);
        return adding ? json(res, { contacts: { success: [email], failure: [] } }, 201) : json(res, { id: contact.id }, 201);
      }
      if (upstream.hostname === 'podcasts.saletesincere.fr' && !upstream.pathname.endsWith('.wav')) {
        if (config.rss.unavailable) return json(res, {}, 503);
        const items = fixtureEpisodes.map(ep => `<item><title>${ep.title}</title><description>Récit synthétique de qualification.</description><pubDate>${ep.date}T12:00:00Z</pubDate><guid>${ep.guid}</guid><itunes:season>${ep.season}</itunes:season><itunes:episode>${ep.episode}</itunes:episode><itunes:episodeType>${ep.episode === 0 ? 'trailer' : 'full'}</itunes:episodeType><itunes:duration>60</itunes:duration><itunes:image href="https://media.invalid/cover.png"/><enclosure url="https://podcasts.saletesincere.fr/qualification.wav" type="audio/wav"/><link>https://podcasts.saletesincere.fr/episode/${ep.episode}</link></item>`).join('');
        res.writeHead(200, { 'content-type': 'application/rss+xml' });
        return res.end(`<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Qualification</title><description>Podcast de qualification</description><lastBuildDate>2026-01-01T00:00:00Z</lastBuildDate>${items}</channel></rss>`);
      }
      if (upstream.hostname === 'op3.dev') {
        if (config.op3.unavailable) return json(res, {}, 503);
        if (config.op3.hold) await pause('op3');
        const showUuid = '1234567890abcdef1234567890abcdef';
        if (upstream.pathname.includes('/shows/')) return json(res, { showUuid, episodes: fixtureEpisodes.map(ep => ({ id: ep.guid, title: ep.title, pubdate: ep.date })) });
        if (upstream.pathname.includes('/queries/')) return json(res, { showUuid, episodes: fixtureEpisodes.map(ep => ({ itemGuid: ep.guid, title: ep.title, pubdate: ep.date, downloadsAll: 50 })) });
        return json(res, { rows: fixtureEpisodes.map(ep => ({ episodeId: ep.guid, time: new Date().toISOString() })) });
      }
      if (upstream.hostname === 'media.invalid' || upstream.pathname === '/qualification.wav') {
        // A complete, short PCM audio fixture supports the real browser player.
        if (upstream.pathname.endsWith('.wav')) {
          const bytes = Buffer.alloc(44 + 64000);
          bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
          bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
          bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
          bytes.write('data', 36); bytes.writeUInt32LE(64000, 40);
          for (let sample = 0; sample < 32000; sample++) bytes.writeInt16LE(Math.round(1000 * Math.sin(sample * 2 * Math.PI * 220 / 8000)), 44 + sample * 2);
          res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': bytes.length }); return res.end(bytes);
        }
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGasAAAAASUVORK5CYII=', 'base64');
        res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png);
      }
      if (config.platforms.unavailable) return json(res, {}, 503);
      if (config.platforms.hold) await pause('platforms');
      if (upstream.hostname === 'accounts.spotify.com') return json(res, { access_token: 'qualification-token' });
      if (upstream.hostname === 'api.spotify.com') return json(res, { items: fixtureEpisodes.map(ep => ({ release_date: ep.date, external_urls: { spotify: ep.spotify } })) });
      if (upstream.hostname === 'open.spotify.com') return json(res, { type: 'rich', html: '<iframe></iframe>' });
      if (upstream.hostname === 'itunes.apple.com') return json(res, { results: fixtureEpisodes.map(ep => ({ wrapperType: 'podcastEpisode', collectionId: 12345, episodeGuid: ep.guid, releaseDate: `${ep.date}T12:00:00Z`, trackViewUrl: `https://podcasts.apple.com/fr/podcast/qualification/id12345?i=${90000 + ep.episode}` })) });
      if (upstream.hostname === 'api.deezer.com') return json(res, { data: fixtureEpisodes.map(ep => ({ release_date: `${ep.date} 12:00:00`, id: 90000 + ep.episode })) });
      return json(res, { error: 'unrepresented_provider' }, 502);
    } catch {
      json(res, { error: 'fixture_error' }, 500);
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    addEpisode() {
      const episode = Math.max(...fixtureEpisodes.map(item => item.episode)) + 1;
      const value = { season: 91, episode, guid: `qualification-s91e${episode}`,
        title: `Qualification épisode ${episode}`, date: new Date(Date.UTC(2025, 0, episode + 1)).toISOString().slice(0, 10),
        spotify: `https://open.spotify.com/episode/${String(episode + 1).padStart(22, '0')}` };
      fixtureEpisodes.push(value);
      return value;
    },
    async configure(next) {
      for (const [key, value] of Object.entries(next)) config[key] = { ...config[key], ...value };
      for (const waiter of waiters) {
        if (!config[waiter.kind]?.hold) { waiters.delete(waiter); waiter.resolve(); }
      }
      await save();
    },
    async snapshot() { return { effects, mutationsAttempted, calls: { ...calls }, waiting: waiters.size, contacts: contacts.size }; },
    async close() {
      for (const waiter of waiters) waiter.resolve();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}

// Mounted only in the disposable guest. The ordinary image still runs server.js.
// All upstream fetches go through the controller; there is no network fallback.
export const qualificationEntrypoint = `
import os from 'node:os';
if (process.env.QUALIFICATION_KIND !== 'site-issue56') throw new Error('Qualification identity required');
const originalFetch = globalThis.fetch;
const fixtureBase = 'http://10.0.2.15:31857/upstream/';
globalThis.fetch = (input, options) => originalFetch(fixtureBase + encodeURIComponent(String(input)), options);
const { buildApp } = await import('/app/server.js');
const app = await buildApp();
await app.listen({ host: '0.0.0.0', port: 3000 });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await app.close(); process.exit(0); });
`;
