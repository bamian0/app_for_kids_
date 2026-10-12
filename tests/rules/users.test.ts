// users/{uid}, users/{uid}/push/*, public/config, _private/**, unknown paths.
import { describe, expect, test } from 'vitest'
import { collection, deleteDoc, deleteField, doc, getDoc, getDocs, serverTimestamp, setDoc, Timestamp, updateDoc, type DocumentData } from 'firebase/firestore'
import { allDenied, allowed, denied, useRulesEnv } from './helpers.ts'

const { db, seed } = useRulesEnv()

const profile = (extra: DocumentData = {}): DocumentData => ({ name: 'Alex', color: '#8E8E93', createdAt: serverTimestamp(), ...extra })
const storedProfile = (name: string, extra: DocumentData = {}): DocumentData => ({
  name,
  color: '#636366',
  createdAt: Timestamp.fromMillis(Date.UTC(2026, 0, 1)),
  ...extra,
})

const JPEG = 'data:image/jpeg;base64,'
/** The start of a real JPEG, as the photo picker stores it. */
const PHOTO = `${JPEG}/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==`
/** A photo data URL exactly `chars` characters long. */
const photoOf = (chars: number): string => JPEG + 'A'.repeat(chars - JPEG.length)

const sub = (extra: DocumentData = {}): DocumentData => ({
  endpoint: 'https://web.push.apple.com/QGx1c2VyLXN1YnNjcmlwdGlvbg',
  keys: { p256dh: 'BOr8Y0aXyKk1yE5oDq1M0k3Hh3Kq2p4wQ', auth: 'k3Hh3Kq2p4wQ8Y0a' },
  createdAt: serverTimestamp(),
  ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)',
  ...extra,
})

describe('users/{uid}', () => {
  test('any signed-in user can get a profile; nobody lists all users; signed-out users cannot read', async () => {
    await seed({ 'users/bob': storedProfile('Bob') })
    await allowed(getDoc(doc(db('alice'), 'users/bob')))
    await allowed(getDoc(doc(db('alice'), 'users/nobody')))
    await denied(getDocs(collection(db('alice'), 'users')))
    await denied(getDoc(doc(db(), 'users/bob')))
  })

  test('owner creates a valid profile with a server timestamp', async () => {
    await allowed(setDoc(doc(db('alice'), 'users/alice'), profile()))
  })

  test('names count like JS .length: 40 Cyrillic characters are fine', async () => {
    await allowed(setDoc(doc(db('alice'), 'users/alice'), profile({ name: 'Ж'.repeat(40) })))
  })

  test('invalid profiles are rejected', async () => {
    const ref = doc(db('alice'), 'users/alice')
    await allDenied({
      'someone else': () => setDoc(doc(db('alice'), 'users/bob'), profile()),
      'signed out': () => setDoc(doc(db(), 'users/alice'), profile()),
      'empty name': () => setDoc(ref, profile({ name: '' })),
      'blank name': () => setDoc(ref, profile({ name: '   ' })),
      'name 41 chars': () => setDoc(ref, profile({ name: 'x'.repeat(41) })),
      'name not a string': () => setDoc(ref, profile({ name: 42 })),
      'color 33 chars': () => setDoc(ref, profile({ color: '#'.repeat(33) })),
      'color not a string': () => setDoc(ref, profile({ color: 0 })),
      'color a CSS url()': () => setDoc(ref, profile({ color: 'url(//x.co/a)' })),
      'color a named color': () => setDoc(ref, profile({ color: 'red' })),
      'color #RGB': () => setDoc(ref, profile({ color: '#fff' })),
      'color #RRGGBBAA': () => setDoc(ref, profile({ color: '#8E8E9380' })),
      'color not hex': () => setDoc(ref, profile({ color: '#GGGGGG' })),
      'color with a suffix': () => setDoc(ref, profile({ color: '#8E8E93;x' })),
      'client createdAt': () => setDoc(ref, profile({ createdAt: Timestamp.now() })),
      'extra key': () => setDoc(ref, profile({ admin: true })),
      'missing color': () => setDoc(ref, { name: 'Alex', createdAt: serverTimestamp() }),
    })
  })

  test('colors are #RRGGBB in either case', async () => {
    await allowed(setDoc(doc(db('alice'), 'users/alice'), profile({ color: '#aeaeb2' })))
    await allowed(setDoc(doc(db('bob'), 'users/bob'), profile({ color: '#AEAEB2' })))
  })

  test('owner can rename but not change createdAt; others cannot update', async () => {
    await seed({ 'users/alice': storedProfile('Alice') })
    const ref = doc(db('alice'), 'users/alice')
    await allowed(updateDoc(ref, { name: 'Alice B.' }))
    await allowed(updateDoc(ref, { color: '#AEAEB2' }))
    await allDenied({
      'createdAt changed': () => updateDoc(ref, { createdAt: serverTimestamp() }),
      'color a CSS url()': () => updateDoc(ref, { color: 'url(http://127.0.0.1:4580/p?u=b)' }),
      'name too long': () => updateDoc(ref, { name: 'x'.repeat(41) }),
      'extra key': () => updateDoc(ref, { email: 'a@b.c' }),
      'other user': () => updateDoc(doc(db('bob'), 'users/alice'), { name: 'Hacked' }),
    })
  })

  test('only the owner can delete the profile', async () => {
    await seed({ 'users/alice': storedProfile('Alice') })
    await denied(deleteDoc(doc(db('bob'), 'users/alice')))
    await allowed(deleteDoc(doc(db('alice'), 'users/alice')))
  })
})

