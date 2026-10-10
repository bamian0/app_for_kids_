// spaces/{id}/settlements/{monthId}_{uid}: honor-system "Settled" toggles.
import { describe, test } from 'vitest'
import { collection, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc, Timestamp, type DocumentData, type Firestore } from 'firebase/firestore'
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
