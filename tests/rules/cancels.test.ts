// Crossing out a task and undoing that (SPEC §10.3, §10.7): the cancels log on a week's or a monthly
// list's plan. Every change adds one key "<n>:<taskId>" (odd {at, why}, even {at}) with the server time.
import { describe, test } from 'vitest'
import {
  deleteDoc, deleteField, doc, FieldPath, getDoc, serverTimestamp, setDoc, Timestamp, updateDoc, writeBatch,
  type DocumentData, type Firestore,
} from 'firebase/firestore'
import {
  allDenied, allowed, DAY, denied, fullTask, HOUR, monthlyDoc, spaceDoc, ts, useRulesEnv, weekDoc, type Phase,
} from './helpers.ts'

const { db, seed } = useRulesEnv()

type Coll = 'weeks' | 'monthly'
const PERIODS: Array<{ coll: Coll; id: string; name: string }> = [
  { coll: 'weeks', id: 'W', name: 'a week' },
  { coll: 'monthly', id: '2026-10', name: 'a monthly list' },
]

const PLAYERS = ['alice', 'bob', 'dave', 'jude'] // dave left the space after the lock; jude judges
const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: `Task ${i + 1}` }))
const WHY = 'The pool is closed all week'
const earlier = () => ts(Date.now() - HOUR)
/** Log entries 1…upto for each id, written an hour ago. */
const log = (ids: string[], upto: number, why = WHY): DocumentData => {
  const out: DocumentData = {}
  for (const id of ids) for (let n = 1; n <= upto; n++) out[`${n}:${id}`] = n % 2 ? { at: earlier(), why } : { at: earlier() }
  return out
}

function periodDoc(coll: Coll, phase: Phase, extra: DocumentData = {}): DocumentData {
  const d = coll === 'weeks' ? { ...weekDoc(phase, PLAYERS), judges: ['jude'] } : monthlyDoc(phase, PLAYERS, ['jude'])
  return { ...d, ...extra }
}

/** A period whose lock or review opening was a second ago (request.time is real time). */
function periodAt(coll: Coll, bound: 'lockAt' | 'reviewOpenAt'): DocumentData {
  const start = bound === 'lockAt' ? Date.now() - DAY - 1000 : Date.now() - 4 * DAY - 1000
  return periodDoc(coll, 'active', { startAt: ts(start), lockAt: ts(start + DAY), reviewOpenAt: ts(start + 4 * DAY), deadlineAt: ts(start + 5 * DAY) })
}

