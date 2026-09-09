import { execFileSync, spawnSync } from 'node:child_process'

const cleverBinary = '/opt/homebrew/bin/clever'
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

const copiedVariables = [
  'BREVO_API_KEY',
  'BREVO_BASEURL',
  'BREVO_LIST_ID',
  'BREVO_TEMP_LIST_ID',
  'BREVO_FINAL_LIST_ID',
  'OP3_API_KEY',
  'OP3_API_TOKEN',
  'OP3_GUID',
  'OP3_NICK',
  'OP3_PUBLIC_STATS_ENABLED',
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
  'SPOTIFY_SHOW_ID',
  'YOUTUBE_API_KEY',
  'YOUTUBE_CHANNEL_URL',
  'YOUTUBE_UPLOADS_PLAYLIST_ID'
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

const cleverEnvironment = JSON.parse(execFileSync(cleverBinary, [
  'env', '--alias', 'sale-wall', '--format', 'json'
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
const allEntries = [
  ...environmentEntries(cleverEnvironment.env),
  ...(cleverEnvironment.fromAddons || []).flatMap((addon) =>
    environmentEntries(addon.env)
  )
]
const values = new Map(allEntries)
const selectedEntries = copiedVariables
  .filter((name) => values.has(name) && values.get(name) !== '')
  .map((name) => [name, values.get(name)])

for (const [name, value] of selectedEntries) {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(`La variable ${name} contient une nouvelle ligne non prise en charge`)
  }
}

const secretInput = selectedEntries
  .map(([name, value]) => `${name}=${value}`)
  .join('\n') + '\n'
const remoteCommand = [
  'microk8s kubectl create secret generic site-saletesincere-app',
  '--namespace site-saletesincere',
  '--from-env-file=/dev/stdin',
  '--dry-run=client -o yaml',
  '| microk8s kubectl apply -f -'
].join(' ')
const result = spawnSync('ssh', [...sshArgs, remoteCommand], {
  input: secretInput,
  encoding: 'utf8',
  stdio: ['pipe', 'inherit', 'inherit']
})

if (result.status !== 0) {
  throw new Error(`Échec de création du Secret applicatif (${result.status})`)
}

console.log(`Secret applicatif configuré avec ${selectedEntries.length} variables autorisées.`)
