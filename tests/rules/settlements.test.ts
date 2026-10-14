// spaces/{id}/settlements: honor-system "Settled" toggles, per member (older clients), per pair and per
// streak reward (SPEC §9.7).
import { describe, test } from 'vitest'
import { collection, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp, setDoc, Timestamp, where, writeBatch, type DocumentData, type Firestore } from 'firebase/firestore'
import { allDenied, allowed, denied, spaceDoc, useRulesEnv } from './helpers.ts'

const { db, seed } = useRulesEnv()

const settlement = (uid: string, by: string, extra: DocumentData = {}): DocumentData => ({
  monthId: '2026-10', uid, settled: true, settledBy: by, settledAt: serverTimestamp(), ...extra,
})
const ref = (fs: Firestore, id: string) => doc(fs, `spaces/s1/settlements/${id}`)

describe('settlements', () => {
  test('any member toggles a member\'s settlement on and off', async () => {
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob']) })
    await allowed(setDoc(ref(db('alice'), '2026-10_bob'), settlement('bob', 'alice')))
    await allowed(setDoc(ref(db('bob'), '2026-10_bob'), settlement('bob', 'bob', { settled: false })))
    await allowed(setDoc(ref(db('bob'), '2026-10_alice'), settlement('alice', 'bob')))
  })

  test('members settle up for someone who has left the space', async () => {
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob'], { leftAt: { carol: Timestamp.now() } }) })
    await allowed(setDoc(ref(db('alice'), '2026-10_carol'), settlement('carol', 'alice')))
    await denied(setDoc(ref(db('carol'), '2026-10_carol'), settlement('carol', 'carol')))
  })

  test('invalid settlements are rejected', async () => {
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob']) })
    const alice = db('alice')
    await allDenied({
      'settledBy someone else': () => setDoc(ref(alice, '2026-10_bob'), settlement('bob', 'bob')),
      'client settledAt': () => setDoc(ref(alice, '2026-10_bob'), settlement('bob', 'alice', { settledAt: Timestamp.now() })),
      'uid not a member': () => setDoc(ref(alice, '2026-10_zoe'), settlement('zoe', 'alice')),
      'id month mismatch': () => setDoc(ref(alice, '2026-09_bob'), settlement('bob', 'alice')),
      'id uid mismatch': () => setDoc(ref(alice, '2026-10_alice'), settlement('bob', 'alice')),
      'bad monthId': () => setDoc(ref(alice, '2026-13_bob'), settlement('bob', 'alice', { monthId: '2026-13' })),
      'settled not a bool': () => setDoc(ref(alice, '2026-10_bob'), settlement('bob', 'alice', { settled: 'yes' })),
      'extra key': () => setDoc(ref(alice, '2026-10_bob'), settlement('bob', 'alice', { amount: 20 })),
      'non-member writes': () => setDoc(ref(db('zoe'), '2026-10_bob'), settlement('bob', 'zoe')),
      'signed out': () => setDoc(ref(db(), '2026-10_bob'), settlement('bob', 'alice')),
    })
  })

  test('members read and list; non-members cannot; nobody deletes', async () => {
    await seed({
      'spaces/s1': spaceDoc(['alice', 'bob']),
      'spaces/s1/settlements/2026-10_bob': { ...settlement('bob', 'alice'), settledAt: Timestamp.now() },
    })
    await allowed(getDoc(ref(db('bob'), '2026-10_bob')))
    await allowed(getDocs(collection(db('alice'), 'spaces/s1/settlements')))
    await denied(getDoc(ref(db('zoe'), '2026-10_bob')))
    await denied(getDocs(collection(db('zoe'), 'spaces/s1/settlements')))
    await denied(deleteDoc(ref(db('alice'), '2026-10_bob')))
  })
})

