import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notificationFor, notificationCandidates, recoverNotificationAttempts, observeDelivery, inspectHealth, sendTelegram, deliverOnce } from '../../scripts/delivery/notifications.mjs';

const sha = 'a'.repeat(40);
const run = { id: 123, head_sha: sha, head_branch: 'main', event: 'push', conclusion: 'success',
  path: '.github/workflows/publish-image.yml', display_title: 'production · main',
  head_repository: { full_name: 'thedamfr/site-saletesincere' } };
const release = { environment: 'production', assessedCommit: sha, imageCommit: sha,
  digest: `sha256:${'b'.repeat(64)}`, schema: 'c'.repeat(64), fingerprint: 'd'.repeat(64), runId: 123 };
const health = { availability: 'healthy', sourceCommit: sha, digest: release.digest };
const observation = { durationSeconds: 60, completedAt: '2026-09-11T09:00:00Z' };
const event = change => notificationFor({ run, release, health, observation, verification: 'success', ...change });

test('Telegram success requires verified delivery and the expected healthy public version', () => {
  const result = event();
  assert.equal(result.severity, 'info');
  assert.match(result.text, /Déploiement réussi/);
  assert.match(result.text, /https:\/\/saletesincere.fr/);
  assert.match(result.text, /actions\/runs\/123/);
  assert.notEqual(event({ health: { ...health, digest: 'old' } }).outcome, 'success');
  assert.notEqual(event({ observation: { durationSeconds: 30 } }).outcome, 'success');
  assert.match(result.text, /60 s|60 secondes/);
  assert.match(result.text, /UTC/);
});

test('Telegram excludes PRs, unrelated repositories and superseded deliveries', () => {
  for (const candidate of [{ ...run, event: 'pull_request' }, { ...run, head_repository: { full_name: 'elsewhere/repo' } }, { ...run, path: 'other.yml' }]) {
    assert.equal(event({ run: candidate }), null);
  }
  assert.equal(event({ verification: 'superseded' }), null);
});

test('failed CI with a healthy production is a warning and never claims an activation', () => {
  const result = event({ run: { ...run, conclusion: 'failure' }, release: null, verification: 'skipped' });
  assert.equal(result.severity, 'warning');
  assert.equal(result.outcome, 'failure');
  assert.match(result.text, /CI/);
  assert.match(result.text, /AVERTISSEMENT/);
});

test('failed production verification distinguishes blocked, degraded and unavailable service', () => {
  assert.equal(event({ verification: 'failure', health: { ...health, sourceCommit: 'old' } }).severity, 'warning');
  assert.equal(event({ verification: 'failure' }).severity, 'high');
  assert.equal(event({ verification: 'failure', health: { availability: 'degraded' } }).severity, 'high');
  assert.equal(event({ verification: 'failure', health: { availability: 'unavailable' } }).severity, 'critical');
});

test('staging failures stay scoped to staging and do not claim a production outage', () => {
  const result = event({ run: { ...run, event: 'workflow_dispatch', display_title: 'staging · candidate', conclusion: 'failure' }, release: null,
    verification: 'skipped', health: { availability: 'unavailable' } });
  assert.equal(result.severity, 'warning');
  assert.match(result.text, /staging/);
  assert.doesNotMatch(result.text, /CRITIQUE|production injoignable/);
});

test('Telegram accepts only a positive private recipient and confirms the returned recipient', async () => {
  let payload;
  const fetchImpl = async (_url, options) => { payload = JSON.parse(options.body); return { ok: true,
    json: async () => ({ ok: true, result: { message_id: 17, chat: { id: 1234, type: 'private' } } }) }; };
  assert.deepEqual(await sendTelegram('message', { token: '123:abcdefghijklmnopqrst', chatId: '1234', fetchImpl }), { messageId: 17 });
  assert.equal(payload.chat_id, 1234);
  assert.equal(payload.link_preview_options.is_disabled, true);
  await assert.rejects(sendTelegram('message', { token: '123:abcdefghijklmnopqrst', chatId: '-1234', fetchImpl }), /configuration/);
});

test('Telegram transport errors never expose the token, provider response or URL', async () => {
  const token = '123:abcdefghijklmnopqrst';
  for (const fetchImpl of [async () => { throw new Error(`https://api.telegram.org/bot${token}/sendMessage`); },
    async () => ({ ok: false, status: 400, json: async () => ({ ok: false, description: token }) })]) {
    await assert.rejects(sendTelegram('message', { token, chatId: '1234', fetchImpl }), error =>
      ['TELEGRAM_UNCONFIRMED', 'TELEGRAM_REJECTED'].includes(error.code) && !error.message.includes(token));
  }
});

