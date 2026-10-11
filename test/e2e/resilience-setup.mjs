import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { qualificationEntrypoint } from './resilience-fixture.mjs';

export async function setupApplication(h, candidate) {
  assert.match(candidate.image, /^docker\.io\/library\/site-issue56@sha256:[a-f0-9]{64}$/);
  await h.guest('mkdir -p /home/ubuntu/qualification && cat > /home/ubuntu/qualification/observe-boundary.py && chmod 700 /home/ubuntu/qualification/observe-boundary.py',
    { input: await readFile('scripts/qualification/observe-boundary.py', 'utf8') });
  const namespace = 'site-issue56';
  const metadata = name => ({ name, namespace });
  let application;
  try { application = JSON.parse(await readFile(`${h.state}/application-options.json`, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    application = { ...h.options, user: 'site_issue56_app', password: randomBytes(24).toString('hex') };
    await writeFile(`${h.state}/application-options.json`, JSON.stringify(application), { mode: 0o600 });
  }
  assert.equal(application.user, 'site_issue56_app');
  assert.match(application.password, /^[a-f0-9]{48}$/);
  const exists = await h.sql("SELECT 1 FROM pg_roles WHERE rolname = 'site_issue56_app'");
  if (!exists.rowCount) await h.sql(`CREATE ROLE site_issue56_app LOGIN PASSWORD '${application.password}'`);
  assert.match(h.options.database, /^[a-zA-Z0-9_]+$/);
  await h.sql(`GRANT CONNECT, CREATE ON DATABASE "${h.options.database}" TO site_issue56_app`);
  // Saved application credentials are shared; the active database is selected
  // by this campaign without rewriting either private options file.
  const url = options => `postgresql://${encodeURIComponent(options.user)}:${encodeURIComponent(options.password)}@postgres:5432/${encodeURIComponent(h.options.database)}`;
  await h.apply([
    { apiVersion: 'v1', kind: 'Secret', metadata: metadata('qualification-database'), stringData: { DATABASE_URL: url(application) } },
    { apiVersion: 'v1', kind: 'Secret', metadata: metadata('qualification-migration'), stringData: { DATABASE_URL: url(h.options) } }
  ]);
  const migrationName = `migrate-${Date.now().toString(36)}`;
  await h.apply([{ apiVersion: 'batch/v1', kind: 'Job', metadata: metadata(migrationName), spec: {
    backoffLimit: 0, activeDeadlineSeconds: 180,
    template: { spec: { restartPolicy: 'Never', automountServiceAccountToken: false,
      containers: [{ name: 'migrate', image: candidate.image, imagePullPolicy: 'Never',
        command: ['sh', '-c', 'npm run migrate && npm run migrate'],
        envFrom: [{ secretRef: { name: 'qualification-migration' } }],
        resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '512Mi' } },
        securityContext: { runAsNonRoot: true, runAsUser: 1000, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } }
      }] }
    }
  } }]);
  await h.kubectl(['wait', '--for=condition=complete', `job/${migrationName}`, '--timeout=180s'], { timeout: 190_000 });
  const migrationLogs = await h.kubectl(['logs', `job/${migrationName}`]);
  await writeFile(`${h.state}/migration.log`, migrationLogs.stdout, { mode: 0o600 });
  await h.sql('GRANT USAGE ON SCHEMA public TO site_issue56_app');
  await h.sql('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO site_issue56_app');
  await h.sql('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO site_issue56_app');
  const env = {
    NODE_ENV: 'production', PORT: '3000', DISABLE_STORAGE: 'true', DISABLE_WALL: 'true',
    QUALIFICATION_KIND: 'site-issue56', RELEASE_DIGEST: candidate.image.split('@')[1],
    BREVO_BASEURL: 'https://brevo.invalid/v3', BREVO_API_KEY: 'synthetic-only', BREVO_TEMP_LIST_ID: '101', BREVO_FINAL_LIST_ID: '102',
    SPOTIFY_CLIENT_ID: 'synthetic', SPOTIFY_CLIENT_SECRET: 'synthetic', SPOTIFY_SHOW_ID: 'synthetic',
    APPLE_PODCAST_ID: '12345', DEEZER_SHOW_ID: '12345', OP3_API_TOKEN: 'synthetic', OP3_GUID: 'qualification-show', OP3_PUBLIC_STATS_ENABLED: 'true'
  };
  await h.apply([
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: metadata('qualification-entrypoint'), data: { 'app.mjs': qualificationEntrypoint } },
    { apiVersion: 'v1', kind: 'Service', metadata: metadata('web'), spec: { type: 'NodePort', selector: { app: 'site-issue56-web' }, ports: [{ port: 3000, targetPort: 3000, nodePort: 30080 }] } },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: metadata('web'), spec: {
      replicas: 1, strategy: { type: 'Recreate' }, selector: { matchLabels: { app: 'site-issue56-web' } },
      template: { metadata: { labels: { app: 'site-issue56-web' }, annotations: {
        'qualification/entrypoint': createHash('sha256').update(qualificationEntrypoint).digest('hex'),
        'qualification/database': h.options.database
      } }, spec: {
        automountServiceAccountToken: false, enableServiceLinks: false, terminationGracePeriodSeconds: 30,
        containers: [{ name: 'web', image: candidate.image, imagePullPolicy: 'Never',
          command: ['node', '/qualification/app.mjs'],
          env: Object.entries(env).map(([name, value]) => ({ name, value })),
          envFrom: [{ secretRef: { name: 'qualification-database' } }],
          ports: [{ name: 'http', containerPort: 3000 }],
          readinessProbe: { httpGet: { path: '/health', port: 3000 }, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 3 },
          livenessProbe: { httpGet: { path: '/health', port: 3000 }, periodSeconds: 15, timeoutSeconds: 3, failureThreshold: 4 },
          startupProbe: { httpGet: { path: '/health', port: 3000 }, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 30 },
          resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '500m', memory: '512Mi' } },
          securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, readOnlyRootFilesystem: true,
            allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } },
          volumeMounts: [{ name: 'entrypoint', mountPath: '/qualification', readOnly: true }, { name: 'tmp', mountPath: '/tmp' }]
        }],
        volumes: [{ name: 'entrypoint', configMap: { name: 'qualification-entrypoint' } }, { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '256Mi' } }],
        securityContext: { fsGroup: 1000 }
      } }
    } }
  ]);
  // A normal response from the old pod does not prove that the selected
  // database/Secret has reached the new process yet.
  await h.waitFor(async () => {
    const pod = await h.currentPod();
    return pod?.metadata.annotations?.['qualification/database'] === h.options.database
      && pod.spec.containers[0].image === candidate.image;
  }, 'candidate pod with selected database', 300_000);
  await h.waitFor(() => h.health(true), 'initial usable candidate', 300_000);
  const health = await h.health(true);
  assert.equal(health.release.digest, candidate.image.split('@')[1]);
  const pod = await h.currentPod();
  assert.ok(pod.status.containerStatuses[0].imageID.includes(candidate.image.split('@')[1]), 'Running container must match candidate digest');
  // Prove that the app role cannot assume the bootstrap administrator role.
  const privileges = await h.sql("SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = 'site_issue56_app'");
  assert.deepEqual(privileges.rows[0], { rolsuper: false, rolcreatedb: false, rolcreaterole: false });
}
