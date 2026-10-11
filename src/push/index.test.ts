import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  failSetDoc: false,
}))

vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, ...path: string[]) => ({ path: path.join('/') }),
  getDoc: async (ref: { path: string }) => {
    const data = store.docs.get(ref.path)
    return { exists: () => data !== undefined, get: (field: string) => data?.[field] }
  },
  setDoc: async (ref: { path: string }, data: Record<string, unknown>) => {
    if (store.failSetDoc) throw new Error('permission-denied')
    store.docs.set(ref.path, data)
  },
  deleteDoc: async (ref: { path: string }) => {
    store.docs.delete(ref.path)
  },
  serverTimestamp: () => 'SERVER_TIMESTAMP',
}))

vi.mock('../firebase/app.ts', () => ({
  getFirebase: () => ({ db: {}, auth: { currentUser: { uid: 'u1' } } }),
}))

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36'
// A 65-byte uncompressed P-256 point, base64url-encoded like a real VAPID public key.
const VAPID_BYTES = [4, ...Array.from({ length: 64 }, (_, i) => i * 3)]
const VAPID_KEY = btoa(String.fromCharCode(...VAPID_BYTES)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const ENDPOINT = 'https://web.push.apple.com/QAbc123'
/** First 32 hex chars of SHA-256(ENDPOINT). */
const ENDPOINT_ID = '41f03b9d25653219a622ba37fc8b3d0c'

interface FakeSub {
  endpoint: string
  toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } }
  unsubscribe: ReturnType<typeof vi.fn>
}

function fakeSub(endpoint = ENDPOINT): FakeSub {
  return { endpoint, toJSON: () => ({ endpoint, keys: { p256dh: 'p256', auth: 'auth' } }), unsubscribe: vi.fn(async () => true) }
}

function setup(opts: { ua?: string; platform?: string; touch?: number; standalone?: boolean; permission?: NotificationPermission; push?: boolean } = {}) {
  const pushManager = {
    current: null as FakeSub | null,
    subscribe: vi.fn(async () => (pushManager.current = fakeSub())),
    getSubscription: vi.fn(async () => pushManager.current),
  }
  const registration = { active: {}, pushManager }
  vi.stubGlobal('navigator', {
    userAgent: opts.ua ?? ANDROID,
    platform: opts.platform ?? 'Linux armv8l',
    maxTouchPoints: opts.touch ?? 5,
    standalone: opts.standalone,
    serviceWorker: { getRegistration: vi.fn(async () => registration), ready: Promise.resolve(registration) },
  })
  const win: Record<string, unknown> = { matchMedia: () => ({ matches: false }) }
  if (opts.push !== false) Object.assign(win, { PushManager: class {}, Notification: { permission: opts.permission ?? 'default' } })
  vi.stubGlobal('window', win)
  vi.stubGlobal('Notification', win.Notification)
  return { pushManager }
}

async function load() {
  vi.resetModules()
  return import('./index.ts')
}

