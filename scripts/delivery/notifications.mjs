import { environments, repository, validateRelease } from './policy.mjs';
import { smoke } from './smoke.mjs';

function environmentForRun(run) {
  if (!['push', 'workflow_dispatch'].includes(run.event)
      || run.head_repository?.full_name !== repository
      || run.path !== '.github/workflows/publish-image.yml') return null;
  const environment = Object.keys(environments).find(value => run.display_title?.startsWith(`${value} ·`));
  if (!environment || !Number.isSafeInteger(run.id) || run.id < 1 || !/^[a-f0-9]{40}$/.test(run.head_sha)) return null;
  return environment;
}

export function notificationCandidates(runs, states, cache, now) {
  const candidates = new Map();
  for (const [environment, release] of Object.entries(states)) {
    const timestamp = Date.parse(release.success ? release.verifiedAt : release.failedAt);
    if (!(timestamp >= cache.enabledAt) || (release.success && (cache.sent[`${release.runId}:success:info`] || cache.uncertain?.[`${release.runId}:success:info`]))) continue;
    const run = runs.find(item => item.id === release.runId && environmentForRun(item) === environment);
    if (run) candidates.set(run.id, { run, release, verification: release.success ? 'success' : 'failure' });
  }
  const relevant = runs.filter(environmentForRun).sort((a, b) => b.id - a.id);
  for (const run of relevant) {
    if (candidates.has(run.id) || !(Date.parse(run.updated_at) >= cache.enabledAt) || run.status !== 'completed') continue;
    const environment = environmentForRun(run);
    const latest = relevant.find(item => environmentForRun(item) === environment);
    if (run.conclusion === 'cancelled' && latest.id !== run.id) continue;
    const failed = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(run.conclusion);
    const overdue = run.conclusion === 'success' && latest.id === run.id && states[environment]?.runId !== run.id
      && now - Date.parse(run.updated_at) >= 15 * 60000;
    if (!(failed || overdue) || Object.keys(cache.sent).some(key => key.startsWith(`${run.id}:`))) continue;
    candidates.set(run.id, { run, verification: failed ? 'skipped' : 'failure' });
  }
  return [...candidates.values()].sort((a, b) => a.run.id - b.run.id);
}

export function recoverNotificationAttempts(cache) {
  cache.uncertain ||= {};
  cache.inFlight ||= {};
  for (const [key, attempt] of Object.entries(cache.inFlight)) {
    cache.uncertain[key] = { ...attempt, reason: 'interrupted_before_receipt' };
    delete cache.inFlight[key];
  }
}

export function notificationFor({ run, release, health, verification, observation }) {
  const environment = environmentForRun(run);
  if (!environment || verification === 'superseded') return null;
  if (release) {
    validateRelease(release);
    if (release.environment !== environment || release.runId !== run.id || release.assessedCommit !== run.head_sha) throw new Error('Notification release mismatch');
  }
  const matches = release && health.sourceCommit === release.imageCommit && health.digest === release.digest;
  const success = run.conclusion === 'success' && verification === 'success' && health.availability === 'healthy'
    && matches && observation?.durationSeconds >= 60;
  let severity = 'info';
  if (!success) {
    severity = 'warning';
    if (environment === 'production') {
      if (health.availability === 'unavailable') severity = 'critical';
      else if (health.availability !== 'healthy' || (run.conclusion === 'success' && (!release || matches))) severity = 'high';
    }
  }
  const severityLabels = { info: 'INFORMATION', warning: 'AVERTISSEMENT', high: 'ÉLEVÉE', critical: 'CRITIQUE' };
  const icons = { info: '✅', warning: '⚠️', high: '🔴', critical: '🚨' };
  const healthSummary = health.availability === 'healthy' ? 'Site sain : base inscriptible, worker prêt.'
    : health.availability === 'degraded' ? 'Le site répond mais son fonctionnement normal n’est pas confirmé.'
      : 'Site injoignable ou en erreur HTTP depuis OVH ; impact global à confirmer.';
  const outcome = success ? 'success' : 'failure';
  const lines = [
    `${icons[severity]} Saleté Sincère — ${environment}`,
    success ? 'Déploiement réussi et vérifié.' : 'Déploiement échoué ou bloqué.',
    `Sévérité : ${severityLabels[severity]}`,
    ...(success ? [] : [run.conclusion !== 'success' ? 'Étape : CI (validation, build ou publication).' : 'Étape : activation OVH ou recette publique.']),
    healthSummary,
    `Contrôle UTC : ${observation?.completedAt || new Date().toISOString()}`,
    ...(success ? [`Observation : ${observation.durationSeconds} s de santé continue, sans anomalie.`,
      'Rollout, pages, épisode, CSS et version vérifiés.'] : []),
    `Commit évalué : ${run.head_sha.slice(0, 12)}`,
    ...(release ? [`Version attendue : ${release.imageCommit.slice(0, 12)}`, `Digest : ${release.digest}`] : []),
    ...(health.sourceCommit && /^[a-f0-9]{40}$/.test(health.sourceCommit) ? [`Version observée : ${health.sourceCommit.slice(0, 12)}`] : []),
    environments[environment].url,
    `https://github.com/${repository}/actions/runs/${run.id}`
  ];
  return { environment, outcome, severity, key: `${run.id}:${outcome}:${severity}`, text: lines.join('\n') };
}

