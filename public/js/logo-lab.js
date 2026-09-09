const durationSeconds = 3.6
const namespace = 'http://www.w3.org/2000/svg'
const segments = [
  { id: 'logo-gesture-upper', start: 0, end: 0.4, length: 446, color: '#eb4d4b' },
  { id: 'logo-gesture-loop', start: 0.38, end: 0.64, length: 356, color: '#3578e5' },
  { id: 'logo-gesture-return', start: 0.62, end: 0.96, length: 403, color: '#15966f' }
]
const supportingTraces = [
  { selector: '.logo-trace-upper-fill', start: 0, end: 0.28, length: 342 },
  { selector: '.logo-trace-upper-mid', start: 0, end: 0.34, length: 361 }
]

const stage = document.querySelector('[data-logo-lab-stage]')
const progressControl = document.querySelector('[data-logo-progress]')
const playControl = document.querySelector('[data-logo-play]')
const restartControl = document.querySelector('[data-logo-restart]')
const speedControl = document.querySelector('[data-logo-speed]')
const guidesControl = document.querySelector('[data-logo-guides]')
const timeOutput = document.querySelector('[data-logo-time]')

let svg
let marker
let progress = 0
let playing = false
let animationFrame
let previousTimestamp

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value))
}

function getSegmentProgress(value, segment) {
  return clamp((value - segment.start) / (segment.end - segment.start))
}

function setGuidesVisible(visible) {
  svg?.querySelector('.logo-lab-guides')?.toggleAttribute('hidden', !visible)
}

function updateMarker(value) {
  const activeSegment = segments.find((segment) => value <= segment.end) || segments.at(-1)
  const path = svg.querySelector(`#${activeSegment.id}`)
  const segmentProgress = getSegmentProgress(value, activeSegment)
  const point = path.getPointAtLength(path.getTotalLength() * segmentProgress)

  marker.setAttribute('cx', point.x)
  marker.setAttribute('cy', point.y)
  marker.setAttribute('fill', activeSegment.color)
}

function render(value) {
  progress = clamp(value)

  for (const segment of segments) {
    const path = svg.querySelector(`#${segment.id}`)
    const segmentProgress = getSegmentProgress(progress, segment)
    path.style.animation = 'none'
    path.style.strokeDashoffset = String(segment.length * (1 - segmentProgress))
  }

  for (const trace of supportingTraces) {
    const element = svg.querySelector(trace.selector)
    const traceProgress = getSegmentProgress(progress, trace)
    element.style.animation = 'none'
    element.style.strokeDashoffset = String(trace.length * (1 - traceProgress))
  }

  const finish = svg.querySelector('.logo-reveal-finish')
  finish.style.animation = 'none'
  finish.style.opacity = String(clamp((progress - 0.96) / 0.04))

  const dot = svg.querySelector('.logo-dot')
  const dotProgress = clamp((progress - 0.92) / 0.08)
  dot.style.animation = 'none'
  dot.style.opacity = String(dotProgress)
  dot.style.transform = `translate(${12 * (1 - dotProgress) * -1}px, ${10 * (1 - dotProgress)}px) scale(${0.35 + (0.65 * dotProgress)})`

  updateMarker(progress)
  progressControl.value = String(Math.round(progress * 1000))
  timeOutput.value = `${(progress * durationSeconds).toFixed(2).replace('.', ',')} s / 3,60 s`
}

function stop() {
  playing = false
  previousTimestamp = undefined
  window.cancelAnimationFrame(animationFrame)
  playControl.textContent = 'Lire'
}

function tick(timestamp) {
  if (!playing) return
  if (previousTimestamp === undefined) previousTimestamp = timestamp

  const speed = Number.parseFloat(speedControl.value)
  const elapsed = (timestamp - previousTimestamp) / 1000
  previousTimestamp = timestamp
  render(progress + ((elapsed * speed) / durationSeconds))

  if (progress >= 1) {
    stop()
    return
  }

  animationFrame = window.requestAnimationFrame(tick)
}

function play() {
  if (progress >= 1) render(0)
  playing = true
  playControl.textContent = 'Pause'
  animationFrame = window.requestAnimationFrame(tick)
}

function addGuides() {
  const guides = document.createElementNS(namespace, 'g')
  guides.classList.add('logo-lab-guides')

  for (const segment of segments) {
    const source = svg.querySelector(`#${segment.id}`)
    const guide = source.cloneNode()
    guide.removeAttribute('id')
    guide.removeAttribute('class')
    guide.removeAttribute('style')
    guide.setAttribute('fill', 'none')
    guide.setAttribute('stroke', segment.color)
    guide.setAttribute('stroke-width', '3.5')
    guide.setAttribute('stroke-linecap', 'round')
    guide.setAttribute('stroke-linejoin', 'round')
    guide.setAttribute('stroke-dasharray', '8 7')
    guide.setAttribute('opacity', '0.9')
    guides.append(guide)
  }

  marker = document.createElementNS(namespace, 'circle')
  marker.setAttribute('r', '7')
  marker.setAttribute('stroke', '#fff')
  marker.setAttribute('stroke-width', '3')
  guides.append(marker)
  svg.append(guides)
}

async function initialize() {
  const response = await fetch('/images/logo-noname-web.svg?v=s-gesture-11')
  if (!response.ok) throw new Error('Logo unavailable')

  stage.innerHTML = await response.text()
  svg = stage.querySelector('svg')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', 'Animation du geste du logo Saleté Sincère')
  addGuides()
  render(0)

  progressControl.addEventListener('input', () => {
    stop()
    render(Number(progressControl.value) / 1000)
  })

  playControl.addEventListener('click', () => {
    if (playing) stop()
    else play()
  })

  restartControl.addEventListener('click', () => {
    stop()
    render(0)
  })

  guidesControl.addEventListener('change', () => {
    setGuidesVisible(guidesControl.checked)
  })
}

initialize().catch(() => {
  stage.innerHTML = '<p>Impossible de charger le logo.</p>'
  playControl.disabled = true
  restartControl.disabled = true
  progressControl.disabled = true
})