describe('users/{uid}.photo', () => {
  test('owner creates a profile with a photo, then replaces and removes it; friends can read it', async () => {
    const ref = doc(db('alice'), 'users/alice')
    await allowed(setDoc(ref, profile({ photo: PHOTO })))
    await allowed(updateDoc(ref, { photo: `${JPEG}AAAA` }))
    await allowed(updateDoc(ref, { photo: photoOf(60_000) }))
    const seen = await getDoc(doc(db('bob'), 'users/alice'))
    expect(seen.get('photo')).toHaveLength(60_000)
    await allowed(updateDoc(ref, { photo: deleteField() }))
    expect((await getDoc(ref)).get('photo')).toBeUndefined()
  })

  test('only a small inline JPEG is accepted', async () => {
    const ref = doc(db('alice'), 'users/alice')
    const bad: Record<string, unknown> = {
      'too long': photoOf(60_001),
      'png': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
      'webp': 'data:image/webp;base64,UklGRhYAAABXRUJQ',
      'mime in capitals': 'data:image/JPEG;base64,/9j/4AAQ',
      'svg as base64': 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
      'svg as text': 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
      'not base64': 'data:image/jpeg,/9j/4AAQ',
      'extra parameter': 'data:image/jpeg;charset=utf-8;base64,/9j/4AAQ',
      'empty body': JPEG,
      'http URL': 'http://127.0.0.1:4580/p.jpg?u=alice',
      'https URL': 'https://example.com/me.jpg',
      'protocol-relative URL': '//example.com/me.jpg',
      'blob URL': 'blob:https://example.com/0b3c1a9e',
      'javascript URL': 'javascript:alert(1)',
      'text after the padding': `${PHOTO}AAAA`,
      'a quote and more': `${JPEG}AAAA" onerror="alert(1)`,
      'a newline': `${JPEG}AAAA\nAAAA`,
      'a space': `${JPEG}AAAA AAAA`,
      'url-safe base64': `${JPEG}AA-_AA`,
      'leading space': ` ${PHOTO}`,
      'empty string': '',
      'a number': 42,
      'null': null,
      'a boolean': true,
      'a map': { src: PHOTO },
      'a list': [PHOTO],
    }
    await allDenied(Object.fromEntries(Object.entries(bad).map(([name, photo]) => [`create, ${name}`, () => setDoc(ref, profile({ photo }))])))
    await seed({ 'users/alice': storedProfile('Alice') })
    await allDenied(Object.fromEntries(Object.entries(bad).map(([name, photo]) => [`update, ${name}`, () => updateDoc(ref, { photo })])))
  })

  test('nobody else can set, change or remove your photo', async () => {
    await seed({ 'users/alice': storedProfile('Alice', { photo: PHOTO }) })
    const bob = doc(db('bob'), 'users/alice')
    await allDenied({
      'set': () => updateDoc(bob, { photo: `${JPEG}BBBB` }),
      'remove': () => updateDoc(bob, { photo: deleteField() }),
      'replace the profile': () => setDoc(bob, storedProfile('Alice', { photo: `${JPEG}BBBB` })),
      'signed out': () => updateDoc(doc(db(), 'users/alice'), { photo: `${JPEG}BBBB` }),
    })
  })

  test('an older client that knows nothing of photos can still rename you and keeps the photo', async () => {
    await seed({ 'users/alice': storedProfile('Alice', { photo: PHOTO }) })
    const ref = doc(db('alice'), 'users/alice')
    // What updateMyName and sign-up's fallback write: the name alone.
    await allowed(updateDoc(ref, { name: 'Alice B.' }))
    await allowed(updateDoc(ref, { color: '#AEAEB2' }))
    const after = await getDoc(ref)
    expect(after.get('name')).toBe('Alice B.')
    expect(after.get('photo')).toBe(PHOTO)
    await allDenied({ 'rename with a bad photo alongside': () => updateDoc(ref, { name: 'Alice C.', photo: 'https://example.com/me.jpg' }) })
  })
})