beforeEach(() => {
  store.docs.clear()
  store.failSetDoc = false
  store.docs.set('public/config', { vapidPublicKey: VAPID_KEY })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('platform detection', () => {
  it('recognises iPhone and iPadOS with a desktop user agent', async () => {
    setup({ ua: IPHONE, platform: 'iPhone' })
    expect((await load()).isIOS()).toBe(true)
    setup({ ua: MAC, platform: 'MacIntel', touch: 5 })
    expect((await load()).isIOS()).toBe(true)
    setup({ ua: MAC, platform: 'MacIntel', touch: 0 })
    expect((await load()).isIOS()).toBe(false)
    setup({ ua: ANDROID })
    expect((await load()).isIOS()).toBe(false)
  })

  it('detects the installed Home Screen app', async () => {
    setup({ ua: IPHONE, standalone: true })
    expect((await load()).isStandalone()).toBe(true)
    setup({ ua: IPHONE })
    expect((await load()).isStandalone()).toBe(false)
  })

  it('reports push support', async () => {
    setup({ ua: IPHONE, platform: 'iPhone' })
    expect((await load()).pushSupport()).toBe('needs-install')
    setup({ ua: IPHONE, platform: 'iPhone', standalone: true })
    expect((await load()).pushSupport()).toBe('supported')
    setup({ ua: ANDROID })
    expect((await load()).pushSupport()).toBe('supported')
    setup({ ua: ANDROID, push: false })
    expect((await load()).pushSupport()).toBe('unsupported')
  })
})

describe('enablePush', () => {
  it('subscribes synchronously inside the tap once the config is preloaded', async () => {
    const { pushManager } = setup({ ua: IPHONE, platform: 'iPhone', standalone: true })
    const push = await load()
    await push.preloadPushConfig()

    const pending = push.enablePush('u1')
    // Safari only prompts if subscribe() runs before the handler yields.
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1)
    expect(await pending).toBe(true)

    const [options] = pushManager.subscribe.mock.calls[0] as unknown as [PushSubscriptionOptionsInit]
    expect(options.userVisibleOnly).toBe(true)
    expect([...(options.applicationServerKey as Uint8Array)]).toEqual(VAPID_BYTES)
    expect(store.docs.get(`users/u1/push/${ENDPOINT_ID}`)).toEqual({
      endpoint: ENDPOINT,
      keys: { p256dh: 'p256', auth: 'auth' },
      createdAt: 'SERVER_TIMESTAMP',
      ua: IPHONE.slice(0, 200),
    })
  })

  it('still works without a preload, fetching the config first', async () => {
    const { pushManager } = setup()
    const push = await load()
    expect(await push.enablePush('u1')).toBe(true)
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1)
  })

  it('returns false when the user said no', async () => {
    const denied = setup({ permission: 'denied' })
    expect(await (await load()).enablePush('u1')).toBe(false)
    expect(denied.pushManager.subscribe).not.toHaveBeenCalled()

    const { pushManager } = setup()
    pushManager.subscribe.mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'))
    expect(await (await load()).enablePush('u1')).toBe(false)
    expect(store.docs.size).toBe(1)
  })

  it('returns false in a Safari tab on iOS', async () => {
    const { pushManager } = setup({ ua: IPHONE, platform: 'iPhone' })
    expect(await (await load()).enablePush('u1')).toBe(false)
    expect(pushManager.subscribe).not.toHaveBeenCalled()
  })

  it('explains when the server has not published a VAPID key yet', async () => {
    store.docs.delete('public/config')
    setup()
    const push = await load()
    await expect(push.enablePush('u1')).rejects.toBeInstanceOf(push.PushSetupError)
  })

  it('replaces a subscription made with an old key', async () => {
    const { pushManager } = setup()
    const old = fakeSub('https://fcm.googleapis.com/fcm/send/old')
    pushManager.current = old
    pushManager.subscribe.mockRejectedValueOnce(new DOMException('different key', 'InvalidStateError'))
    expect(await (await load()).enablePush('u1')).toBe(true)
    expect(old.unsubscribe).toHaveBeenCalled()
    expect(pushManager.subscribe).toHaveBeenCalledTimes(2)
  })

  it('surfaces a failure to save the subscription', async () => {
    store.failSetDoc = true
    setup()
    await expect((await load()).enablePush('u1')).rejects.toThrow('permission-denied')
  })
})

describe('isPushEnabled and disablePush', () => {
  it('needs both the device subscription and the doc for the signed-in user', async () => {
    const { pushManager } = setup({ permission: 'granted' })
    const push = await load()
    expect(await push.isPushEnabled()).toBe(false)
    pushManager.current = fakeSub()
    // Subscribed on this device, but for another account (or the job removed an expired doc).
    expect(await push.isPushEnabled()).toBe(false)
    store.docs.set(`users/u1/push/${ENDPOINT_ID}`, { endpoint: ENDPOINT })
    expect(await push.isPushEnabled()).toBe(true)
  })

  it('unsubscribes and deletes the doc', async () => {
    const { pushManager } = setup({ permission: 'granted' })
    const push = await load()
    expect(await push.enablePush('u1')).toBe(true)
    const sub = pushManager.current!
    await push.disablePush('u1')
    expect(sub.unsubscribe).toHaveBeenCalled()
    expect(store.docs.has(`users/u1/push/${ENDPOINT_ID}`)).toBe(false)
  })
})

describe('subscriptionId', () => {
  it('is the first 32 hex chars of SHA-256(endpoint)', async () => {
    setup()
    const push = await load()
    expect(await push.subscriptionId(ENDPOINT)).toBe(ENDPOINT_ID)
  })
})

describe('registerServiceWorker', () => {
  it('does nothing outside production builds', async () => {
    setup()
    const register = vi.fn()
    ;(navigator.serviceWorker as unknown as { register: typeof register }).register = register
    ;(await load()).registerServiceWorker()
    expect(register).not.toHaveBeenCalled()
  })
})