describe('settlements per pair and per streak reward', () => {
  const pair = (uid: string, other: string, by: string, extra: DocumentData = {}): DocumentData =>
    settlement(uid, by, { other, ...extra })

  test('a pair, a streak reward, and a pair with someone who left', async () => {
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob', 'carol'], { leftAt: { dave: Timestamp.now() } }) })
    await allowed(setDoc(ref(db('alice'), '2026-10_bob_alice'), pair('bob', 'alice', 'alice')))
    await allowed(setDoc(ref(db('bob'), '2026-10_bob_alice'), pair('bob', 'alice', 'bob', { settled: false })))
    await allowed(setDoc(ref(db('alice'), '2026-10_alice_bob_s3'), pair('alice', 'bob', 'alice', { tier: 3 })))
    await allowed(setDoc(ref(db('alice'), '2026-10_alice_bob_s36'), pair('alice', 'bob', 'alice', { tier: 36 })))
    // dave left: he can still be owed, and still owe.
    await allowed(setDoc(ref(db('carol'), '2026-10_carol_dave'), pair('carol', 'dave', 'carol')))
    await allowed(setDoc(ref(db('carol'), '2026-10_dave_carol'), pair('dave', 'carol', 'carol')))
    // The legacy per-member doc keeps working next to them.
    await allowed(setDoc(ref(db('carol'), '2026-10_bob'), settlement('bob', 'carol')))
  })

  test('a group line of 7 is one batch', async () => {
    const eight = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8']
    await seed({ 'spaces/s1': spaceDoc(eight) })
    const m1 = db('m1')
    const batch = writeBatch(m1)
    for (const other of eight.slice(1)) batch.set(ref(m1, `2026-10_${other}_m1`), pair(other, 'm1', 'm1'))
    await allowed(batch.commit())
    const month = query(collection(m1, 'spaces/s1/settlements'), where('monthId', '==', '2026-10'))
    await allowed(getDocs(month))
  })

  test('invalid pair and streak docs are refused', async () => {
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob', 'carol']) })
    const alice = db('alice')
    const set = (id: string, d: DocumentData) => () => setDoc(ref(alice, id), d)
    await allDenied({
      'other is the subject': set('2026-10_bob_bob', pair('bob', 'bob', 'alice')),
      'other not a member': set('2026-10_bob_zoe', pair('bob', 'zoe', 'alice')),
      'other not a string': set('2026-10_bob_1', settlement('bob', 'alice', { other: 1 })),
      'id without the other': set('2026-10_bob', pair('bob', 'alice', 'alice')),
      'id with another other': set('2026-10_bob_carol', pair('bob', 'alice', 'alice')),
      'id without the tier': set('2026-10_bob_alice', pair('bob', 'alice', 'alice', { tier: 3 })),
      'id with another tier': set('2026-10_bob_alice_s6', pair('bob', 'alice', 'alice', { tier: 3 })),
      'a tier in the id only': set('2026-10_bob_alice_s3', pair('bob', 'alice', 'alice')),
      'a 1-month tier': set('2026-10_bob_alice_s1', pair('bob', 'alice', 'alice', { tier: 1 })),
      'a 37-month tier': set('2026-10_bob_alice_s37', pair('bob', 'alice', 'alice', { tier: 37 })),
      'a fractional tier': set('2026-10_bob_alice_s2.5', pair('bob', 'alice', 'alice', { tier: 2.5 })),
      'a tier as a string': set('2026-10_bob_alice_s3', pair('bob', 'alice', 'alice', { tier: '3' })),
      'a tier without other': set('2026-10_bob_s3', settlement('bob', 'alice', { tier: 3 })),
      'an extra key': set('2026-10_bob_alice', pair('bob', 'alice', 'alice', { what: 'Dinner' })),
      'settledBy someone else': set('2026-10_bob_alice', pair('bob', 'alice', 'bob')),
      'a client settledAt': set('2026-10_bob_alice', pair('bob', 'alice', 'alice', { settledAt: Timestamp.now() })),
      'a non-member writes': () => setDoc(ref(db('zoe'), '2026-10_bob_alice'), pair('bob', 'alice', 'zoe')),
    })
  })
})

