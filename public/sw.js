// Stakes service worker: offline app shell, cached static files, Web Push.
// Plain JS, served as-is from public/ (no build step). Bump VERSION to drop old caches.
const VERSION = 1
const SHELL_CACHE = `stakes-shell-v${VERSION}`
const STATIC_CACHE = `stakes-static-v${VERSION}`
const MAX_STATIC_ENTRIES = 80

/** The app root, e.g. https://user.github.io/app_for_kids_/ */
const SHELL_URL = self.registration.scope
const STATIC_PATHS = ['assets/', 'icons/'].map((dir) => new URL(dir, SHELL_URL).pathname)
const NAVIGATION_TIMEOUT_MS = 4000

const ICON = './icons/icon-192.png'
const BADGE = './icons/badge-96.png'

self.addEventListener('install', (event) => {
  self.skipWaiting()
  // Best effort: an offline or failed precache must not block the update.
  event.waitUntil(precacheShell().catch(() => {}))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // github.io origins are shared by all of a user's Pages sites: only touch our own caches.
      const keep = [SHELL_CACHE, STATIC_CACHE]
      const names = await caches.keys()
      await Promise.all(names.filter((n) => n.startsWith('stakes-') && !keep.includes(n)).map((n) => caches.delete(n)))
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => {})
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  // Firebase, Google APIs and every other origin go straight to the network.
  if (url.origin !== self.location.origin) return
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(event))
  } else if (STATIC_PATHS.some((path) => url.pathname.startsWith(path))) {
    event.respondWith(staleWhileRevalidate(event))
  }
})

function isHtml(response) {
  return response.ok && (response.headers.get('content-type') || '').includes('text/html')
}

/** Caches index.html plus the hashed files it references, so the app opens offline after the first visit. */
async function precacheShell() {
  const response = await fetch(SHELL_URL, { cache: 'reload' })
  if (!isHtml(response)) return
  const html = await response.clone().text()
  await (await caches.open(SHELL_CACHE)).put(SHELL_URL, response)
  const urls = new Set()
  for (const [, ref] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = new URL(ref, SHELL_URL)
    if (url.origin === self.location.origin && STATIC_PATHS.some((path) => url.pathname.startsWith(path))) urls.add(url.href)
  }
  const cache = await caches.open(STATIC_CACHE)
  await Promise.all([...urls].map((url) => cache.add(url).catch(() => {})))
}

async function cachedShell() {
  const cache = await caches.open(SHELL_CACHE)
  return (await cache.match(SHELL_URL)) || (await cache.match(new URL('index.html', SHELL_URL).href))
}

/** Network first so a deploy shows up on the next launch; the cached shell when offline or very slow. */
async function networkFirstShell(event) {
  const network = (async () => {
    const response = (await event.preloadResponse) || (await fetch(event.request))
    // Every page of this app is the same index.html, whatever the query string (?join=…).
    if (isHtml(response)) {
      const copy = response.clone()
      event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.put(SHELL_URL, copy)))
    }
    return response
  })()
  event.waitUntil(network.catch(() => {}))

  const timeout = new Promise((resolve) => setTimeout(resolve, NAVIGATION_TIMEOUT_MS, null))
  try {
    const first = await Promise.race([network, timeout])
    if (first) return first
    return (await cachedShell()) || (await network)
  } catch {
    return (await cachedShell()) || Response.error()
  }
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(STATIC_CACHE)
  const cached = await cache.match(event.request)
  const network = fetch(event.request).then(async (response) => {
    if (response.ok) {
      await cache.put(event.request, response.clone())
      await trimCache(cache)
    }
    return response
  })
  if (!cached) return network
  event.waitUntil(network.catch(() => {}))
  return cached
}

/** Old hashed builds pile up across deploys; keep the most recently written entries. */
async function trimCache(cache) {
  const keys = await cache.keys()
  const excess = keys.length - MAX_STATIC_ENTRIES
  if (excess > 0) await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)))
}

// ---------- Web Push ----------

function readPush(data) {
  let payload = {}
  if (data) {
    try {
      payload = data.json() || {}
    } catch {
      payload = { body: data.text() }
    }
  }
  const text = (value, fallback) => (typeof value === 'string' && value ? value : fallback)
  return {
    title: text(payload.title, 'Stakes'),
    body: text(payload.body, ''),
    tag: text(payload.tag, 'stakes'),
    url: text(payload.url, './'),
  }
}

self.addEventListener('push', (event) => {
  // Always show something: iOS revokes the subscription after pushes that show no notification.
  const { title, body, tag, url } = readPush(event.data)
  event.waitUntil(
    self.registration.showNotification(title, { body, tag, renotify: false, data: { url }, icon: ICON, badge: BADGE }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL((event.notification.data && event.notification.data.url) || './', SHELL_URL).href
  event.waitUntil(openApp(target))
})

async function openApp(target) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const client = windows.find((c) => c.url.startsWith(SHELL_URL))
  if (!client) return self.clients.openWindow(target)
  const focused = (await client.focus().catch(() => null)) || client
  // The app has no URL routes: reloading the root would only throw away in-app state.
  if (target !== SHELL_URL && focused.url !== target && 'navigate' in focused) {
    await focused.navigate(target).catch(() => {})
  }
}
