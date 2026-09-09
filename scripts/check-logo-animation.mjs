import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = path.join(root, 'public/images/logo-noname-web.svg')
const outputDirectory = path.join(os.tmpdir(), 'salete-logo-animation-frames')
const durationSeconds = 3.6
const frameProgress = [0, 0.2, 0.36, 0.4, 0.44, 0.52, 0.64, 0.8, 0.96, 1]
const segments = [
  { id: 'logo-gesture-upper', start: 0, end: 0.4, length: 446 },
  { id: 'logo-gesture-loop', start: 0.38, end: 0.64, length: 356 },
  { id: 'logo-gesture-return', start: 0.62, end: 0.96, length: 403 }
]
const supportingTraces = [
  { selector: '.logo-trace-upper-fill', start: 0, end: 0.28, length: 342 },
  { selector: '.logo-trace-upper-mid', start: 0, end: 0.34, length: 361 }
]

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value))
}

function getSegmentProgress(value, segment) {
  return clamp((value - segment.start) / (segment.end - segment.start))
}

function getFrameStyles(progress) {
  const segmentRules = segments.map((segment) => {
    const segmentProgress = getSegmentProgress(progress, segment)
    const offset = segment.length * (1 - segmentProgress)
    return `#${segment.id} { stroke-dashoffset: ${offset.toFixed(3)} !important; }`
  }).join('\n')
  const finishOpacity = clamp((progress - 0.96) / 0.04)
  const dotProgress = clamp((progress - 0.92) / 0.08)
  const supportingRules = supportingTraces.map((trace) => (
    `${trace.selector} { stroke-dashoffset: ${(trace.length * (1 - getSegmentProgress(progress, trace))).toFixed(3)} !important; }`
  )).join('\n')

  return `<style>
    .logo-trace, .logo-dot, .logo-reveal-finish { animation: none !important; }
    ${segmentRules}
    ${supportingRules}
    .logo-reveal-finish { opacity: ${finishOpacity.toFixed(3)} !important; }
    .logo-dot {
      opacity: ${dotProgress.toFixed(3)} !important;
      transform: translate(${(-12 * (1 - dotProgress)).toFixed(3)}px, ${(10 * (1 - dotProgress)).toFixed(3)}px) scale(${(0.35 + (0.65 * dotProgress)).toFixed(3)}) !important;
    }
  </style>`
}

function renderSvg(inputPath, outputPath) {
  execFileSync('rsvg-convert', [
    '--width', '997',
    '--height', '827',
    '--background-color', '#fff',
    '--output', outputPath,
    inputPath
  ])
}

await mkdir(outputDirectory, { recursive: true })
const source = await readFile(sourcePath, 'utf8')
const framePaths = []

for (const progress of frameProgress) {
  const label = String(Math.round(progress * 100)).padStart(3, '0')
  const frameSvgPath = path.join(outputDirectory, `frame-${label}.svg`)
  const framePngPath = path.join(outputDirectory, `frame-${label}.png`)
  const frameSvg = source.replace('</svg>', `${getFrameStyles(progress)}</svg>`)

  await writeFile(frameSvgPath, frameSvg)
  renderSvg(frameSvgPath, framePngPath)
  framePaths.push(framePngPath)
}

const referenceSvgPath = path.join(outputDirectory, 'reference.svg')
const referencePngPath = path.join(outputDirectory, 'reference.png')
const referenceSvg = source.replace(' class="logo-symbol" mask="url(#logo-reveal)"', ' class="logo-symbol"')
await writeFile(referenceSvgPath, referenceSvg)
renderSvg(referenceSvgPath, referencePngPath)

let comparisonOutput = ''
try {
  comparisonOutput = execFileSync('compare', [
    '-metric', 'AE',
    referencePngPath,
    framePaths.at(-1),
    'null:'
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
} catch (error) {
  comparisonOutput = `${error.stdout || ''}${error.stderr || ''}`
}

const pixelDifference = Number.parseInt(comparisonOutput.trim().split(/\s+/)[0] || '0', 10)
if (!Number.isFinite(pixelDifference) || pixelDifference !== 0) {
  throw new Error(`Final logo differs from its source by ${comparisonOutput.trim()} pixels`)
}

const contactSheetPath = path.join(outputDirectory, 'contact-sheet.png')
const firstRowPath = path.join(outputDirectory, 'row-1.png')
const secondRowPath = path.join(outputDirectory, 'row-2.png')
execFileSync('magick', [...framePaths.slice(0, 5), '+append', firstRowPath])
execFileSync('magick', [...framePaths.slice(5), '+append', secondRowPath])
execFileSync('magick', [firstRowPath, secondRowPath, '-append', contactSheetPath])

console.log(JSON.stringify({
  durationSeconds,
  renderedFrames: framePaths.length,
  pixelDifference,
  contactSheetPath
}, null, 2))
