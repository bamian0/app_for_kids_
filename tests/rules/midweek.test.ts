// weeks/{weekId}/plans/{uid} after the lock: one task at a time until the review window opens, with
// its add time in `added` (SPEC §6.2).
import { describe, test } from 'vitest'
import {
  arrayUnion, deleteDoc, doc, runTransaction, serverTimestamp, setDoc, Timestamp, updateDoc, type DocumentData,
  type Firestore,
} from 'firebase/firestore'
import { allDenied, allowed, DAY, denied, fullTask, HOUR, spaceDoc, ts, useRulesEnv, weekDoc, type Phase } from './helpers.ts'

const { db, seed } = useRulesEnv()

const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: `Task ${i + 1}` }))
const planRef = (fs: Firestore, uid: string) => doc(fs, `spaces/s1/weeks/W/plans/${uid}`)
const late = (id = 'late1', extra: DocumentData = {}): DocumentData => ({ id, title: 'Color grade the reel', ...extra })

/** What addTaskAfterLock writes: the stored list and add times back as they are, plus one task. */
const append = (fs: Firestore, uid: string, task: DocumentData) =>
  runTransaction(fs, async (tx) => {
    const snap = await tx.get(planRef(fs, uid))
    tx.set(planRef(fs, uid), {
      tasks: [...(snap.get('tasks') ?? []), task],
      added: { ...(snap.get('added') ?? {}), [task.id]: serverTimestamp() },
      updatedAt: serverTimestamp(),
    })
  })

// Alice's list as it locked, plus one task she added on Tuesday.
const LOCKED = [...tasks(2), { id: 't2', title: 'Edit the reel', subs: ['s1|Rough cut', 's2|Color'] }]
const STORED = [...LOCKED, { id: 'late0', title: 'Call the client' }]
const STORED_ADDED = { late0: ts(Date.now() - DAY + HOUR) }

/** Space s1 = alice, bob, carol; week W in `phase` with alice, bob and dave (who left the space) taking part. */
async function setup(phase: Phase, week: DocumentData = weekDoc(phase, ['alice', 'bob', 'dave'])) {
  await seed({
    'spaces/s1': spaceDoc(['alice', 'bob', 'carol']),
    'spaces/s1/weeks/W': week,
    'spaces/s1/weeks/W/plans/alice': { tasks: STORED, added: STORED_ADDED, updatedAt: ts(Date.now() - DAY + HOUR) },
  })
}

/** A write of alice's plan built from the stored one: `tasks` and `added` as given. */
const write = (tasksAfter: DocumentData[], addedAfter: DocumentData, extra: DocumentData = {}) =>
  setDoc(planRef(db('alice'), 'alice'), { tasks: tasksAfter, added: addedAfter, updatedAt: serverTimestamp(), ...extra })
const now = () => serverTimestamp()

