import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { waitForApplicationReplacement } from './resilience-harness.mjs';

// Prearm a pidfd in the guest ancestor namespace, before opening the fault
// window. The SQL observer keeps real application timeouts and job deadlines.
export async function crashOnBoundary(h, condition, openWindow = async () => {}, verifyBoundary = async () => {}) {
  const specification = await h.boundarySpec(condition);
  const pod = await h.currentPod();
  assert.equal(pod.metadata.name, specification.podName);
  assert.equal(pod.status.containerStatuses.find(item => item.name === 'web').containerID,
    `containerd://${specification.containerId}`);
  const since = performance.now();
  const remaining = () => Math.max(1, 300_000 - (performance.now() - since));
  let watcherError;
  let completedConfirmation;
  let windowOpened = false;
  const watcher = h.guest('sudo -n python3 /home/ubuntu/qualification/observe-boundary.py --mode app',
    { input: JSON.stringify(specification), timeout: condition.kind === 'job-active' ? 205_000 : 75_000 }).then(observed => {
      const confirmations = observed.stdout.trim().split('\n').map(line => JSON.parse(line))
        .filter(item => item.conditionConfirmed === true);
      assert.equal(confirmations.length, 1, 'observer must confirm the exact boundary once');
      const confirmation = confirmations[0];
      assert.equal(confirmation.containerId, specification.containerId);
      assert.equal(confirmation.podName, specification.podName);
      assert.equal(confirmation.imageDigest, specification.imageDigest);
      assert.equal(confirmation.processExited, true, 'observer must prove kernel process exit');
      assert.equal(confirmation.signal, 'SIGKILL', 'observer must prove the requested signal');
      assert.ok(condition.kind !== 'sql-lock' || windowOpened,
        'SQL lock observed before fault window opened');
      completedConfirmation = confirmation;
      return observed;
    }).catch(error => {
      watcherError = error;
      error.qualificationFatal = true;
      return null;
    });
  await h.waitFor(async () => {
    if (watcherError) throw watcherError;
    // A successful observer can already have killed the process and disconnected.
    if (completedConfirmation) return true;
    const armed = (await h.sql("SELECT 1 FROM pg_stat_activity WHERE application_name='qualification-boundary-observer'")).rowCount > 0;
    if (watcherError) throw watcherError;
    return Boolean(completedConfirmation) || armed;
  }, 'crash observer armed', 60_000);
  windowOpened = true;
  await openWindow();
  await watcher;
  if (watcherError) throw watcherError;
  assert.ok(completedConfirmation, 'observer must confirm the exact boundary');
  await verifyBoundary();
  const replacement = await waitForApplicationReplacement({ before: pod, currentPod: h.currentPod, waitFor: h.waitFor,
    timeoutMs: remaining(), expectedExitCode: 137, requireExitCode: false });
  await h.waitFor(() => h.health(true), 'worker after observed boundary crash', remaining());
  h.events.push({ operation: 'SIGKILL at observed boundary', condition, recoveryMs: Math.round(performance.now() - since),
    exitCode: replacement.exitCode, termination: replacement.termination, replacementContainerId: replacement.containerId,
    processExited: completedConfirmation.processExited, signal: completedConfirmation.signal,
    terminationSource: replacement.exitCode === null ? 'kernel-pidfd' : 'kernel-pidfd+kubernetes',
    at: new Date().toISOString(), timing: 'includes conservative observer arm time' });
  return since;
}

export const crashOnLock = (h, key, openWindow, verifyBoundary) =>
  crashOnBoundary(h, { kind: 'sql-lock', key }, openWindow, verifyBoundary);

export async function exerciseBeforeAcceptance(h, f) {
  await h.freshProcess();
  await h.scenario('Crash avant commit du journal : aucun acquittement ni effet, nouvelle soumission sûre', async () => {
    const email = `before-commit-${Date.now()}@example.test`;
    const key = 560092;
    const before = await f.snapshot();
    const release = await h.holdLock(key);
    let pending, since;
    const submit = () => h.request('/newsletter/subscribe', { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email }).toString() });
    try {
      await h.sql(`CREATE OR REPLACE FUNCTION qualification_hold_registration() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.email = '${email}' THEN PERFORM pg_advisory_xact_lock(${key}); END IF; RETURN NEW; END $$`);
      await h.sql('CREATE TRIGGER qualification_hold_registration BEFORE INSERT ON newsletter_requests FOR EACH ROW EXECUTE FUNCTION qualification_hold_registration()');
      since = await crashOnLock(h, key, async () => { pending = submit().catch(() => null); }, async () => {
        const response = await pending;
        assert.ok(response === null || response.status === 503, 'uncommitted request must never be acknowledged');
        assert.equal((await h.sql('SELECT 1 FROM newsletter_requests WHERE email=$1', [email])).rowCount, 0);
        assert.equal((await f.snapshot()).mutationsAttempted, before.mutationsAttempted);
      });
    } finally {
      await release();
      await h.sql('DROP TRIGGER IF EXISTS qualification_hold_registration ON newsletter_requests');
      await h.sql('DROP FUNCTION IF EXISTS qualification_hold_registration()');
    }
    const response = await submit();
    assert.equal(response.status, 200);
    assert.equal((await f.snapshot()).effects, before.effects + 1);
    assert.equal((await f.snapshot()).mutationsAttempted, before.mutationsAttempted + 1);
    assert.ok(performance.now() - since <= 300_000);
    h.events.push({ operation: "before acceptance: safe resubmission", elapsedMs: Math.round(performance.now() - since) });
  });
}
