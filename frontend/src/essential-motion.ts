const ESSENTIAL_MOTION_SELECTOR = [
  '.loading-state > div',
  '.search-progress > span',
  '.tx-spinner',
  '[aria-busy="true"]',
  '[role="progressbar"]',
].join(',')

type AnimationDocument = Document & {
  getAnimations?: (options?: { subtree?: boolean }) => Animation[]
}

export function installEssentialMotion() {
  const root = document.documentElement
  root.dataset.essentialMotion = 'enabled'

  let frame = 0

  const resume = () => {
    frame = 0
    const animations = (document as AnimationDocument).getAnimations?.({ subtree: true }) ?? []

    for (const animation of animations) {
      const target = (animation.effect as (KeyframeEffect & { target: Element | null }) | null)?.target
      if (!(target instanceof Element)) continue
      if (!target.matches(ESSENTIAL_MOTION_SELECTOR) && !target.closest(ESSENTIAL_MOTION_SELECTOR)) continue
      if (animation.playState !== 'paused' && animation.playState !== 'idle') continue

      try {
        animation.play()
      } catch {
        // A detached animation can disappear between enumeration and play().
      }
    }
  }

  const scheduleResume = () => {
    if (frame) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(resume)
  }

  const containsEssentialMotion = (node: Node) => {
    if (!(node instanceof Element)) return false
    return node.matches(ESSENTIAL_MOTION_SELECTOR) || Boolean(node.querySelector(ESSENTIAL_MOTION_SELECTOR))
  }

  const handleVisibility = () => {
    if (!document.hidden) scheduleResume()
  }

  const observer = new MutationObserver((records) => {
    if (records.some((record) => Array.from(record.addedNodes).some(containsEssentialMotion))) {
      scheduleResume()
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  document.addEventListener('visibilitychange', handleVisibility)
  window.addEventListener('focus', scheduleResume)
  window.addEventListener('pageshow', scheduleResume)
  scheduleResume()

  return () => {
    if (frame) cancelAnimationFrame(frame)
    observer.disconnect()
    document.removeEventListener('visibilitychange', handleVisibility)
    window.removeEventListener('focus', scheduleResume)
    window.removeEventListener('pageshow', scheduleResume)
    delete root.dataset.essentialMotion
  }
}
