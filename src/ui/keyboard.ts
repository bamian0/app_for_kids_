// On-screen keyboard handling. iOS never resizes the layout viewport for the keyboard: it pans the
// visual viewport across the fixed app shell instead, which pushes the nav bar off the top. We undo
// the pan, end the shell at the keyboard's top (--keyboard-inset) and scroll the focused field into
// view inside its own scroller.

export interface ViewportBox {
  height: number
  offsetTop: number
  scale: number
}

/** Pixels of the layout viewport hidden below the visual viewport: the keyboard, or 0. */
export function keyboardInset(innerHeight: number, vv: ViewportBox): number {
  // Pinch zoom shrinks the visual viewport too; that is not a keyboard.
  if (Math.abs(vv.scale - 1) > 0.01) return 0
  const inset = Math.round(innerHeight - vv.height - vv.offsetTop)
  // Sub-pixel rounding between the two viewports is noise.
  return inset > 2 ? inset : 0
}

const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'])

/** Whether the element brings up the keyboard. */
export function isTextField(el: Element | null): el is HTMLElement {
  if (!el) return false
  if (el.tagName === 'TEXTAREA') return true
  if (el.tagName === 'INPUT') return !NON_TEXT_INPUTS.has((el as HTMLInputElement).type)
  return (el as HTMLElement).isContentEditable === true
}

/**
 * Ends editing before a gesture takes the view away (swipe-back, sheet drag). WebKit fires no blur
 * when a focused field is removed, so onBlur saves would never run.
 */
export function blurFocusedField(): void {
  if (typeof document === 'undefined') return
  const el = document.activeElement
  if (isTextField(el)) el.blur()
}

/** Where `target` must scroll to so `field` sits between `top` and `bottom` (viewport px), or null if it already does. */
export function revealScrollTop(
  current: number,
  field: { top: number; bottom: number },
  visible: { top: number; bottom: number },
  margin = 12,
): number | null {
  const room = visible.bottom - visible.top - 2 * margin
  if (field.bottom + margin > visible.bottom && field.bottom - field.top <= room) return current + field.bottom + margin - visible.bottom
  if (field.top - margin < visible.top || field.bottom - field.top > room) {
    const next = current + field.top - margin - visible.top
    return Math.abs(next - current) < 1 ? null : next
  }
  return null
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) return n
  }
  return null
}

/** Keeps the focused field visible inside its scroller, clear of the nav bar above and a toolbar below. */
function revealFocused(): void {
  const el = document.activeElement
  if (!isTextField(el)) return
  const scroller = scrollParent(el)
  if (!scroller) return
  const box = scroller.getBoundingClientRect()
  const screen = scroller.closest('.ui-screen')
  const bar = screen?.querySelector(':scope > .ui-bar')?.getBoundingClientRect()
  const toolbar = screen?.querySelector(':scope > .ui-screen__toolbar .ui-toolbar')?.getBoundingClientRect()
  const visible = {
    top: Math.max(box.top, bar?.bottom ?? box.top),
    bottom: Math.min(box.bottom, toolbar && toolbar.height > 0 ? toolbar.top : box.bottom),
  }
  const next = revealScrollTop(scroller.scrollTop, el.getBoundingClientRect(), visible)
  if (next == null) return
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  scroller.scrollTo({ top: next, behavior: reduced ? 'auto' : 'smooth' })
}

/**
 * Follows the visual viewport: sets --keyboard-inset and [data-keyboard] on <html>, cancels iOS's pan
 * of the fixed shell while a field is focused, and reveals the field. Returns a cleanup function.
 */
export function trackKeyboard(root: HTMLElement = document.documentElement): () => void {
  const vv = window.visualViewport
  if (!vv) return () => {}
  let frame = 0
  let last = -1

  const update = () => {
    frame = 0
    const typing = isTextField(document.activeElement)
    // The shell is position:fixed, so any document scroll or viewport pan only hides the nav bar.
    if (typing && (vv.offsetTop > 0 || window.scrollY !== 0)) window.scrollTo(0, 0)
    const inset = keyboardInset(window.innerHeight, vv)
    if (inset !== last) {
      last = inset
      root.style.setProperty('--keyboard-inset', `${inset}px`)
      root.toggleAttribute('data-keyboard', inset > 0)
    }
    // After the shell has been laid out at its new height.
    if (typing && inset > 0) requestAnimationFrame(revealFocused)
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update)
  }

  vv.addEventListener('resize', schedule)
  vv.addEventListener('scroll', schedule)
  window.addEventListener('scroll', schedule, { passive: true })
  document.addEventListener('focusin', schedule)
  update()
  return () => {
    cancelAnimationFrame(frame)
    vv.removeEventListener('resize', schedule)
    vv.removeEventListener('scroll', schedule)
    window.removeEventListener('scroll', schedule)
    document.removeEventListener('focusin', schedule)
    root.style.removeProperty('--keyboard-inset')
    root.removeAttribute('data-keyboard')
  }
}