describe('plans after the lock', () => {
  test('a participant appends tasks one at a time, with or without steps', async () => {
    await setup('active')
    const alice = db('alice')
    await allowed(append(alice, 'alice', late('late1', { subs: ['s3|Pick the grade', 's4|Export'] })))
    await allowed(append(alice, 'alice', late('late2')))
    // The same append as a merge: arrayUnion and a dotted field.
    await allowed(updateDoc(planRef(alice, 'alice'), {
      tasks: arrayUnion(late('late3')), 'added.late3': serverTimestamp(), updatedAt: serverTimestamp(),
    }))
  })

  test('a participant with no plan at the lock starts one with a single task', async () => {
    await setup('active')
    const bob = db('bob')
    await allowed(setDoc(planRef(bob, 'bob'), { tasks: [late()], added: { late1: serverTimestamp() }, updatedAt: serverTimestamp() }))
    await allowed(append(bob, 'bob', late('late2', { subs: ['s1|Draft'] })))
  })

  test('appending opens right at lockAt', async () => {
    const start = Date.now() - DAY - 1000
    await setup('active', { ...weekDoc('active', ['alice', 'bob']), startAt: ts(start), lockAt: ts(start + DAY), reviewOpenAt: ts(start + 4 * DAY), deadlineAt: ts(start + 5 * DAY) })
    await allowed(append(db('alice'), 'alice', late()))
  })

  test('appending a full task onto 24 full tasks stays within rule limits', async () => {
    await setup('active')
    const full = Array.from({ length: 24 }, (_, i) => fullTask(i))
    await seed({
      'spaces/s1/weeks/W/plans/alice': {
        tasks: full, added: { [full[23].id]: ts(Date.now() - HOUR) }, updatedAt: ts(Date.now() - HOUR),
      },
    })
    await allowed(append(db('alice'), 'alice', fullTask(24)))
  })

  test('25 tasks is the most, added ones included', async () => {
    await setup('active')
    await seed({ 'spaces/s1/weeks/W/plans/alice': { tasks: tasks(25), updatedAt: Timestamp.now() } })
    await denied(append(db('alice'), 'alice', late()))
  })

  test('nothing else about the plan can change in an append', async () => {
    await setup('active')
    const [t0, t1, t2, late0] = STORED
    await allDenied({
      'two tasks at once': () => write([...STORED, late('a'), late('b')], { ...STORED_ADDED, a: now(), b: now() }),
      'two tasks, one added time': () => write([...STORED, late('a'), late('b')], { ...STORED_ADDED, b: now() }),
      'a task renamed': () => write([{ ...t0, title: 'Easier task' }, t1, t2, late0, late()], { ...STORED_ADDED, late1: now() }),
      'steps added to a task': () => write([t0, t1, { ...t2, subs: ['s1|Rough cut'] }, late0, late()], { ...STORED_ADDED, late1: now() }),
      'tasks reordered': () => write([t1, t0, t2, late0, late()], { ...STORED_ADDED, late1: now() }),
      'a task removed': () => write([t0, t2, late0, late()], { ...STORED_ADDED, late1: now() }),
      'an added task removed': () => write([t0, t1, t2, late()], { late1: now() }),
      'the last task replaced': () => write([t0, t1, t2, late()], { ...STORED_ADDED, late1: now() }),
      'no new task': () => write(STORED, STORED_ADDED),
      'added time from the client': () => write([...STORED, late()], { ...STORED_ADDED, late1: Timestamp.now() }),
      'added time missing': () => write([...STORED, late()], STORED_ADDED),
      'added time under another id': () => write([...STORED, late()], { ...STORED_ADDED, other: now() }),
      'an extra added time': () => write([...STORED, late()], { ...STORED_ADDED, late1: now(), other: now() }),
      'an earlier added time rewritten': () => write([...STORED, late()], { late0: now(), late1: now() }),
      'an earlier added time dropped': () => write([...STORED, late()], { late1: now() }),
      'a task added before re-added': () => write([...STORED, late('late0')], { ...STORED_ADDED, late0: now() }),
      'added not a map': () => write([...STORED, late()], ['late0', 'late1'] as unknown as DocumentData),
      'without added': () => setDoc(planRef(db('alice'), 'alice'), { tasks: [...STORED, late()], updatedAt: now() }),
      'extra key': () => write([...STORED, late()], { ...STORED_ADDED, late1: now() }, { note: 'hi' }),
      'client updatedAt': () => write([...STORED, late()], { ...STORED_ADDED, late1: now() }, { updatedAt: Timestamp.now() }),
      'new task with 9 steps': () =>
        write([...STORED, late('late1', { subs: Array.from({ length: 9 }, (_, i) => `s${i}|Step`) })], { ...STORED_ADDED, late1: now() }),
      'new task with an empty title': () => write([...STORED, late('late1', { title: '' })], { ...STORED_ADDED, late1: now() }),
      'new task with a bad id': () => write([...STORED, late('late.1')], { ...STORED_ADDED, 'late.1': now() }),
      'new task with an extra key': () => write([...STORED, late('late1', { done: true })], { ...STORED_ADDED, late1: now() }),
      'deleting the plan': () => deleteDoc(planRef(db('alice'), 'alice')),
    })
    // Each case above is this write with one thing wrong.
    await allowed(write([...STORED, late()], { ...STORED_ADDED, late1: now() }))
  })

  test('a new plan after the lock holds exactly one task', async () => {
    await setup('active')
    const ref = planRef(db('bob'), 'bob')
    await allDenied({
      'no tasks': () => setDoc(ref, { tasks: [], added: {}, updatedAt: now() }),
      'two tasks': () => setDoc(ref, { tasks: [late('a'), late('b')], added: { a: now(), b: now() }, updatedAt: now() }),
      'no added time': () => setDoc(ref, { tasks: [late()], added: {}, updatedAt: now() }),
      'added time from the client': () => setDoc(ref, { tasks: [late()], added: { late1: Timestamp.now() }, updatedAt: now() }),
      'without added': () => setDoc(ref, { tasks: [late()], updatedAt: now() }),
    })
    await allowed(setDoc(ref, { tasks: [late()], added: { late1: now() }, updatedAt: now() }))
  })

  test('only the owner, still a participant and a space member, appends', async () => {
    await setup('active')
    const task = late()
    await allDenied({
      'someone else\'s plan': () => append(db('bob'), 'alice', task),
      'someone else\'s new plan': () =>
        setDoc(planRef(db('alice'), 'bob'), { tasks: [task], added: { late1: now() }, updatedAt: now() }),
      'not a participant': () => append(db('carol'), 'carol', task),
      'left the space': () => append(db('dave'), 'dave', task),
      'signed out': () => setDoc(planRef(db(), 'alice'), { tasks: [...STORED, task], added: { ...STORED_ADDED, late1: now() }, updatedAt: now() }),
    })
  })

  test('appending closes when the review window opens, and is not how lists are planned', async () => {
    const reviewOpened = Date.now() - 4 * DAY - 1000
    for (const week of [
      weekDoc('planning', ['alice', 'bob', 'dave']),
      { ...weekDoc('review', ['alice', 'bob', 'dave']), startAt: ts(reviewOpened), lockAt: ts(reviewOpened + DAY), reviewOpenAt: ts(reviewOpened + 4 * DAY), deadlineAt: ts(reviewOpened + 5 * DAY) },
      weekDoc('review', ['alice', 'bob', 'dave']),
      weekDoc('closed', ['alice', 'bob', 'dave']),
    ]) {
      await setup('active', week)
      await allDenied({
        'append': () => append(db('alice'), 'alice', late()),
        'new plan': () => setDoc(planRef(db('bob'), 'bob'), { tasks: [late()], added: { late1: now() }, updatedAt: now() }),
      })
    }
  })
})
