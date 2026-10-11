import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import pg from 'pg';

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function applicationSignalCommand(pod, signal) {
  assert.ok(['SIGKILL', 'SIGTERM'].includes(signal));
  assert.equal(pod?.metadata?.namespace, 'site-issue56');
  assert.equal(pod.metadata.labels?.app, 'site-issue56-web');
  assert.ok(pod.metadata.name && pod.metadata.uid, 'Owned application pod required');
  const container = pod.status?.containerStatuses?.find(item => item.name === 'web');
  assert.match(container?.containerID || '', /^containerd:\/\/[a-f0-9]{64}$/);
  const id = container.containerID.slice('containerd://'.length);
  return `sudo -n k3s ctr -n k8s.io tasks kill --signal ${signal} ${id}`;
}

export async function waitForApplicationReplacement({ before, currentPod, waitFor, timeoutMs,
  expectedExitCode, requireExitCode = true }) {
  const original = before.status.containerStatuses.find(item => item.name === 'web');
  assert.match(original?.containerID || '', /^containerd:\/\/[a-f0-9]{64}$/);
  let termination = null, replacement;
  const capture = value => {
    if (value?.exitCode === undefined) return;
    assert.equal(value.exitCode, expectedExitCode, 'application termination contradicts the requested signal');
    termination = { ...value };
  };
  await waitFor(async () => {
    const next = await currentPod();
    if (!next) return false;
    try {
      assert.equal(next.metadata.name, before.metadata.name, 'replacement must belong to the same pod');
      assert.equal(next.metadata.uid, before.metadata.uid, 'replacement must retain the same pod UID');
      const container = next.status?.containerStatuses?.find(item => item.name === 'web');
      if (!container) return false;
      // Preserve the original process termination even before its replacement
      // exists: Kubelet may discard lastState while health is recovering.
      if (container.containerID === original.containerID) capture(container.state?.terminated);
      const replaced = /^containerd:\/\/[a-f0-9]{64}$/.test(container.containerID || '')
        && container.containerID !== original.containerID && container.restartCount > original.restartCount;
      if (!replaced) return false;
      capture(container.lastState?.terminated);
      if (requireExitCode) assert.ok(termination, 'actual application exit code must be observed');
      replacement = { containerId: container.containerID.slice('containerd://'.length),
        exitCode: termination?.exitCode ?? null, termination };
      return true;
    } catch (error) { error.qualificationFatal = true; throw error; }
  }, 'new application process', timeoutMs);
  return replacement;
}

export async function prepareQualificationDatabase({
  adminOptions, databaseName, verifyGuest, createClient = options => new pg.Client(options)
}) {
  assert.equal(adminOptions.host, '127.0.0.1');
  assert.equal(adminOptions.port, 25456);
  assert.equal(adminOptions.database, 'site_qualification');
  if (databaseName === undefined) return { options: { ...adminOptions }, created: false };
  assert.match(databaseName, /^site_qualification_[a-z0-9]{1,24}$/, 'Invalid qualification database name');
  // The driver verifies the private marker, QEMU UUID/disk/owner and guest SSH
  // identity before returning this status. No database is touched beforehand.
  const status = await verifyGuest();
  assert.equal(status.running, true, 'Qualification guest must be running');
  assert.equal(status.hostname, 'site-issue56');
  assert.match(status.bootId, /^[a-f0-9-]{36}$/);
  const admin = createClient({ ...adminOptions, connectionTimeoutMillis: 3000, query_timeout: 5000 });
  let created = false;
  try {
    await admin.connect();
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    if (!exists.rowCount) {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      created = true;
    }
  } finally { await admin.end(); }
  return { options: { ...adminOptions, database: databaseName }, created };
}

