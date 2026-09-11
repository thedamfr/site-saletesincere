import fs from 'node:fs';
import path from 'node:path';
import { github } from './github.mjs';
import { environments } from './policy.mjs';
import { smoke } from './smoke.mjs';
import { notificationCandidates, notificationFor, inspectHealth, sendTelegram, deliverOnce } from './notifications.mjs';

const read = (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
const compactRun = run => Object.fromEntries(['id', 'status', 'conclusion', 'head_sha', 'head_branch', 'event', 'path', 'display_title', 'updated_at', 'head_repository'].map(key => [key,
  key === 'head_repository' ? { full_name: run.head_repository?.full_name } : run[key]]));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Runs under the existing deployment flock. No GitHub credential leaves GitHub.
export async function notifyDeliveries(stateDirectory, credentialsDirectory) {
  const statePath = path.join(stateDirectory, 'notifications.json');
  const cache = read(statePath, { enabledAt: Date.now(), sent: {}, retryAfter: {}, runs: [], nextPollAt: 0 });
  const save = () => {
    fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(cache, null, 2), { mode: 0o600 });
    fs.renameSync(`${statePath}.tmp`, statePath);
  };
  save(); // Establish the cutoff before any attempt; do not replay historical runs.
  if (Date.now() >= cache.nextPollAt) {
    try {
      const { workflow_runs: runs } = await github('actions/workflows/publish-image.yml/runs?per_page=100');
      cache.runs = runs.map(compactRun);
      cache.nextPollAt = Date.now() + 5 * 60000;
    } catch {
      cache.nextPollAt = Date.now() + 5 * 60000;
      console.error('Cannot refresh deployment notification events; retry in five minutes.');
      process.exitCode = 1;
    }
    save();
  }
  const states = {};
  for (const environment of Object.keys(environments)) {
    const state = read(path.join(stateDirectory, `${environment}.json`), null);
    if (!state) continue;
    states[environment] = state;
    const index = cache.runs.findIndex(run => run.id === state.runId);
    if (Date.parse(state.success ? state.verifiedAt : state.failedAt) >= cache.enabledAt
        && !(state.success && cache.sent[`${state.runId}:success:info`])
        && (index < 0 || cache.runs[index].status !== 'completed' || (state.success && cache.runs[index].conclusion !== 'success'))) {
      const run = compactRun(await github(`actions/runs/${state.runId}`));
      if (index < 0) cache.runs.push(run); else cache.runs[index] = run;
    }
  }
  const candidates = notificationCandidates(cache.runs, states, cache, Date.now());
  for (const candidate of candidates) {
    const { run, release } = candidate;
    if (cache.retryAfter[run.id] > Date.now()) continue;
    let notification;
    try {
      const environment = notificationFor({ ...candidate, health: { availability: 'unavailable' } }).environment;
      const url = environments[environment].url;
      let verification = candidate.verification;
      if (verification === 'success') {
        try {
          await smoke(url, release.cssHash, release);
          await pause(30000);
          await smoke(url, release.cssHash, release);
        } catch { verification = 'failure'; }
      }
      let health = await inspectHealth(url);
      if (health.availability !== 'healthy') { await pause(3000); health = await inspectHealth(url); }
      notification = notificationFor({ ...candidate, verification, health });
      const result = await deliverOnce(notification, {
        alreadySent: async key => Boolean(cache.sent[key]),
        send: text => {
          const token = fs.readFileSync(path.join(credentialsDirectory, 'telegram-token'), 'utf8').trim();
          const recipient = read(path.join(credentialsDirectory, 'telegram-recipient'), {});
          if (String(recipient.bot_id) !== token.split(':')[0]) throw new Error('Telegram recipient mismatch');
          return sendTelegram(text, { token, chatId: recipient.chat_id });
        },
        record: async (key, receipt) => {
          cache.sent[key] = { acceptedAt: new Date().toISOString(), messageId: receipt.messageId };
          delete cache.retryAfter[run.id];
          save();
        }
      });
      if (result === 'sent') console.log(JSON.stringify({ telegram: 'accepted', environment, runId: run.id, outcome: notification.outcome, severity: notification.severity }));
    } catch {
      cache.retryAfter[run.id] = Date.now() + 5 * 60000;
      save();
      console.error(JSON.stringify({ telegram: 'failed', runId: run.id, retryInSeconds: 300 }));
      process.exitCode = 1;
    }
  }
  save();
}
