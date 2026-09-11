import { hash } from './policy.mjs';

export async function smoke(url, cssHash, release) {
  const get = async (path, redirect = 'follow') => {
    const response = await fetch(`${url}${path}${path.includes('?') ? '&' : '?'}delivery_check=${Date.now()}`, {
      redirect, signal: AbortSignal.timeout(20000), headers: { 'Cache-Control': 'no-cache' }
    });
    return response;
  };
  const healthResponse = await get('/health');
  const health = await healthResponse.json();
  if (release && (health.release?.sourceCommit !== release.imageCommit || health.release?.digest !== release.digest)) throw new Error('Expected release is not active on the public domain');
  if (!healthResponse.ok || health.mode !== 'normal' || health.database?.state !== 'read_write' || health.episodeWorker?.state !== 'ready') {
    throw new Error('Health is not normal/read_write/ready');
  }
  for (const path of ['/', '/podcast', '/laboratoire-du-geste']) {
    const response = await get(path);
    const html = await response.text();
    if (response.status !== 200 || !html.includes('<html') || !html.includes('<main')) throw new Error(`Invalid public page: ${path}`);
    if (url.includes('staging.') !== (response.headers.get('x-robots-tag') || '').includes('noindex')) throw new Error('Incorrect indexing policy');
    if (path === '/podcast') {
      const episodePath = html.match(/href="(\/podcast\/\d+\/\d+)"/)?.[1];
      if (!episodePath) throw new Error('Podcast contains no episode link');
      const episode = await get(episodePath);
      if (episode.status !== 200 || !(await episode.text()).includes('podcast-episode')) throw new Error('Episode page failed');
    }
  }
  const css = await get('/style.css');
  if (css.status !== 200 || hash(Buffer.from(await css.arrayBuffer())) !== cssHash) throw new Error('Public CSS differs from the validated build');
  const legacy = await get('/__logo-lab', 'manual');
  if (legacy.status !== 301 || legacy.headers.get('location') !== '/laboratoire-du-geste') throw new Error('Legacy lab redirect failed');
  const wall = await get('/wall', 'manual');
  if (![301, 302, 303].includes(wall.status) || wall.headers.get('location') !== '/') throw new Error('Disabled wall redirect failed');
}