test('success observation covers sixty continuous seconds and rejects a health interruption', async () => {
  let clock = 0; let probes = 0; let recipes = 0;
  const options = { now: () => clock, sleep: async ms => { clock += ms; },
    probe: async () => { probes++; return health; }, smokeCheck: async () => { recipes++; } };
  const result = await observeDelivery('https://example.invalid', release, options);
  assert.ok(result.durationSeconds >= 60);
  assert.ok(probes >= 60);
  assert.equal(recipes, 2);
  clock = 0;
  await assert.rejects(observeDelivery('https://example.invalid', release, { ...options,
    probe: async () => clock >= 30000 ? { availability: 'degraded' } : health }), /stable/);
});

test('a Telegram timeout is uncertain, while a confirmed API refusal is retryable', async () => {
  const credentials = { token: '123:abcdefghijklmnopqrst', chatId: '1234' };
  await assert.rejects(sendTelegram('message', { ...credentials, fetchImpl: async () => { throw new Error('timeout'); } }), { code: 'TELEGRAM_UNCONFIRMED' });
  await assert.rejects(sendTelegram('message', { ...credentials, fetchImpl: async () => ({ ok: false, status: 429,
    json: async () => ({ ok: false }) }) }), { code: 'TELEGRAM_REJECTED' });
});

test('an interrupted send is retained as uncertain and is not automatically sent again after restart', () => {
  const now = Date.now();
  const cache = { enabledAt: now - 60000, sent: {}, inFlight: { '123:success:info': { startedAt: new Date(now - 1000).toISOString() } } };
  recoverNotificationAttempts(cache);
  assert.equal(cache.uncertain['123:success:info'].reason, 'interrupted_before_receipt');
  assert.deepEqual(cache.inFlight, {});
  assert.equal(notificationCandidates([run], { production: { ...release, success: true, verifiedAt: new Date(now).toISOString() } }, cache, now).length, 0);
});

test('accepted notifications are not resent on the same run and outcome, but severity changes are sent', async () => {
  const receipts = new Set(); const messages = [];
  const deliver = notification => deliverOnce(notification, {
    alreadySent: async key => receipts.has(key), send: async text => { messages.push(text); return { messageId: 17 }; },
    record: async key => receipts.add(key)
  });
  assert.equal(await deliver(event()), 'sent');
  assert.equal(await deliver(event()), 'duplicate');
  assert.equal(await deliver(event({ verification: 'failure' })), 'sent');
  assert.equal(messages.length, 2);
});

test('a refused notification is not recorded as delivered and remains retryable', async () => {
  let recorded = false;
  await assert.rejects(deliverOnce(event(), { alreadySent: async () => false,
    send: async () => { throw new Error('refused'); }, record: async () => { recorded = true; } }), /refused/);
  assert.equal(recorded, false);
});

test('a responding HTTP service with malformed health is degraded, not unreachable', async () => {
  for (const payload of [null, {}, { mode: 'degraded' }]) {
    const result = await inspectHealth('https://example.invalid', { fetchImpl: async () => ({ ok: true, json: async () => payload }) });
    assert.equal(result.availability, 'degraded');
  }
  assert.equal((await inspectHealth('https://example.invalid', { fetchImpl: async () => ({ ok: false }) })).availability, 'unavailable');
});

test('notification selection covers new local outcomes and failed CI without replaying history', () => {
  const now = Date.parse('2026-09-11T12:00:00Z');
  const cache = { enabledAt: now - 600000, sent: {} };
  const active = { ...release, success: true, verifiedAt: new Date(now - 1000).toISOString() };
  assert.equal(notificationCandidates([run], { production: active }, cache, now)[0].verification, 'success');
  assert.equal(notificationCandidates([run], { production: { ...active, verifiedAt: new Date(now - 700000).toISOString() } }, cache, now).length, 0);
  const failed = { ...run, conclusion: 'failure', status: 'completed', updated_at: new Date(now - 1000).toISOString() };
  assert.equal(notificationCandidates([failed], {}, cache, now)[0].verification, 'skipped');
  assert.equal(notificationCandidates([failed], {}, { ...cache, sent: { '123:failure:warning': {} } }, now).length, 0);
});

test('a locally failed deployment can notify recovery or a different severity, and a new CI supersedes old waits', () => {
  const now = Date.parse('2026-09-11T12:00:00Z');
  const cache = { enabledAt: now - 3600000, sent: { '123:failure:warning': {} } };
  const failed = { ...release, success: false, failedAt: new Date(now - 1000).toISOString() };
  assert.equal(notificationCandidates([run], { production: failed }, cache, now)[0].verification, 'failure');
  const overdue = { ...run, status: 'completed', updated_at: new Date(now - 1200000).toISOString() };
  assert.equal(notificationCandidates([overdue], {}, { ...cache, sent: {} }, now)[0].verification, 'failure');
  const newer = { ...run, id: 124, status: 'in_progress' };
  assert.equal(notificationCandidates([newer, overdue], {}, { ...cache, sent: {} }, now).length, 0);
});
