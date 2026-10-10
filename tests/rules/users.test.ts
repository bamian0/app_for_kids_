// users/{uid}, users/{uid}/push/*, public/config, _private/**, unknown paths.
import { describe, test } from 'vitest'
import { collection, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc, Timestamp, updateDoc, type DocumentData } from 'firebase/firestore'
import { allDenied, allowed, denied, useRulesEnv } from './helpers.ts'

const { db, seed } = useRulesEnv()

const profile = (extra: DocumentData = {}): DocumentData => ({ name: 'Alex', color: '#8E8E93', createdAt: serverTimestamp(), ...extra })
const storedProfile = (name: string): DocumentData => ({ name, color: '#636366', createdAt: Timestamp.fromMillis(Date.UTC(2026, 0, 1)) })

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
      'client createdAt': () => setDoc(ref, profile({ createdAt: Timestamp.now() })),
      'extra key': () => setDoc(ref, profile({ admin: true })),
      'missing color': () => setDoc(ref, { name: 'Alex', createdAt: serverTimestamp() }),
    })
  })

  test('owner can rename but not change createdAt; others cannot update', async () => {
    await seed({ 'users/alice': storedProfile('Alice') })
    const ref = doc(db('alice'), 'users/alice')
    await allowed(updateDoc(ref, { name: 'Alice B.' }))
    await allowed(updateDoc(ref, { color: '#AEAEB2' }))
    await allDenied({
      'createdAt changed': () => updateDoc(ref, { createdAt: serverTimestamp() }),
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
      'http endpoint': () => setDoc(ref, sub({ endpoint: 'http://push.example.com/x' })),
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