export async function inspectHealth(url, { fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`${url}/health?notification=${Date.now()}`, {
      signal: AbortSignal.timeout(10000), headers: { 'Cache-Control': 'no-cache' }
    });
    if (!response.ok) return { availability: 'unavailable' };
    let health;
    try { health = await response.json(); } catch { return { availability: 'degraded' }; }
    if (!health || typeof health !== 'object') return { availability: 'degraded' };
    return { availability: health.mode === 'normal' && health.database?.state === 'read_write' && health.episodeWorker?.state === 'ready' ? 'healthy' : 'degraded',
      sourceCommit: health.release?.sourceCommit, digest: health.release?.digest };
  } catch { return { availability: 'unavailable' }; }
}

export async function observeDelivery(url, release, { now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), probe = inspectHealth, smokeCheck = smoke } = {}) {
  await smokeCheck(url, release.cssHash, release);
  const started = now();
  while (now() - started < 60000) {
    const health = await probe(url);
    if (health.availability !== 'healthy' || health.sourceCommit !== release.imageCommit || health.digest !== release.digest) {
      throw new Error('Public delivery did not remain stable');
    }
    await sleep(Math.min(1000, Math.max(0, 60000 - (now() - started))));
  }
  await smokeCheck(url, release.cssHash, release);
  return { durationSeconds: Math.floor((now() - started) / 1000), completedAt: new Date(now()).toISOString() };
}

export async function sendTelegram(text, { token, chatId, fetchImpl = fetch }) {
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token || '') || !/^[1-9]\d*$/.test(String(chatId)) || !Number.isSafeInteger(Number(chatId))) {
    throw Object.assign(new Error('Invalid Telegram configuration'), { code: 'TELEGRAM_CONFIGURATION' });
  }
  let rejected = false;
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
      body: JSON.stringify({ chat_id: Number(chatId), text, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) {
      rejected = response.status >= 400 && response.status < 500;
      throw new Error('rejected');
    }
    const body = await response.json();
    if (body.ok === false) { rejected = true; throw new Error('rejected'); }
    if (!body.ok || !Number.isSafeInteger(body.result?.message_id) || body.result.chat?.id !== Number(chatId) || body.result.chat.type !== 'private') throw new Error('unconfirmed');
    return { messageId: body.result.message_id };
  } catch {
    // Telegram embeds the token in its URL. Never propagate transport/provider errors.
    throw Object.assign(new Error(rejected ? 'Telegram refused the notification' : 'Telegram acceptance is unknown; inspect before retrying'),
      { code: rejected ? 'TELEGRAM_REJECTED' : 'TELEGRAM_UNCONFIRMED' });
  }
}

export async function deliverOnce(notification, { alreadySent, send, record }) {
  if (await alreadySent(notification.key)) return 'duplicate';
  const receipt = await send(notification.text);
  await record(notification.key, receipt);
  return 'sent';
}
