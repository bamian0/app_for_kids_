// weeks/{weekId}/plans/{uid} and weeks/{weekId}/progress/{uid}.
import { describe, test } from 'vitest'
import {
  arrayUnion, collection, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc, Timestamp, updateDoc,
  writeBatch, type DocumentData, type Firestore,
} from 'firebase/firestore'
import { allDenied, allowed, denied, spaceDoc, useRulesEnv, weekDoc, type Phase } from './helpers.ts'

const { db, seed } = useRulesEnv()

const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: `Task ${i + 1}` }))
const plan = (extra: DocumentData = {}): DocumentData => ({ tasks: tasks(3), updatedAt: serverTimestamp(), ...extra })
const planRef = (fs: Firestore, uid: string, week = 'W') => doc(fs, `spaces/s1/weeks/${week}/plans/${uid}`)
const progressRef = (fs: Firestore, uid: string, week = 'W') => doc(fs, `spaces/s1/weeks/${week}/progress/${uid}`)
const tick = (fs: Firestore, uid: string, taskId: string, done: unknown, week = 'W') =>
  setDoc(progressRef(fs, uid, week), { done: { [taskId]: done }, updatedAt: serverTimestamp() }, { merge: true })

/** Space s1 = alice, bob, carol; week W in `phase` with alice and bob participating; dave is a participant who left the space. */
const setup = (phase: Phase) =>
  seed({ 'spaces/s1': spaceDoc(['alice', 'bob', 'carol']), 'spaces/s1/weeks/W': weekDoc(phase, ['alice', 'bob', 'dave']) })

describe('plans', () => {
  test('a participant saves and replaces their plan before lockAt', async () => {
    await setup('planning')
    const alice = db('alice')
    await allowed(setDoc(planRef(alice, 'alice'), plan()))
    await allowed(setDoc(planRef(alice, 'alice'), plan({ tasks: tasks(25) })))
    await allowed(setDoc(planRef(alice, 'alice'), plan({ tasks: [] })))
    await allowed(setDoc(planRef(alice, 'alice'), plan({ tasks: [{ id: 'x1', title: 'Ж'.repeat(120) }] })))
    await allowed(deleteDoc(planRef(alice, 'alice')))
  })

  test('invalid plans are rejected', async () => {
    await setup('planning')
    const ref = planRef(db('alice'), 'alice')
    await allDenied({
      '26 tasks': () => setDoc(ref, plan({ tasks: tasks(26) })),
      'tasks is a map': () => setDoc(ref, plan({ tasks: { t0: 'Edit reel' } })),
      'empty title': () => setDoc(ref, plan({ tasks: [{ id: 't1', title: '' }] })),
      'title 121 chars': () => setDoc(ref, plan({ tasks: [{ id: 't1', title: 'x'.repeat(121) }] })),
      'bad last task': () => setDoc(ref, plan({ tasks: [...tasks(24), { id: 't24', title: '' }] })),
      'task extra key': () => setDoc(ref, plan({ tasks: [{ id: 't1', title: 'Edit', done: true }] })),
      'task missing id': () => setDoc(ref, plan({ tasks: [{ title: 'Edit' }] })),
      'task id empty': () => setDoc(ref, plan({ tasks: [{ id: '', title: 'Edit' }] })),
      'task id 65 chars': () => setDoc(ref, plan({ tasks: [{ id: 'a'.repeat(65), title: 'Edit' }] })),
      'task id with a dot': () => setDoc(ref, plan({ tasks: [{ id: 'a.b', title: 'Edit' }] })),
      'title is a number': () => setDoc(ref, plan({ tasks: [{ id: 't1', title: 7 }] })),
      'title is a map': () => setDoc(ref, plan({ tasks: [{ id: 't1', title: { text: 'Edit' } }] })),
      'task is a string': () => setDoc(ref, plan({ tasks: ['Edit'] })),
      'client updatedAt': () => setDoc(ref, plan({ updatedAt: Timestamp.now() })),
      'extra key': () => setDoc(ref, plan({ note: 'hi' })),
    })
  })

  test('a locked plan cannot be edited', async () => {
    await setup('active')
    const alice = db('alice')
    await denied(setDoc(planRef(alice, 'alice'), plan()))
    await denied(updateDoc(planRef(alice, 'alice'), { tasks: [], updatedAt: serverTimestamp() }))
    await denied(deleteDoc(planRef(alice, 'alice')))
  })

  test('only the owner, if a participant and space member, writes', async () => {
    await setup('planning')
    await allDenied({
      'someone else\'s plan': () => setDoc(planRef(db('bob'), 'alice'), plan()),
      'not a participant': () => setDoc(planRef(db('carol'), 'carol'), plan()),
      'left the space': () => setDoc(planRef(db('dave'), 'dave'), plan()),
      'signed out': () => setDoc(planRef(db(), 'alice'), plan()),
      'week missing': () => setDoc(planRef(db('alice'), 'alice', 'nope'), plan()),
    })
  })

  test('joining the week and saving a full plan in one batch stays within rule limits', async () => {
    await setup('planning')
    const carol = db('carol')
    const full = Array.from({ length: 25 }, (_, i) => ({ id: `k${i}abcdefgh`, title: 'Ж'.repeat(120) }))
    const batch = writeBatch(carol)
    batch.update(doc(carol, 'spaces/s1/weeks/W'), { members: arrayUnion('carol') })
    batch.set(planRef(carol, 'carol'), plan({ tasks: full }))
    await allowed(batch.commit())
  })

  test('space members read plans; others do not', async () => {
    await setup('active')
    await seed({ 'spaces/s1/weeks/W/plans/alice': { tasks: tasks(2), updatedAt: Timestamp.now() } })
    await allowed(getDoc(planRef(db('carol'), 'alice')))
    await allowed(getDocs(collection(db('bob'), 'spaces/s1/weeks/W/plans')))
    await denied(getDoc(planRef(db('zoe'), 'alice')))
    await denied(getDocs(collection(db('zoe'), 'spaces/s1/weeks/W/plans')))
    await denied(getDoc(planRef(db('dave'), 'alice')))
  })
})