describe('watchForUpdates', () => {
  /** A page of build `page`, controlled by a worker that reports `worker.build` when asked. */
  async function updating(opts: { page?: string; busy?: boolean; modal?: boolean } = {}) {
    setup()
    const worker = { build: opts.page ?? 'b1', postMessage: vi.fn((_: unknown, [port]: Array<{ postMessage: (d: unknown) => void }>) => port.postMessage(worker.build)) }
    const sw = navigator.serviceWorker as unknown as Record<string, unknown>
    const swListeners = new Map<string, () => void>()
    Object.assign(sw, {
      controller: worker,
      addEventListener: (type: string, fn: () => void) => swListeners.set(type, fn),
      removeEventListener: (type: string) => swListeners.delete(type),
    })
    const docListeners = new Map<string, () => void>()
    const doc = {
      visibilityState: 'visible',
      activeElement: opts.busy ? { tagName: 'INPUT', type: 'text' } : null,
      addEventListener: (type: string, fn: () => void) => docListeners.set(type, fn),
      removeEventListener: (type: string) => docListeners.delete(type),
    }
    vi.stubGlobal('document', doc)
    vi.stubGlobal('location', { reload: vi.fn() })
    // Delivers synchronously, so the test needs no real message loop.
    vi.stubGlobal(
      'MessageChannel',
      class {
        port1: { onmessage: ((e: { data: unknown }) => void) | null; close: () => void } = { onmessage: null, close: () => {} }
        port2 = { postMessage: (data: unknown) => this.port1.onmessage?.({ data }) }
      },
    )
    const push = await load()
    // After load(): the module registry was reset, and the push client must see this bridge.
    const { attachUIBridge } = await import('../ui/bridge.ts')
    const toasts: Array<{ title: string; onPress?: () => void }> = []
    const detach = attachUIBridge({ toast: (t) => toasts.push(t), modalOpen: () => opts.modal === true })
    const reg = { update: vi.fn(async () => {}) }
    const stop = push.watchForUpdates(reg as unknown as ServiceWorkerRegistration, 'b1')
    const settle = () => new Promise((r) => setTimeout(r, 0))
    return {
      worker,
      reg,
      toasts,
      doc,
      reload: location.reload as ReturnType<typeof vi.fn>,
      async controllerChange() {
        swListeners.get('controllerchange')!()
        await settle()
      },
      async resume() {
        docListeners.get('visibilitychange')!()
        await settle()
      },
      stop() {
        stop()
        detach()
        vi.useRealTimers()
        return { swListeners, docListeners }
      },
    }
  }

  it('ignores the first install and a launch that already loaded the new build', async () => {
    const t = await updating()
    await t.controllerChange()
    await t.resume()
    expect(t.reload).not.toHaveBeenCalled()
    expect(t.toasts).toEqual([])
    const { swListeners, docListeners } = t.stop()
    expect(swListeners.size + docListeners.size).toBe(0)
  })

  it('checks for a new worker on resume, at most every 30 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t = await updating()
    await t.resume()
    expect(t.reg.update).not.toHaveBeenCalled()
    vi.setSystemTime(Date.now() + 31 * 60 * 1000)
    await t.resume()
    expect(t.reg.update).toHaveBeenCalledTimes(1)
    await t.resume()
    expect(t.reg.update).toHaveBeenCalledTimes(1)
    t.doc.visibilityState = 'hidden'
    vi.setSystemTime(Date.now() + 31 * 60 * 1000)
    await t.resume()
    expect(t.reg.update).toHaveBeenCalledTimes(1)
    t.stop()
  })

  it('reloads into a new build when nothing is in progress', async () => {
    const t = await updating()
    t.worker.build = 'b2'
    await t.controllerChange()
    expect(t.reload).toHaveBeenCalledTimes(1)
    expect(t.toasts).toEqual([])
    t.stop()
  })

  it('offers the reload in a banner while typing or with a sheet open', async () => {
    const typing = await updating({ busy: true })
    typing.worker.build = 'b2'
    await typing.controllerChange()
    expect(typing.reload).not.toHaveBeenCalled()
    expect(typing.toasts.map((x) => x.title)).toEqual(['Updated — tap to reload'])
    typing.toasts[0].onPress!()
    expect(typing.reload).toHaveBeenCalledTimes(1)
    typing.stop()

    const sheet = await updating({ modal: true })
    sheet.worker.build = 'b2'
    await sheet.controllerChange()
    expect(sheet.reload).not.toHaveBeenCalled()
    expect(sheet.toasts).toHaveLength(1)
    sheet.stop()
  })

  it('applies an update that arrived while busy on the next return to the app', async () => {
    const t = await updating()
    t.worker.build = 'b2'
    await t.resume()
    expect(t.reload).toHaveBeenCalledTimes(1)
    t.stop()
  })

  it('stays put when the worker cannot say which build it is', async () => {
    const t = await updating()
    t.worker.build = 'b2'
    t.worker.postMessage.mockImplementation(() => {})
    vi.useFakeTimers()
    const fired = t.controllerChange()
    await vi.advanceTimersByTimeAsync(3100)
    await fired
    expect(t.reload).not.toHaveBeenCalled()
    expect(t.toasts).toEqual([])
    t.stop()
  })
})
