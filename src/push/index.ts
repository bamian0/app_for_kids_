// PWA + Web Push client API used by the screens.
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore'
import type { UID } from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import { isUIBusy, presentToast } from '../ui/bridge.ts'

/** 'needs-install': iOS Safari tab — push only works after Add to Home Screen. */
export type PushSupport = 'supported' | 'needs-install' | 'unsupported'

/** Thrown by enablePush when reminders can't be set up for a reason other than the user saying no. */
export class PushSetupError extends Error {
  override name = 'PushSetupError'
}

const SW_URL = './sw.js'

// Safari only shows the permission prompt when pushManager.subscribe() runs inside the tap
// handler itself, so the registration and the VAPID key are fetched ahead of time.
let registration: ServiceWorkerRegistration | null = null
let vapidKey: Uint8Array<ArrayBuffer> | null = null
let preloading: Promise<void> | null = null

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  // iPadOS 13+ reports a desktop Mac user agent; touch support gives it away.
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

/** Running as an installed Home Screen app. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
  return window.matchMedia?.('(display-mode: standalone)').matches === true || iosStandalone
}

export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported'
  if (isIOS() && !isStandalone()) return 'needs-install'
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window ? 'supported' : 'unsupported'
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Doc id for a subscription: first 32 hex chars of SHA-256(endpoint), so a device maps to one doc. */
export async function subscriptionId(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

/** The registration once its worker is active (subscribe() needs one), or null when there is none. */
async function currentRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (registration?.active) return registration
  if (!('serviceWorker' in navigator)) return null
  // getRegistration() resolves immediately; `ready` alone would hang forever in dev, where no worker is registered.
  const reg = registration ?? (await navigator.serviceWorker.getRegistration()) ?? null
  if (reg && !reg.active) await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 5000))])
  registration = reg
  return reg
}

async function loadVapidKey(): Promise<Uint8Array<ArrayBuffer> | null> {
  if (vapidKey) return vapidKey
  const snap = await getDoc(doc(getFirebase().db, 'public', 'config'))
  const key = snap.get('vapidPublicKey')
  vapidKey = typeof key === 'string' && key ? base64UrlToBytes(key) : null
  return vapidKey
}

/** Fetches the service worker registration and VAPID key so enablePush can subscribe straight
 *  from the tap. Call it when the notifications UI mounts (user signed in). Never throws. */
export function preloadPushConfig(): Promise<void> {
  if (pushSupport() !== 'supported') return Promise.resolve()
  preloading ??= Promise.all([currentRegistration(), loadVapidKey()])
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      preloading = null
    })
  return preloading
}

async function storeSubscription(uid: UID, sub: PushSubscription): Promise<void> {
  const { endpoint, keys } = sub.toJSON()
  if (!endpoint || !keys?.p256dh || !keys.auth) throw new PushSetupError('This browser returned an incomplete push subscription.')
  await setDoc(doc(getFirebase().db, 'users', uid, 'push', await subscriptionId(endpoint)), {
    endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    createdAt: serverTimestamp(),
    ua: navigator.userAgent.slice(0, 200),
  })
}

async function subscribe(reg: ServiceWorkerRegistration, key: Uint8Array<ArrayBuffer>): Promise<PushSubscription> {
  try {
    return await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  } catch (e) {
    // An old subscription made with a different VAPID key blocks a new one. Permission is already
    // granted at this point, so the retry no longer needs the tap.
    const existing = e instanceof DOMException && e.name === 'InvalidStateError' ? await reg.pushManager.getSubscription() : null
    if (!existing) throw e
    await existing.unsubscribe()
    return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  }
}

/** Is there an active subscription stored for this device (and, when signed in, for this account)? */
export async function isPushEnabled(): Promise<boolean> {
  if (pushSupport() !== 'supported' || Notification.permission !== 'granted') return false
  try {
    const sub = await (await currentRegistration())?.pushManager.getSubscription()
    if (!sub) return false
    const uid = getFirebase().auth.currentUser?.uid
    if (!uid) return true
    // The device may be subscribed for another account, or the reminders job dropped an expired doc.
    const snap = await getDoc(doc(getFirebase().db, 'users', uid, 'push', await subscriptionId(sub.endpoint)))
    return snap.exists()
  } catch {
    return false
  }
}

