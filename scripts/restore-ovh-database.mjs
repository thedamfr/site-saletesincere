import { spawn, spawnSync } from 'node:child_process'

const cleverBinary = '/opt/homebrew/bin/clever'
const psqlBinary = '/opt/homebrew/opt/postgresql@15/bin/psql'
const sshHost = 'production@game-prod-ovh-gra.taild95457.ts.net'
const sshKnownHosts = process.env.OVH_SSH_KNOWN_HOSTS
  || '/private/tmp/salete-sincere-ovh-known-hosts'
const sshArgs = [
  '-o', 'BatchMode=yes',
  '-o', 'IdentitiesOnly=yes',
  '-o', 'StrictHostKeyChecking=yes',
  '-o', `UserKnownHostsFile=${sshKnownHosts}`,
  '-i', '/Users/thedamfr/.ssh/id_ed25519',
  sshHost
]

function environmentEntries(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const name = entry?.name || entry?.key
      if (!name || entry?.value === undefined) return []
      return [[name, String(entry.value)]]
    })
  }
  return value && typeof value === 'object'
    ? Object.entries(value).map(([name, entry]) => [
        name,
        String(entry?.value ?? entry)
      ])
    : []
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

const cleverResult = spawnSync(cleverBinary, [
  'env', '--alias', 'sale-wall', '--format', 'json'
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
if (cleverResult.status !== 0) {
  throw new Error('Impossible de lire la configuration Clever Cloud')
}

const cleverEnvironment = JSON.parse(cleverResult.stdout)
const values = new Map([
  ...environmentEntries(cleverEnvironment.env),
  ...(cleverEnvironment.fromAddons || []).flatMap((addon) =>
    environmentEntries(addon.env)
  )
])
const requiredNames = [
  'POSTGRESQL_ADDON_HOST',
  'POSTGRESQL_ADDON_PORT',
  'POSTGRESQL_ADDON_USER',
  'POSTGRESQL_ADDON_PASSWORD',
  'POSTGRESQL_ADDON_DB'
]
for (const name of requiredNames) {
  if (!values.get(name)) throw new Error(`Variable Clever manquante : ${name}`)
}

const sourceArgs = [
  '--no-psqlrc',
  '--set', 'ON_ERROR_STOP=1',
  '--quiet',
  '--tuples-only',
  '--no-align',
  '--host', values.get('POSTGRESQL_ADDON_HOST'),
  '--port', values.get('POSTGRESQL_ADDON_PORT'),
  '--username', values.get('POSTGRESQL_ADDON_USER'),
  '--dbname', values.get('POSTGRESQL_ADDON_DB')
]
const sourceEnvironment = {
  ...process.env,
  PGPASSWORD: values.get('POSTGRESQL_ADDON_PASSWORD')
}

function sourceQuery(sql) {
  const result = spawnSync(psqlBinary, [...sourceArgs, '--command', sql], {
    env: sourceEnvironment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.status !== 0) throw new Error('Échec de lecture PostgreSQL sur Clever Cloud')
  return result.stdout.trim()
}

function targetCommand(sql) {
  return [
    'microk8s kubectl exec -i',
    '--namespace site-saletesincere',
    'statefulset/site-saletesincere-postgres',
    '-- psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align',
    '--username salete --dbname salete',
    `--command ${shellQuote(sql)}`
  ].join(' ')
}

function targetQuery(sql) {
  const result = spawnSync('ssh', [...sshArgs, targetCommand(sql)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.status !== 0) throw new Error('Échec de lecture PostgreSQL sur OVH')
  return result.stdout.trim()
}

async function transferTable({ name, columns, sourceSelect }) {
  const source = spawn(psqlBinary, [
    ...sourceArgs,
    '--command', `\\copy (${sourceSelect}) TO STDOUT WITH (FORMAT csv)`
  ], {
    env: sourceEnvironment,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const targetCopy = `\\copy public.${name} (${columns.join(', ')}) FROM STDIN WITH (FORMAT csv)`
  const target = spawn('ssh', [...sshArgs, targetCommand(targetCopy)], {
    stdio: ['pipe', 'pipe', 'pipe']
  })

  source.stdout.pipe(target.stdin)
  const statuses = await Promise.all([
    new Promise((resolve, reject) => {
      source.once('error', reject)
      source.once('close', resolve)
    }),
    new Promise((resolve, reject) => {
      target.once('error', reject)
      target.once('close', resolve)
    })
  ])
  if (statuses.some((status) => status !== 0)) {
    throw new Error(`Échec du transfert de la table ${name}`)
  }
}

const sourceCounts = {
  episodeLinks: Number(sourceQuery('SELECT count(*) FROM public.episode_links')),
  op3Stats: Number(sourceQuery('SELECT count(*) FROM public.op3_stats'))
}
const targetRowsBefore = Number(targetQuery(`
  SELECT
    (SELECT count(*) FROM public.episode_links)
    + (SELECT count(*) FROM public.op3_stats)
`))
if (targetRowsBefore !== 0) {
  throw new Error('La base OVH cible contient déjà des données podcast')
}

await transferTable({
  name: 'episode_links',
  columns: [
    'id', 'season', 'episode', 'spotify_url', 'apple_url', 'deezer_url',
    'podcast_addict_url', 'resolved_at', 'created_at', 'og_image_url',
    'og_image_s3_key', 'feed_last_build', 'generated_at', 'youtube_url',
    'spotify_video_available', 'youtube_thumbnail_url',
    'youtube_thumbnail_checked'
  ],
  sourceSelect: `
    SELECT id, season, episode, spotify_url, apple_url, deezer_url,
      podcast_addict_url, resolved_at, created_at,
      NULL::text, NULL::text, feed_last_build, NULL::timestamptz, youtube_url,
      spotify_video_available, youtube_thumbnail_url,
      youtube_thumbnail_checked
    FROM public.episode_links
    ORDER BY id
  `
})

await transferTable({
  name: 'op3_stats',
  columns: [
    'item_guid', 'downloads_all', 'downloads_30', 'fetched_at', 'downloads_7'
  ],
  sourceSelect: `
    SELECT item_guid, downloads_all, downloads_30, fetched_at, downloads_7
    FROM public.op3_stats
    ORDER BY item_guid
  `
})

targetQuery(`
  SELECT setval(
    pg_get_serial_sequence('public.episode_links', 'id'),
    COALESCE(MAX(id), 1),
    MAX(id) IS NOT NULL
  )
  FROM public.episode_links
`)
const targetCounts = {
  episodeLinks: Number(targetQuery('SELECT count(*) FROM public.episode_links')),
  op3Stats: Number(targetQuery('SELECT count(*) FROM public.op3_stats'))
}
if (
  targetCounts.episodeLinks !== sourceCounts.episodeLinks
  || targetCounts.op3Stats !== sourceCounts.op3Stats
) {
  throw new Error('Le contrôle de volumétrie PostgreSQL a échoué')
}

console.log(JSON.stringify({
  transferred: targetCounts,
  excluded: ['posts', 'votes', 'pgboss', 'Cellar object references']
}))
