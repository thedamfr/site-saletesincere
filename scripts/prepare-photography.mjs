import { execFileSync } from 'node:child_process'
import { accessSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// Original JPEGs stay outside Git. Regenerate the public derivatives explicitly.
const { values, positionals } = parseArgs({
  options: { 'forum-php': { type: 'boolean', default: false } },
  allowPositionals: true
})
const [sourceDirectory] = positionals
if (!sourceDirectory || positionals.length !== 1) {
  console.error('Usage: npm run prepare:photography -- /path/to/original-jpegs [--forum-php]')
  process.exit(1)
}

const outputDirectory = fileURLToPath(new URL('../public/images/photography/', import.meta.url))
const images = values['forum-php'] ? [
  ['DSC02973.jpg', 'forum-php-2026-conference', [480, 960, 1600]],
  ['DSC03026.jpg', 'forum-php-2026-intervenante', [480, 960]],
  ['DSC03055.jpg', 'forum-php-2026-rencontres', [480, 960]]
] : [
  ['DSC01949.jpg', 'dotjs-salon', [480, 960, 1600]],
  ['DSC01584.jpg', 'dot-participants', [480, 960]],
  ['DSC02019.jpg', 'dotjs-conference', [480, 960]],
  ['DSC01572.jpg', 'dot-salon-plongee', [480, 960]],
  ['DSC01975.jpg', 'dot-rencontre', [480, 960]],
  ['DSC02104.jpg', 'dotjs-portrait', [480, 960]],
  ['DSC01134.jpg', 'hodefi-laureat', [480, 960]],
  ['DSC01124.jpg', 'hodefi-salle', [480, 960]],
  ['DSC01240.jpg', 'hodefi-table-ronde', [480, 960]],
  ['0T9A2568.jpg', 'masters-food-truck-travail', [480, 960]],
  ['0T9A2573.jpg', 'masters-food-truck-rencontre', [480, 960]],
  ['0T9A2869.jpg', 'masters-prise-de-parole', [480, 960]]
]
const socialImage = values['forum-php']
  ? ['DSC02973.jpg', 'forum-php-2026-social.jpg']
  : ['DSC01949.jpg', 'photographie-social.jpg']
// The Forum PHP originals are already sRGB, so no embedded profile is required.
const socialFilter = values['forum-php']
  ? 'scale=1200:-1,sidedata=mode=delete:type=ICC_PROFILE'
  : 'scale=1200:-1'

// Check the complete selection before writing or replacing any derivative.
for (const [file] of images) accessSync(path.resolve(sourceDirectory, file))
mkdirSync(outputDirectory, { recursive: true })

for (const [file, name, widths] of images) {
  for (const width of widths) {
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-threads', '1', '-filter_threads', '1',
      '-i', path.resolve(sourceDirectory, file), '-map_metadata', '-1',
      '-vf', `scale=${width}:-1`, '-frames:v', '1',
      '-c:v', 'libwebp', '-quality', '82', '-threads', '1',
      path.join(outputDirectory, `${name}-${width}.webp`)
    ], { stdio: 'inherit' })
  }
}

// A conventional JPEG for social crawlers, retaining the full composition.
execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y', '-threads', '1', '-filter_threads', '1',
  '-i', path.resolve(sourceDirectory, socialImage[0]), '-map_metadata', '-1',
  '-vf', socialFilter, '-frames:v', '1', '-q:v', '3', '-threads', '1',
  path.join(outputDirectory, socialImage[1])
], { stdio: 'inherit' })
console.log(`Prepared ${images.length} photographs and one social image.`)
