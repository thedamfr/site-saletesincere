import fs from 'node:fs';
import { environments } from './policy.mjs';

const targets = process.argv.slice(2);
if (!targets.length || targets.some(target => !environments[target])) throw new Error('Specify production and/or staging');
const output = process.env.AVAILABILITY_REPORT || '/tmp/site-delivery-availability.json';
const checks = [];
let running = true;
fs.writeFileSync(`${output}.pid`, String(process.pid));
process.on('SIGINT', () => { running = false; });
while (running) {
  await Promise.all(targets.map(async environment => {
    const started = Date.now();
    try {
      const response = await fetch(`${environments[environment].url}/health?availability=${started}`, { signal: AbortSignal.timeout(8000) });
      const health = await response.json();
      checks.push({ environment, at: new Date(started).toISOString(), status: response.status, mode: health.mode,
        worker: health.episodeWorker?.state, source: health.release?.sourceCommit, durationMs: Date.now() - started });
    } catch (error) {
      checks.push({ environment, at: new Date(started).toISOString(), status: 'error', error: error.name, durationMs: Date.now() - started });
    }
  }));
  fs.writeFileSync(output, JSON.stringify(checks));
  await new Promise(resolve => setTimeout(resolve, 1000));
}
console.log(JSON.stringify({ checks: checks.length, failures: checks.filter(check => check.status !== 200 || check.mode !== 'normal').length }));
