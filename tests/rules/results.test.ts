// spaces/{id}/results/{monthId} (SPEC §9.8): written once a month by the reminders job (admin), read
// by members, never written by clients.
import { describe, test } from 'vitest'
import { collection, deleteDoc, doc, getDoc, getDocs, orderBy, query, serverTimestamp, setDoc, Timestamp, updateDoc, limit } from 'firebase/firestore'
import { allDenied, allowed, denied, spaceDoc, ts, useRulesEnv } from './helpers.ts'

const { db, seed } = useRulesEnv()

const results = {
  monthId: '2026-10',
  completeAt: ts(Date.parse('2026-10-31T00:00:00+01:00')),
  members: { alice: { score: 93, passed: true, streak: 3, tierRuns: { '3': 3 } }, bob: { score: 84, passed: false, streak: 0 } },
  createdAt: Timestamp.now(),
}

describe('results', () => {
  test('members read a month\'s results and the latest one', async () => {
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob']), 'spaces/s1/results/2026-10': results })
    await allowed(getDoc(doc(db('bob'), 'spaces/s1/results/2026-10')))
    await allowed(getDoc(doc(db('bob'), 'spaces/s1/results/2026-11')))
    await allowed(getDocs(query(collection(db('alice'), 'spaces/s1/results'), orderBy('monthId', 'desc'), limit(1))))
  })

  test('non-members and signed-out users read nothing', async () => {
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob'], { leftAt: { carol: Timestamp.now() } }), 'spaces/s1/results/2026-10': results })
    await allDenied({
      'a stranger': () => getDoc(doc(db('zoe'), 'spaces/s1/results/2026-10')),
      'a former member': () => getDoc(doc(db('carol'), 'spaces/s1/results/2026-10')),
      'signed out': () => getDocs(collection(db(), 'spaces/s1/results')),
    })
  })

  test('no client writes them', async () => {
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob']), 'spaces/s1/results/2026-10': results })
    const alice = db('alice')
    await allDenied({
      'create': () => setDoc(doc(alice, 'spaces/s1/results/2026-11'), { ...results, monthId: '2026-11', createdAt: serverTimestamp() }),
      'update a streak': () => updateDoc(doc(alice, 'spaces/s1/results/2026-10'), { 'members.bob.streak': 4 }),
      'overwrite': () => setDoc(doc(alice, 'spaces/s1/results/2026-10'), results),
      'delete': () => deleteDoc(doc(alice, 'spaces/s1/results/2026-10')),
    })
    await denied(setDoc(doc(db('zoe'), 'spaces/s1/results/2026-12'), results))
  })
})
