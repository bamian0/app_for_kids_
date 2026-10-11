// spaces/{id}/months/{monthId}: each month's stakes, frozen once by any member.
import { describe, test } from 'vitest'
import { DateTime } from 'luxon'
import { collection, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc, Timestamp, updateDoc, type DocumentData, type Firestore } from 'firebase/firestore'
import { allDenied, allowed, denied, spaceDoc, useRulesEnv } from './helpers.ts'

const { db, seed } = useRulesEnv()

const stakes = (extra: DocumentData = {}): DocumentData => ({
  reward: 'Dinner on me', penalty: 'You buy coffee for a week', createdAt: serverTimestamp(), ...extra,
})
const ref = (fs: Firestore, monthId: string, space = 's1') => doc(fs, `spaces/${space}/months/${monthId}`)
const monthOf = (dt: DateTime) => dt.toUTC().toFormat('yyyy-MM')
const now = () => DateTime.utc()

describe('months', () => {
  test('a member freezes the space\'s current stakes for the month in play', async () => {
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob']), 'spaces/s2': spaceDoc(['alice']), 'spaces/s3': spaceDoc(['alice']) })
    await allowed(setDoc(ref(db('bob'), monthOf(now())), stakes()))
    // The month of the current week (its Friday is −3d … +5d away, in any zone) can be frozen too.
    await allowed(setDoc(ref(db('alice'), monthOf(now().plus({ days: 5 })), 's2'), stakes()))
    await allowed(setDoc(ref(db('alice'), monthOf(now().minus({ days: 3 })), 's3'), stakes()))
  })

  test('a frozen month never changes', async () => {
    const m = monthOf(now())
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob']), [`spaces/s1/months/${m}`]: { ...stakes(), createdAt: Timestamp.now() } })
    await allDenied({
      'update': () => updateDoc(ref(db('alice'), m), { penalty: 'A high five' }),
      'overwrite with the same stakes': () => setDoc(ref(db('alice'), m), stakes()),
      'delete': () => deleteDoc(ref(db('alice'), m)),
    })
  })

  test('invalid snapshots are rejected', async () => {
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob']) })
    const alice = db('alice')
    const m = monthOf(now())
    await allDenied({
      'reward not the space\'s': () => setDoc(ref(alice, m), stakes({ reward: 'A high five' })),
      'penalty not the space\'s': () => setDoc(ref(alice, m), stakes({ penalty: 'Nothing' })),
      'a finished month': () => setDoc(ref(alice, monthOf(now().minus({ months: 1, days: 4 }))), stakes()),
      'months ahead': () => setDoc(ref(alice, monthOf(now().plus({ months: 1, days: 6 }))), stakes()),
      'bad month id': () => setDoc(ref(alice, `${m}-01`), stakes()),
      'month 13': () => setDoc(ref(alice, `${m.slice(0, 4)}-13`), stakes()),
      'client createdAt': () => setDoc(ref(alice, m), stakes({ createdAt: Timestamp.now() })),
      'extra key': () => setDoc(ref(alice, m), stakes({ note: 'agreed' })),
      'missing penalty': () => setDoc(ref(alice, m), { reward: 'Dinner on me', createdAt: serverTimestamp() }),
      'non-member': () => setDoc(ref(db('zoe'), m), stakes()),
      'signed out': () => setDoc(ref(db(), m), stakes()),
    })
  })

  test('members read; others do not', async () => {
    const m = monthOf(now())
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob']), [`spaces/s1/months/${m}`]: { ...stakes(), createdAt: Timestamp.now() } })
    await allowed(getDoc(ref(db('bob'), m)))
    await allowed(getDocs(collection(db('bob'), 'spaces/s1/months')))
    await denied(getDoc(ref(db('zoe'), m)))
    await denied(getDoc(ref(db(), m)))
  })
})
