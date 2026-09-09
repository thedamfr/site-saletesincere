const replayControl = document.querySelector('[data-logo-replay]')
const animatedLogo = replayControl?.querySelector('[data-logo-animation]')
const hero = replayControl?.closest('.landing-hero')

if (replayControl && animatedLogo && hero) {
  let replayCount = 0

  hero.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || event.target.closest('a')) return

    const bounds = replayControl.getBoundingClientRect()
    const clickedControl = event.target.closest('[data-logo-replay]')
    const clickedLogoBounds = event.detail > 0
      && event.clientX >= bounds.left
      && event.clientX <= bounds.right
      && event.clientY >= bounds.top
      && event.clientY <= bounds.bottom

    if (!clickedControl && !clickedLogoBounds) return

    const source = new URL(animatedLogo.currentSrc || animatedLogo.src, window.location.href)
    source.searchParams.set('replay', String(++replayCount))

    animatedLogo.removeAttribute('src')
    window.requestAnimationFrame(() => {
      animatedLogo.src = `${source.pathname}${source.search}${source.hash}`
    })
  })
}
