// Lets code outside React (e.g. the service worker updater in src/push) reach the mounted UIProvider.
// Plain module, no CSS or components, so importing it costs nothing.
import type { ToastOptions } from './context.ts'
import { isTextField } from './keyboard.ts'

export interface UIBridge {
  toast: (options: ToastOptions) => void
  /** A sheet or alert is up. */
  modalOpen: () => boolean
}

let current: UIBridge | null = null

/** Called by UIProvider. Returns the detach function. */
export function attachUIBridge(bridge: UIBridge): () => void {
  current = bridge
  return () => {
    if (current === bridge) current = null
  }
}

/** Shows a banner from outside React. False when no UIProvider is mounted. */
export function presentToast(options: ToastOptions): boolean {
  if (!current) return false
  current.toast(options)
  return true
}

/** True while the user is in the middle of something: typing in a field, or a sheet or alert is up. */
export function isUIBusy(): boolean {
  if (typeof document !== 'undefined' && isTextField(document.activeElement)) return true
  return current?.modalOpen() ?? false
}