describe.each(PERIODS)('cross out on $name', ({ coll, id }) => {
  const period = `spaces/s1/${coll}/${id}`
  const planPath = (uid: string) => `${period}/plans/${uid}`
  const planRef = (fs: Firestore, uid: string) => doc(fs, planPath(uid))

  /** Space s1 = alice, bob, carol, jude; the period in `phase` with alice, bob, dave (who left) and
   *  jude (its judge). alice's plan: three tasks, the last added after the lock, plus `cancels`. */
  async function setup(phase: Phase | DocumentData, cancels?: DocumentData, plan: DocumentData = {}) {
    await seed({
      'spaces/s1': spaceDoc(['alice', 'bob', 'carol', 'jude'], { judges: ['jude'] }),
      [period]: typeof phase === 'string' ? periodDoc(coll, phase) : phase,
      [planPath('alice')]: {
        tasks: tasks(3), added: { t2: earlier() }, updatedAt: ts(Date.now() - DAY + HOUR),
        ...(cancels ? { cancels } : {}), ...plan,
      },
    })
  }

  /** What crossOutTask / undoCrossOut write: one log entry and updatedAt. */
  const change = (uid: string, key: string, value: DocumentData, owner = uid) =>
    updateDoc(planRef(db(uid), owner), new FieldPath('cancels', key), value, 'updatedAt', serverTimestamp())
  const crossOut = (key: string, why: string = WHY, uid = 'alice') => change(uid, key, { at: serverTimestamp(), why })
  const undo = (key: string, uid = 'alice') => change(uid, key, { at: serverTimestamp() })

  test('the owner crosses out, undoes twice and crosses out for good', async () => {
    await setup('active')
    await allowed(crossOut('1:t0'))
    await allowed(undo('2:t0'))
    await allowed(crossOut('3:t0', 'Rained out again'))
    await allowed(undo('4:t0'))
    await allowed(crossOut('5:t0', 'Final'))
    await allDenied({
      'a 6th change (a 3rd undo)': () => undo('6:t0'),
      'a 6th change as a cross-out': () => crossOut('6:t0'),
      'rewriting the last reason': () => crossOut('5:t0', 'A better reason'),
    })
    // Another task, the one added after the lock, has its own log.
    await allowed(crossOut('1:t2'))
  })

  test('the window: from lockAt until the review window opens', async () => {
    await setup(periodAt(coll, 'lockAt'))
    await allowed(crossOut('1:t0'))
    for (const p of ['planning', 'review', 'closed'] as const) {
      await setup(p)
      await denied(crossOut('1:t0'))
    }
    await setup(periodAt(coll, 'reviewOpenAt'), log(['t0'], 1))
    await allDenied({
      'a cross-out at reviewOpenAt': () => crossOut('1:t1'),
      'an undo at reviewOpenAt': () => undo('2:t0'),
    })
  })

  test('only the owner, still a participant and a space member, and not the judge', async () => {
    await setup('active')
    // Plans nobody could have written (judges, leavers and outsiders have none), seeded to test the rule.
    const own = () => ({ tasks: tasks(1), added: {}, updatedAt: earlier() })
    await seed({ [planPath('jude')]: own(), [planPath('dave')]: own(), [planPath('carol')]: own() })
    await allDenied({
      'another player, on alice\'s plan': () => change('bob', '1:t0', { at: serverTimestamp(), why: WHY }, 'alice'),
      'the period\'s judge, on alice\'s plan': () => change('jude', '1:t0', { at: serverTimestamp(), why: WHY }, 'alice'),
      'the period\'s judge, on a plan of their own': () => crossOut('1:t0', WHY, 'jude'),
      'left the space after the lock': () => crossOut('1:t0', WHY, 'dave'),
      'in the space, not in the period': () => crossOut('1:t0', WHY, 'carol'),
      'signed out': () => updateDoc(planRef(db(), 'alice'), new FieldPath('cancels', '1:t0'), { at: serverTimestamp(), why: WHY }, 'updatedAt', serverTimestamp()),
    })
    // No plan: there's nothing to cross out, and no log starts a plan.
    await allDenied({
      'a new plan with a log (merge)': () =>
        setDoc(planRef(db('bob'), 'bob'), { cancels: { '1:t0': { at: serverTimestamp(), why: WHY } }, updatedAt: serverTimestamp() }, { merge: true }),
      'a new plan with tasks and a log': () =>
        setDoc(planRef(db('bob'), 'bob'), { tasks: tasks(1), added: {}, cancels: { '1:t0': { at: serverTimestamp(), why: WHY } }, updatedAt: serverTimestamp() }),
    })
  })

  test('the reason: one line, 1-120 characters, not blank', async () => {
    await setup('active')
    await allDenied({
      'empty': () => crossOut('1:t0', ''),
      'blank': () => crossOut('1:t0', '   '),
      '121 characters': () => crossOut('1:t0', 'x'.repeat(121)),
      'a newline': () => crossOut('1:t0', 'Pool closed\nall week'),
      'a carriage return': () => crossOut('1:t0', 'Pool closed\rall week'),
      'a trailing newline': () => crossOut('1:t0', 'Pool closed\n'),
      'not a string': () => change('alice', '1:t0', { at: serverTimestamp(), why: 42 }),
      'missing': () => change('alice', '1:t0', { at: serverTimestamp() }),
      'an extra key': () => change('alice', '1:t0', { at: serverTimestamp(), why: WHY, by: 'alice' }),
    })
    await allowed(crossOut('1:t0', 'Ж'.repeat(120)))
    await allowed(crossOut('1:t1', 'Sick 🤒 so no swimming 🏊‍♀️'))
  })

  test('the log grows by one well-formed entry per write', async () => {
    await setup('active', log(['t0'], 1))
    await allDenied({
      'an undo with a reason': () => change('alice', '2:t0', { at: serverTimestamp(), why: WHY }),
      'an undo with an extra key': () => change('alice', '2:t0', { at: serverTimestamp(), note: 'x' }),
      'an undo before any cross-out': () => undo('2:t1'),
      'a 3rd change after the 1st only': () => crossOut('3:t0'),
      'a 2nd cross-out entry written as 1 again': () => crossOut('1:t0', 'Again'),
      'the client\'s time': () => change('alice', '2:t0', { at: Timestamp.now() }),
      'no time': () => change('alice', '1:t1', { why: WHY }),
      'updatedAt left as it was': () =>
        updateDoc(planRef(db('alice'), 'alice'), new FieldPath('cancels', '2:t0'), { at: serverTimestamp() }),
      'updatedAt from the client': () =>
        updateDoc(planRef(db('alice'), 'alice'), new FieldPath('cancels', '2:t0'), { at: serverTimestamp() }, 'updatedAt', Timestamp.now()),
      'removing an entry': () =>
        updateDoc(planRef(db('alice'), 'alice'), new FieldPath('cancels', '1:t0'), deleteField(), 'updatedAt', serverTimestamp()),
      'removing one entry and adding another': () =>
        updateDoc(planRef(db('alice'), 'alice'), new FieldPath('cancels', '1:t0'), deleteField(), new FieldPath('cancels', '1:t1'), { at: serverTimestamp(), why: WHY }, 'updatedAt', serverTimestamp()),
      'rewriting an entry\'s reason': () =>
        updateDoc(planRef(db('alice'), 'alice'), new FieldPath('cancels', '1:t0', 'why'), 'Another reason', 'updatedAt', serverTimestamp()),
      'rewriting an entry while adding one': () =>
        updateDoc(planRef(db('alice'), 'alice'), new FieldPath('cancels', '1:t0'), { at: serverTimestamp(), why: 'New' }, new FieldPath('cancels', '1:t1'), { at: serverTimestamp(), why: WHY }, 'updatedAt', serverTimestamp()),
      'two new entries in one write': () =>
        updateDoc(planRef(db('alice'), 'alice'), new FieldPath('cancels', '2:t0'), { at: serverTimestamp() }, new FieldPath('cancels', '1:t1'), { at: serverTimestamp(), why: WHY }, 'updatedAt', serverTimestamp()),
      'the whole log replaced': () =>
        updateDoc(planRef(db('alice'), 'alice'), { cancels: { '1:t1': { at: serverTimestamp(), why: WHY } }, updatedAt: serverTimestamp() }),
      'the log not a map': () => updateDoc(planRef(db('alice'), 'alice'), { cancels: 'crossed out', updatedAt: serverTimestamp() }),
      'an entry not a map': () => change('alice', '2:t0', 'restored' as unknown as DocumentData),
    })
    await allowed(undo('2:t0'))
  })

  test('keys are "<1-5>:<task id>"', async () => {
    await setup('active', log(['t0'], 5))
    const bad = ['0:t1', '6:t0', '9:t1', '12:t1', '1:', '1:t 1', '1:t.1', '1:t1:x', 't1', ':t1', ' 1:t1', '1:' + 'k'.repeat(65), '1;t1']
    await allDenied(Object.fromEntries(bad.map((k) => [JSON.stringify(k), () => crossOut(k)])))
    await allowed(crossOut('1:' + 'k'.repeat(64)))
  })

  test('nothing but the log and updatedAt changes', async () => {
    await setup('active')
    const ref = planRef(db('alice'), 'alice')
    const entry = { at: serverTimestamp(), why: WHY }
    await allDenied({
      'with a task renamed': () =>
        updateDoc(ref, new FieldPath('cancels', '1:t0'), entry, 'updatedAt', serverTimestamp(), 'tasks', [{ id: 't0', title: 'Easier' }, ...tasks(3).slice(1)]),
      'with a task appended': () =>
        updateDoc(ref, new FieldPath('cancels', '1:t0'), entry, 'updatedAt', serverTimestamp(), 'tasks', [...tasks(3), { id: 'x', title: 'X' }], 'added.x', serverTimestamp()),
      'with an added time': () =>
        updateDoc(ref, new FieldPath('cancels', '1:t0'), entry, 'updatedAt', serverTimestamp(), 'added.t0', serverTimestamp()),
      'with added dropped': () =>
        updateDoc(ref, new FieldPath('cancels', '1:t0'), entry, 'updatedAt', serverTimestamp(), 'added', deleteField()),
      'with an extra key': () =>
        updateDoc(ref, new FieldPath('cancels', '1:t0'), entry, 'updatedAt', serverTimestamp(), 'note', 'hi'),
      'as a whole-doc set': () =>
        setDoc(ref, { tasks: tasks(3), added: { t2: earlier() }, cancels: { '1:t0': entry }, updatedAt: serverTimestamp() }),
      'deleting the plan': () => deleteDoc(ref),
    })
  })

  test('at most 125 entries (25 tasks × 5 changes)', async () => {
    const full = tasks(25).map((t) => t.id)
    await setup('active', { ...log(full.slice(0, 24), 5), ...log(['t24'], 4) }, { tasks: tasks(25) })
    await allowed(crossOut('5:t24'))
    await denied(crossOut('1:x'))
  })

  test('passes although the append branch reads past the end of the list (error || true)', async () => {
    // Without `added` the append branch stops at its keys; with it, it reads d.tasks[n] (one past the
    // end) and gets to the cancels comparison. Either way the cross-out is decided by togglesCancel.
    await setup('active')
    await seed({ [planPath('alice')]: { tasks: tasks(3), updatedAt: earlier() } })
    await allowed(crossOut('1:t0'))
    await setup('active', log(['t1'], 2))
    await allowed(crossOut('1:t0'))
    await allowed(crossOut('3:t1'))
    // A full list of the largest tasks, with an added one.
    await seed({ [planPath('alice')]: { tasks: Array.from({ length: 25 }, (_, i) => fullTask(i)), added: { [fullTask(24).id]: earlier() }, updatedAt: earlier() } })
    await allowed(crossOut(`1:${fullTask(24).id}`))
  })

  test('before the lock a plan has no log', async () => {
    await setup('planning')
    const ref = planRef(db('alice'), 'alice')
    await allDenied({
      'a plan saved with a log': () => setDoc(ref, { tasks: tasks(3), cancels: { '1:t0': { at: serverTimestamp(), why: WHY } }, updatedAt: serverTimestamp() }),
      'a cross-out': () => crossOut('1:t0'),
    })
    // The plan itself is still saved as always (the shape old clients write).
    await allowed(setDoc(ref, { tasks: tasks(2), updatedAt: serverTimestamp() }))
  })

  test('old clients: ticks on a crossed-out task still pass (the app refuses them)', async () => {
    await setup('active', log(['t0'], 1))
    await allowed(setDoc(doc(db('alice'), `${period}/progress/alice`), { done: { t0: true }, updatedAt: serverTimestamp() }, { merge: true }))
    // Friends read the plan and its log.
    await allowed(getDoc(planRef(db('bob'), 'alice')))
  })
})

