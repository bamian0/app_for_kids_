// Light haptic tap. iOS 18+ Safari plays a haptic when an <input type="checkbox" switch> toggles,
// even a hidden one, so we toggle one through its label. Android uses the Vibration API.
// Call only from a user gesture handler (click, change, pointerup).

let label: HTMLLabelElement | null = null

function ensureSwitch(): HTMLLabelElement | null {
  if (typeof document === 'undefined') return null
  if (label?.isConnected) return label
  label = document.createElement('label')
  label.setAttribute('aria-hidden', 'true')
  label.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;left:-10px;top:-10px'
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.setAttribute('switch', '')
  input.tabIndex = -1
  label.appendChild(input)
  document.body.appendChild(label)
  return label
}

const isIOS =
  typeof navigator !== 'undefined' &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1))

function isTyping(): boolean {
  const el = document.activeElement
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && (el as HTMLInputElement).type !== 'checkbox'
}

export function haptic(): void {
  try {
    if (isIOS) {
      // Clicking the label could steal focus from a field and drop the keyboard.
      if (!isTyping()) ensureSwitch()?.click()
    } else if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(8)
    }
  } catch {
    // Haptics are a nicety; never let them break an interaction.
  }
}