export async function createHarness({ stateDir, outputDir, databaseName = process.env.RESILIENCE_DATABASE }) {
  const state = resolve(stateDir);
  assert.equal((await stat(state)).mode & 0o077, 0, 'Private qualification state required');
  const identity = JSON.parse(await readFile(`${state}/identity.json`, 'utf8'));
  assert.equal(identity.kind, 'site-issue56-qualification');
  assert.equal(identity.hostname, 'site-issue56');
  assert.equal(identity.sshPort, 22856);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const results = [];
  const events = [];
  const children = [];
  const lockedClients = new Set();
  const adminOptions = JSON.parse(await readFile(`${state}/postgres-options.json`, 'utf8'));
  let pool;
  const sshArgs = ['-p', String(identity.sshPort), '-i', `${state}/ssh-key`, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${state}/known_hosts`, 'ubuntu@127.0.0.1'];

  const run = (command, args, { input, timeout = 60_000, allowFailure = false } = {}) => new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let timedOut = false, settled = false, killTimer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (error) reject(error); else resolveRun(value);
    };
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error(`Qualification command timed out: ${command}, budget=${timeout}ms`));
      }, 2000);
    }, timeout);
    child.once('error', error => finish(error));
    // A remote process can close its input before SSH has exited.
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') finish(error); });
    child.once('close', code => {
      if (timedOut) finish(new Error(`Qualification command timed out: ${command}, budget=${timeout}ms`));
      else if (code !== 0 && !allowFailure) finish(new Error(`Qualification command failed: ${command}, exit=${code}; ${stderr.slice(-500)}`));
      else finish(null, { stdout, code });
    });
    child.stdin.end(input);
  });
  const guest = (command, options) => run('ssh', [...sshArgs, command], options);
  const kubectl = async (args, options) => guest(`sudo -n k3s kubectl -n site-issue56 ${args.map(quote).join(' ')}`, options);
  const sql = (text, values) => pool.query(text, values);
  const holdLock = async key => {
    const client = await pool.connect();
    lockedClients.add(client);
    try { await client.query('SELECT pg_advisory_lock($1)', [key]); }
    catch (error) { lockedClients.delete(client); client.release(true); throw error; }
    return async () => {
      if (!lockedClients.delete(client)) return;
      try { await client.query('SELECT pg_advisory_unlock($1)', [key]); }
      finally { client.release(true); }
    };
  };
  const waitFor = async (predicate, label, timeoutMs = 300_000) => {
    const started = performance.now();
    let lastError;
    while (performance.now() - started < timeoutMs) {
      try {
        const value = await predicate();
        if (value && performance.now() - started <= timeoutMs) return value;
      } catch (error) {
        if (error.qualificationFatal) throw error;
        lastError = error;
      }
      const remaining = timeoutMs - (performance.now() - started);
      if (remaining <= 0) break;
      await new Promise(resolveWait => setTimeout(resolveWait, Math.min(500, remaining)));
    }
    throw new Error(`${label} exceeded ${timeoutMs}ms${lastError ? ` (${lastError.code || lastError.name})` : ''}`);
  };
  const request = (path, options = {}) => fetch(`http://127.0.0.1:31856${path}`, {
    ...options, signal: options.signal || AbortSignal.timeout(15_000)
  });
  const health = async requireNormal => {
    const response = await request('/health');
    const value = await response.json();
    const normal = value.mode === 'normal' && value.database?.state === 'read_write'
      && value.episodeWorker?.state === 'ready';
    return response.ok && value.ok === true && (!requireNormal || normal) ? value : false;
  };
  const pods = async () => JSON.parse((await kubectl(['get', 'pods', '-l', 'app=site-issue56-web', '-o', 'json'])).stdout).items;
  const currentPod = async () => (await pods()).find(pod => !pod.metadata.deletionTimestamp);
  const enqueue = async (name, data = {}) => {
    assert.ok(['resolve-episode', 'op3-stats-refresh'].includes(name));
    const pod = await currentPod();
    const script = `import PgBoss from 'pg-boss';
      const boss = new PgBoss({ connectionString: process.env.DATABASE_URL, supervise: false, schedule: false });
      await boss.start();
      try { console.log(await boss.send(${JSON.stringify(name)}, ${JSON.stringify(data)},
        { expireInSeconds: 60, retryLimit: 3, retryDelay: 5, retryBackoff: false })); }
      finally { await boss.stop(); }`;
    const result = await kubectl(['exec', pod.metadata.name, '--', 'node', '--input-type=module', '-e', script]);
    const id = result.stdout.trim();
    assert.match(id, /^[a-f0-9-]{36}$/);
    return id;
  };
  const restartApp = async ({ requireNormal = true, signal = 'SIGKILL' } = {}) => {
    assert.ok(['SIGKILL', 'SIGTERM'].includes(signal));
    const status = await driverStatus();
    assert.equal(status.running, true);
    assert.equal(status.hostname, 'site-issue56');
    const before = await currentPod();
    const command = applicationSignalCommand(before, signal);
    const started = performance.now();
    const remaining = () => Math.max(1, 300_000 - (performance.now() - started));
    // Namespace init ignores SIGKILL sent by another process inside that same
    // PID namespace. Containerd sends from the verified guest ancestor namespace.
    await guest(command);
    const replacement = await waitForApplicationReplacement({ before, currentPod, waitFor,
      timeoutMs: remaining(), expectedExitCode: signal === 'SIGTERM' ? 0 : 137 });
    await waitFor(() => health(false), 'HTTP after application crash', remaining());
    const httpMs = Math.round(performance.now() - started);
    let workerMs = null;
    if (requireNormal) {
      await waitFor(() => health(true), 'worker after application crash', remaining());
      workerMs = Math.round(performance.now() - started);
    }
    assert.ok((workerMs ?? httpMs) <= 300_000);
    events.push({ operation: `${signal} application`, httpMs, workerMs, exitCode: replacement.exitCode,
      replacementContainerId: replacement.containerId, termination: replacement.termination, at: new Date().toISOString() });
    return { httpMs, workerMs, startedAt: started };
  };
  const freshProcess = async () => {
    const before = await currentPod();
    assert.ok(before?.metadata.uid, 'Owned application pod required');
    const started = performance.now();
    await kubectl(['rollout', 'restart', 'deployment/web']);
    await waitFor(async () => {
      const next = await currentPod();
      return next?.metadata.uid && next.metadata.uid !== before.metadata.uid;
    }, 'fresh application pod before independent scenario');
    await waitFor(() => health(true), 'fresh application ready before independent scenario',
      Math.max(1, 300_000 - (performance.now() - started)));
    const durationMs = Math.round(performance.now() - started);
    assert.ok(durationMs <= 300_000);
    events.push({ operation: 'scenario precondition: fresh application pod', durationMs, at: new Date().toISOString() });
  };
  const withReadOnlyDatabase = async callback => {
    let restoredAt;
    await sql('ALTER ROLE site_issue56_app SET default_transaction_read_only = on');
    try { await restartApp({ requireNormal: false }); await callback(); }
    finally {
      await sql('ALTER ROLE site_issue56_app RESET default_transaction_read_only');
      restoredAt = performance.now();
      await restartApp();
    }
    return restoredAt;
  };
  const scenario = async (name, callback) => {
    console.log(`Golden Journey — ${name}`);
    const startedAt = new Date().toISOString();
    const started = performance.now();
    try {
      await callback();
      results.push({ name, startedAt, durationMs: Math.round(performance.now() - started), result: 'passed' });
      console.log(`  OK (${results.at(-1).durationMs} ms)`);
    } catch (error) {
      results.push({ name, startedAt, durationMs: Math.round(performance.now() - started), result: 'failed', error: error.message });
      throw error;
    } finally {
      await writeFile(`${outputDir}/results.json`, JSON.stringify({ results, events }, null, 2), { mode: 0o600 });
    }
  };
  const startOwned = (action) => {
    const child = spawn('python3', ['scripts/qualification/recovery-vm.py', action, '--state', state], { stdio: ['ignore', 'pipe', 'pipe'] });
    const owned = { action, child, error: null };
    children.push(owned);
    child.on('error', error => { owned.error = error; });
    // Drain streams without ever publishing SSH diagnostics or private state.
    child.stdout.resume(); child.stderr.resume();
    return owned;
  };
  const assertOwnedRunning = ({ action, child, error }) => {
    if (error || child.exitCode !== null || child.signalCode !== null) {
      const failure = new Error(`Owned qualification ${action} stopped before readiness (${error?.code || child.exitCode || child.signalCode})`);
      failure.qualificationFatal = true;
      throw failure;
    }
  };
  const driverStatus = async () => JSON.parse((await run('python3',
    ['scripts/qualification/recovery-vm.py', 'status', '--state', state], { timeout: 20_000 })).stdout);
  const boundarySpec = async condition => {
    const pod = await currentPod();
    applicationSignalCommand(pod, "SIGKILL");
    const container = pod.status.containerStatuses.find(item => item.name === "web");
    const image = pod.spec.containers.find(item => item.name === "web").image;
    assert.match(image, /^docker\.io\/library\/site-issue56@sha256:[a-f0-9]{64}$/);
    return { containerId: container.containerID.slice("containerd://".length),
      podName: pod.metadata.name, imageDigest: image.split("@")[1],
      dbOptions: Object.fromEntries(["host", "port", "database", "user", "password"].map(key => [key, options[key]])), condition };
  };
  const cycleVM = async (action, condition) => {
    assert.ok(['shutdown', 'crash'].includes(action));
    const status = await driverStatus();
    assert.equal(status.running, true);
    assert.equal(status.hostname, 'site-issue56');
    assert.match(status.bootId, /^[a-f0-9-]{36}$/);
    const started = performance.now();
    const specification = condition ? await boundarySpec(condition) : undefined;
    await run('python3', ['scripts/qualification/recovery-vm.py', condition ? 'crash-when' : action, '--state', state],
      { input: specification ? JSON.stringify(specification) : undefined, timeout: condition ? 205_000 : 60_000 });
    await waitFor(async () => {
      const next = await driverStatus();
      return next.running === false;
    }, 'guest stopped', 60_000);
    const faultInjectionMs = Math.round(performance.now() - started);
    const bootStarted = performance.now();
    const guestProcess = startOwned('start');
    await waitFor(async () => {
      assertOwnedRunning(guestProcess);
      const response = await guest('hostname; cat /proc/sys/kernel/random/boot_id', { timeout: 10_000 });
      const lines = response.stdout.trim().split('\n');
      return lines.length === 2 && lines[0] === 'site-issue56'
        && /^[a-f0-9-]{36}$/.test(lines[1]) && lines[1] !== status.bootId;
    }, 'new guest boot');
    const bootMs = Math.round(performance.now() - bootStarted);
    // Previous SSH transport ended with the guest. Reconnect only the owned tunnel.
    const tunnel = startOwned('tunnel');
    await waitFor(async () => {
      assertOwnedRunning(guestProcess);
      assertOwnedRunning(tunnel);
      return (await sql('SELECT 1')).rowCount === 1;
    }, 'PostgreSQL returned');
    const dependenciesAt = performance.now();
    const dependenciesMs = Math.round(dependenciesAt - bootStarted);
    await waitFor(() => health(false), 'HTTP after dependencies returned');
    const httpMs = Math.round(performance.now() - dependenciesAt);
    await waitFor(() => health(true), 'worker ready after dependencies returned', Math.max(1, 300_000 - httpMs));
    const recoveryMs = Math.round(performance.now() - dependenciesAt);
    assert.ok(recoveryMs <= 300_000);
    events.push({ operation: action, previousBootId: status.bootId, faultInjectionMs, bootMs, dependenciesMs, httpMs, recoveryMs, at: new Date().toISOString() });
    return { faultInjectionMs, bootMs, dependenciesMs, httpMs, recoveryMs, dependenciesAt };
  };
  const apply = objects => kubectl(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects }) });
  const { options, created } = await prepareQualificationDatabase({ adminOptions, databaseName, verifyGuest: driverStatus });
  pool = new pg.Pool({ ...options, max: 3, connectionTimeoutMillis: 3000, query_timeout: 5000 });
  pool.on('error', () => {});
  events.push({ operation: 'qualification database selected', database: options.database, created, at: new Date().toISOString() });
  return {
    state, options, results, events, run, guest, kubectl, sql, holdLock, waitFor, request, health, currentPod,
    restartApp, freshProcess, cycleVM, boundarySpec, withReadOnlyDatabase, scenario, apply, enqueue,
    async close() {
      for (const client of lockedClients) client.release(true);
      lockedClients.clear();
      await pool.end();
      try {
        if (children.some(({ action, child }) => action === 'start' && child.exitCode === null && child.signalCode === null)) {
          await run('python3', ['scripts/qualification/recovery-vm.py', 'shutdown', '--state', state]);
          await waitFor(async () => (await driverStatus()).running === false, 'graceful qualification cleanup', 60_000);
        }
      } finally {
        for (const { action, child } of children) {
          // QEMU is stopped only through the identity-checking driver. A failed
          // shutdown must stay inspectable instead of becoming an implicit crash.
          if (action === 'tunnel' && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
          child.stdout.unref?.(); child.stderr.unref?.(); child.unref();
        }
      }
    }
  };
}