/** Must be called directly from a tap handler. Asks permission, subscribes with the VAPID key
 *  from public/config and stores the subscription under users/{uid}/push. Returns false if denied/unavailable.
 *  Throws PushSetupError when reminders are not set up on the server yet, or a Firestore error if saving fails. */
export async function enablePush(uid: UID): Promise<boolean> {
  if (pushSupport() !== 'supported' || Notification.permission === 'denied') return false

  // Fast path: nothing awaited before subscribe(), so Safari still sees the tap.
  let pending: Promise<PushSubscription> | null = registration?.active && vapidKey ? subscribe(registration, vapidKey) : null
  if (!pending) {
    const [reg, key] = await Promise.all([currentRegistration(), loadVapidKey()])
    if (!reg) return false
    if (!key) throw new PushSetupError('Reminders aren’t switched on for this app yet. Try again later.')
    pending = subscribe(reg, key)
  }

  let sub: PushSubscription
  try {
    sub = await pending
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')) return false
    throw e
  }
  await storeSubscription(uid, sub)
  return true
}

export async function disablePush(uid: UID): Promise<void> {
  const sub = await (await currentRegistration())?.pushManager.getSubscription()
  if (!sub) return
  await deleteDoc(doc(getFirebase().db, 'users', uid, 'push', await subscriptionId(sub.endpoint)))
  await sub.unsubscribe()
}

// ---------- Updates ----------

/** Set by vite.config.ts; sw.js is stamped with the same id, so page and worker can be compared. */
const BUILD_ID: string | undefined = import.meta.env.VITE_BUILD_ID
/** How often a resumed app asks the server for a new worker. */
const UPDATE_CHECK_MS = 30 * 60 * 1000

/** The build of the worker in charge of this page (sw.js answers 'build'), or null if it can't say. */
function controllerBuild(): Promise<string | null> {
  const worker = navigator.serviceWorker.controller
  if (!worker || typeof MessageChannel === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel()
    const done = (build: string | null) => {
      clearTimeout(timer)
      port1.close()
      resolve(build)
    }
    const timer = setTimeout(() => done(null), 3000)
    port1.onmessage = (e: MessageEvent) => done(typeof e.data === 'string' ? e.data : null)
    worker.postMessage('build', [port2])
  })
}

/**
 * Keeps an installed app current. iOS resumes Home Screen apps from memory without navigating, so
 * nothing checks for a new worker unless we do: on every return to the app, at most every 30 minutes.
 * Once the worker in charge belongs to a newer build than this page, the page reloads, unless the
 * user is typing or has a sheet or alert open; then a banner offers the reload instead.
 * A fresh install, or a launch that already loaded the new build, has matching ids and does nothing.
 */
export function watchForUpdates(reg: ServiceWorkerRegistration, build: string | undefined = BUILD_ID): () => void {
  let lastCheck = Date.now()
  const reloadIfStale = async () => {
    const current = await controllerBuild()
    if (!build || !current || current === build) return
    if (!isUIBusy()) location.reload()
    else presentToast({ title: 'Updated — tap to reload', icon: 'sparkles', durationMs: 6000, onPress: () => location.reload() })
  }
  const onVisibility = () => {
    if (document.visibilityState !== 'visible') return
    if (Date.now() - lastCheck >= UPDATE_CHECK_MS) {
      lastCheck = Date.now()
      reg.update().catch(() => {})
    }
    // An update that arrived while the user was busy is applied on the next return.
    void reloadIfStale()
  }
  navigator.serviceWorker.addEventListener('controllerchange', reloadIfStale)
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    navigator.serviceWorker.removeEventListener('controllerchange', reloadIfStale)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}

/** Registers ./sw.js and watches for updates (safe to call once at startup). Production builds only, so dev never serves stale files. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  const register = () => {
    navigator.serviceWorker
      .register(SW_URL, { scope: './', updateViaCache: 'none' })
      .then((reg) => {
        registration = reg
        watchForUpdates(reg)
      })
      .catch((e: unknown) => console.warn('Service worker registration failed', e))
  }
  // Wait for the first render's network traffic to finish before fetching the worker.
  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}