describe('a monthly list\'s own bounds, members and judges decide', () => {
  const M = '2026-10'
  const listPath = `spaces/s1/monthly/${M}`
  const planPath = `${listPath}/plans/alice`
  const crossOut = () => updateDoc(doc(db('alice'), planPath), new FieldPath('cancels', '1:t0'), { at: serverTimestamp(), why: WHY }, 'updatedAt', serverTimestamp())

  test('this week\'s window, judges and pause don\'t matter', async () => {
    // alice judges this week (and this week's reviews are open, and the week is paused) but plays the
    // monthly list, which is still before its review window.
    await seed({
      'spaces/s1': spaceDoc(['alice', 'bob'], { judges: ['alice'], paused: { [M]: 'W' } }),
      'spaces/s1/weeks/W': { ...weekDoc('review', ['alice', 'bob']), judges: ['alice'] },
      [listPath]: monthlyDoc('active', ['alice', 'bob'], []),
      [planPath]: { tasks: tasks(2), updatedAt: earlier() },
    })
    await allowed(crossOut())
  })

  test('the list\'s judge can\'t, and its review window closes it whatever the week says', async () => {
    await seed({
      'spaces/s1': spaceDoc(['alice', 'bob']),
      'spaces/s1/weeks/W': weekDoc('active', ['alice', 'bob']),
      [listPath]: monthlyDoc('active', ['alice', 'bob'], ['alice']),
      [planPath]: { tasks: tasks(2), updatedAt: earlier() },
    })
    await denied(crossOut())
    await seed({ [listPath]: monthlyDoc('review', ['alice', 'bob'], []) })
    await denied(crossOut())
  })

  test('a weekly cross-out in a paused week passes the rules (the app doesn\'t offer it)', async () => {
    await seed({
      'spaces/s1': spaceDoc(['alice', 'bob'], { paused: { [M]: 'W' } }),
      'spaces/s1/weeks/W': weekDoc('active', ['alice', 'bob']),
      'spaces/s1/weeks/W/plans/alice': { tasks: tasks(2), updatedAt: earlier() },
    })
    await allowed(updateDoc(doc(db('alice'), 'spaces/s1/weeks/W/plans/alice'), new FieldPath('cancels', '1:t0'), { at: serverTimestamp(), why: WHY }, 'updatedAt', serverTimestamp()))
  })

  test('nobody crosses out a friend\'s task, not even in a batch with their own', async () => {
    await seed({
      'spaces/s1': spaceDoc(['alice', 'bob']),
      [listPath]: monthlyDoc('active', ['alice', 'bob'], []),
      [planPath]: { tasks: tasks(2), updatedAt: earlier() },
      [`${listPath}/plans/bob`]: { tasks: tasks(2), updatedAt: earlier() },
    })
    const fs = db('alice')
    const b = writeBatch(fs)
    b.update(doc(fs, planPath), new FieldPath('cancels', '1:t0'), { at: serverTimestamp(), why: WHY }, 'updatedAt', serverTimestamp())
    b.update(doc(fs, `${listPath}/plans/bob`), new FieldPath('cancels', '1:t0'), { at: serverTimestamp(), why: WHY }, 'updatedAt', serverTimestamp())
    await denied(b.commit())
  })
})
