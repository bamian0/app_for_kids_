// PWA + Web Push client API used by the screens. STUB: the platform agent implements the bodies.
import type { UID } from '../domain/types.ts'

/** 'needs-install': iOS Safari tab — push only works after Add to Home Screen. */
export type PushSupport = 'supported' | 'needs-install' | 'unsupported'

export function isIOS(): boolean {
  throw new Error('not implemented')
}

/** Running as an installed Home Screen app. */
export function isStandalone(): boolean {
  throw new Error('not implemented')
}

export function pushSupport(): PushSupport {
  throw new Error('not implemented')
}

/** Is there an active subscription stored for this device? */
export function isPushEnabled(): Promise<boolean> {
  throw new Error('not implemented')
}

/** Must be called directly from a tap handler. Asks permission, subscribes with the VAPID key
 *  from public/config and stores the subscription under users/{uid}/push. Returns false if denied/unavailable. */
export function enablePush(uid: UID): Promise<boolean> {
  throw new Error(`not implemented ${uid}`)
}

export function disablePush(uid: UID): Promise<void> {
  throw new Error(`not implemented ${uid}`)
}

/** Registers ./sw.js (safe to call once at startup). */
export function registerServiceWorker(): void {
  throw new Error('not implemented')
}