describe('users/{uid}/push/{subId}', () => {
  test('owner creates, reads, lists, refreshes and deletes subscriptions', async () => {
    const ref = doc(db('alice'), 'users/alice/push/sub1')
    await allowed(setDoc(ref, sub()))
    await allowed(getDoc(ref))
    await allowed(getDocs(collection(db('alice'), 'users/alice/push')))
    await allowed(setDoc(ref, sub({ ua: 'Safari' })))
    await allowed(updateDoc(ref, { ua: 'Safari 26' }))
    await allowed(deleteDoc(ref))
  })

  test('endpoints of the real push services are accepted', async () => {
    const endpoints = [
      'https://web.push.apple.com/QGx1c2VyLXN1YnNjcmlwdGlvbg',
      'https://fcm.googleapis.com/fcm/send/dX1y2Z:APA91bH',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB',
    ]
    for (const [i, endpoint] of endpoints.entries()) await allowed(setDoc(doc(db('alice'), `users/alice/push/sub${i}`), sub({ endpoint })))
  })

  test('subscriptions are private to their owner', async () => {
    await seed({ 'users/alice/push/sub1': { ...sub(), createdAt: Timestamp.now() } })
    const bob = db('bob')
    await allDenied({
      'get': () => getDoc(doc(bob, 'users/alice/push/sub1')),
      'list': () => getDocs(collection(bob, 'users/alice/push')),
      'create': () => setDoc(doc(bob, 'users/alice/push/sub2'), sub()),
      'update': () => updateDoc(doc(bob, 'users/alice/push/sub1'), { ua: 'x' }),
      'delete': () => deleteDoc(doc(bob, 'users/alice/push/sub1')),
      'signed out get': () => getDoc(doc(db(), 'users/alice/push/sub1')),
    })
  })

  test('invalid subscriptions are rejected', async () => {
    const ref = doc(db('alice'), 'users/alice/push/sub1')
    await allDenied({
      'http endpoint': () => setDoc(ref, sub({ endpoint: 'http://web.push.apple.com/x' })),
      'any https host': () => setDoc(ref, sub({ endpoint: 'https://push.example.com/x' })),
      'lookalike host': () => setDoc(ref, sub({ endpoint: 'https://web.push.apple.com.evil.example/x' })),
      'host as userinfo': () => setDoc(ref, sub({ endpoint: 'https://fcm.googleapis.com@evil.example/x' })),
      'windows lookalike': () => setDoc(ref, sub({ endpoint: 'https://evil.example/notify.windows.com/x' })),
      'no path': () => setDoc(ref, sub({ endpoint: 'https://fcm.googleapis.com' })),
      'endpoint too long': () => setDoc(ref, sub({ endpoint: 'https://' + 'x'.repeat(1100) })),
      'keys extra field': () => setDoc(ref, sub({ keys: { p256dh: 'a', auth: 'b', x: 'c' } })),
      'keys missing auth': () => setDoc(ref, sub({ keys: { p256dh: 'a' } })),
      'keys not strings': () => setDoc(ref, sub({ keys: { p256dh: 1, auth: 2 } })),
      'ua too long': () => setDoc(ref, sub({ ua: 'x'.repeat(513) })),
      'client createdAt': () => setDoc(ref, sub({ createdAt: Timestamp.now() })),
      'extra key': () => setDoc(ref, sub({ expirationTime: null })),
    })
  })
})

describe('public/config and _private', () => {
  test('public/config: signed-in read only', async () => {
    await seed({ 'public/config': { vapidPublicKey: 'BPub' }, 'public/other': { x: 1 } })
    await allowed(getDoc(doc(db('alice'), 'public/config')))
    await allDenied({
      'signed out read': () => getDoc(doc(db(), 'public/config')),
      'write': () => setDoc(doc(db('alice'), 'public/config'), { vapidPublicKey: 'evil' }),
      'update': () => updateDoc(doc(db('alice'), 'public/config'), { vapidPublicKey: 'evil' }),
      'delete': () => deleteDoc(doc(db('alice'), 'public/config')),
      'list': () => getDocs(collection(db('alice'), 'public')),
      'other public doc': () => getDoc(doc(db('alice'), 'public/other')),
    })
  })

  test('_private is closed to clients', async () => {
    await seed({ '_private/vapid': { privateKey: 'secret' }, '_private/sent/log/k1': { at: 1 } })
    const alice = db('alice')
    await allDenied({
      'get vapid': () => getDoc(doc(alice, '_private/vapid')),
      'list _private': () => getDocs(collection(alice, '_private')),
      'get log': () => getDoc(doc(alice, '_private/sent/log/k1')),
      'write vapid': () => setDoc(doc(alice, '_private/vapid'), { privateKey: 'mine' }),
      'write log': () => setDoc(doc(alice, '_private/sent/log/k2'), { at: 2 }),
    })
  })

  test('unknown collections are denied', async () => {
    await allDenied({
      'read': () => getDoc(doc(db('alice'), 'misc/x')),
      'write': () => setDoc(doc(db('alice'), 'misc/x'), { a: 1 }),
    })
  })
})
