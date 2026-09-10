const durationSeconds = 3.6
const namespace = 'http://www.w3.org/2000/svg'
const stage = document.querySelector('[data-logo-lab-stage]')
const progressControl = document.querySelector('[data-logo-progress]')
const playControl = document.querySelector('[data-logo-play]')
const restartControl = document.querySelector('[data-logo-restart]')
const speedControl = document.querySelector('[data-logo-speed]')
const guidesControl = document.querySelector('[data-logo-guides]')
const timeOutput = document.querySelector('[data-logo-time]')

let svg
let marker
let traces
let animations
let progress = 0
let playing = false
let animationFrame
let previousTimestamp

function clamp(value) {
  return Math.min(1, Math.max(0, value))
}

function render(value) {
  progress = clamp(value)
  // Scrub exactly the SVG animations used by the home page.
  for (const animation of animations) animation.currentTime = progress * durationSeconds * 1000

  const active = traces.find(trace => progress < Number(trace.dataset.end)) || traces.at(-1)
  const drawn = clamp(1 - Number.parseFloat(getComputedStyle(active).strokeDashoffset))
  const point = active.getPointAtLength(active.getTotalLength() * drawn)
  marker.setAttribute('cx', point.x)
  marker.setAttribute('cy', point.y)
  marker.setAttribute('fill', active.dataset.guideColor)

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
  const elapsed = (timestamp - previousTimestamp) / 1000
  previousTimestamp = timestamp
  render(progress + elapsed * Number.parseFloat(speedControl.value) / durationSeconds)
  if (progress >= 1) stop()
  else animationFrame = window.requestAnimationFrame(tick)
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
  for (const trace of traces) {
    const guide = document.createElementNS(namespace, 'path')
    guide.setAttribute('d', trace.getAttribute('d'))
    guide.setAttribute('fill', 'none')
    guide.setAttribute('stroke', trace.dataset.guideColor)
    guide.setAttribute('stroke-width', '3.5')
    guide.setAttribute('stroke-linecap', 'round')
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
  const response = await fetch('/images/logo-noname-web.svg?v=logo-ribbons-1')
  if (!response.ok) throw new Error('Logo unavailable')
  stage.innerHTML = await response.text()
  svg = stage.querySelector('svg')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', 'Animation du geste du logo Saleté Sincère')
  svg.setAttribute('data-logo-lab', '')
  traces = [...svg.querySelectorAll('.logo-trace')]
  animations = svg.getAnimations({ subtree: true })
  for (const animation of animations) animation.pause()
  addGuides()
  render(0)

  progressControl.addEventListener('input', () => {
    stop()
    render(Number(progressControl.value) / 1000)
  })
  playControl.addEventListener('click', () => playing ? stop() : play())
  restartControl.addEventListener('click', () => {
    stop()
    render(0)
  })
  guidesControl.addEventListener('change', () => {
    svg.querySelector('.logo-lab-guides').toggleAttribute('hidden', !guidesControl.checked)
  })
}

initialize().catch(() => {
  stage.innerHTML = '<p>Impossible de charger le logo.</p>'
  playControl.disabled = true
  restartControl.disabled = true
  progressControl.disabled = true
})