describe('progress', () => {
  test('a participant ticks tasks with merge until deadlineAt', async () => {
    for (const phase of ['planning', 'active', 'review'] as const) {
      await setup(phase)
      const alice = db('alice')
      await allowed(tick(alice, 'alice', 't1', true))
      await allowed(tick(alice, 'alice', 't2', true))
      await allowed(tick(alice, 'alice', 't1', false))
    }
  })

  test('no ticking after deadlineAt', async () => {
    await setup('closed')
    await denied(tick(db('alice'), 'alice', 't1', true))
  })

  test('invalid progress writes are rejected', async () => {
    await setup('active')
    await seed({
      'spaces/s1/weeks/W/progress/bob': {
        done: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`t${i}`, true])),
        updatedAt: Timestamp.now(),
      },
    })
    const alice = db('alice')
    await allDenied({
      'value not a bool': () => tick(alice, 'alice', 't1', 1),
      'value a string': () => tick(alice, 'alice', 't1', 'yes'),
      'client updatedAt': () => setDoc(progressRef(alice, 'alice'), { done: { t1: true }, updatedAt: Timestamp.now() }),
      'done not a map': () => setDoc(progressRef(alice, 'alice'), { done: ['t1'], updatedAt: serverTimestamp() }),
      'extra key': () => setDoc(progressRef(alice, 'alice'), { done: {}, updatedAt: serverTimestamp(), streak: 3 }),
      'more than 200 entries': () => tick(db('bob'), 'bob', 'one-too-many', true),
      'someone else\'s progress': () => tick(db('bob'), 'alice', 't1', true),
      'not a participant': () => tick(db('carol'), 'carol', 't1', true),
      'left the space': () => tick(db('dave'), 'dave', 't1', true),
      'signed out': () => tick(db(), 'alice', 't1', true),
    })
  })

  test('space members read progress; others do not', async () => {
    await setup('active')
    await seed({ 'spaces/s1/weeks/W/progress/alice': { done: { t1: true }, updatedAt: Timestamp.now() } })
    await allowed(getDoc(progressRef(db('carol'), 'alice')))
    await allowed(getDocs(collection(db('bob'), 'spaces/s1/weeks/W/progress')))
    await denied(getDoc(progressRef(db('zoe'), 'alice')))
    await denied(getDocs(collection(db('zoe'), 'spaces/s1/weeks/W/progress')))
  })
})
