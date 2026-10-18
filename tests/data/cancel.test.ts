// Batch 2.5 (SPEC §10) against the emulators and the real rules, through the functions the screens call:
// crossing out a task and undoing that (weeks and monthly lists), the ticks they freeze, the week append that
// keeps the log, adds to a locked monthly list, and the fair vote in reviews. Periods are seeded on real time
// (the emulator's request.time), so nothing here moves the rules' clock; only the app's clock moves, to show
// what a device whose clock is behind the server's gets told.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { disableNetwork, enableNetwork, type Timestamp } from 'firebase/firestore'
import {
  addMonthlyTaskAfterLock,
  addTaskAfterLock,
  CROSSED_OUT_TICK,
  crossOutTask,
  setMonthlyTaskDone,
  setTaskDone,
  submitMonthlyReviews,
  submitReviews,
  undoCrossOut,
} from '../../src/data/api.ts'
import { monthlyKey, startMonthly } from '../../src/data/monthly.ts'
import { forget, peek, watch } from '../../src/data/store.ts'
import { startWeek, weekKey } from '../../src/data/weeks.ts'
import { now } from '../../src/domain/clock.ts'
import { newTaskId } from '../../src/domain/ids.ts'
import { computeWeek } from '../../src/domain/scoring.ts'
import { monthlyBounds, weekBounds } from '../../src/domain/time.ts'
import type { MonthlyData, Period, Space, Task, WeekData } from '../../src/domain/types.ts'
import { getFirebase } from '../../src/firebase/app.ts'
import {
  adminGet,
  adminSpace,
  as,
  boundsDoc,
  createUser,
  DAY,
  eventually,
  HOUR,
  observe,
  rejectsWith,
  resetClock,
  seed,
  setClock,
  setupEmulators,
  spaceDoc,
  teardownEmulators,
  ts,
  weekDoc,
  type TestUser,
} from './helpers.ts'

const GENERIC = 'Something went wrong. Try again.'
const OFFLINE = 'You’re offline. Check your connection and try again.'
const NOT_IN_SPACE = 'You’re no longer in this space.'
const REVIEWS_OPEN = 'Reviews have opened, so this can’t change anymore.'
const NO_UNDOS = 'You’ve used both undos for this task.'
const JUDGING_WEEK = 'You’re judging this week, so there’s no list to plan.'
const JUDGING_MONTH = 'You’re judging this month’s lists, so there’s no list to plan.'

let lena: TestUser
let sam: TestUser
let kim: TestUser
let ivy: TestUser
let max: TestUser
let space: Space

const id = 'xo'
const old = () => ts(Date.now() - 3 * DAY)
const weekPath = (weekId: string) => `spaces/${id}/weeks/${weekId}`
const listPath = (monthId: string) => `spaces/${id}/monthly/${monthId}`
const week = (weekId: string): Period => ({ kind: 'week', id: weekId })
const month = (monthId: string): Period => ({ kind: 'month', id: monthId })
const millis = (v: unknown) => (v as Timestamp).toMillis()
const recent = (v: unknown) => Math.abs(millis(v) - Date.now()) < 60_000

/** A monthly list's doc on real time: locked `lockedFor` ago, reviews `reviewsIn` from now. */
function listDoc(lockedFor: number, reviewsIn: number, members: string[], judges: string[] = []) {
  const t = Date.now()
  return boundsDoc({ startAt: t - lockedFor - 7 * DAY, lockAt: t - lockedFor, reviewOpenAt: t + reviewsIn, deadlineAt: t + reviewsIn + DAY }, members, { judges })
}

/** Keeps a period open on this device (as the screen does), so a tick decides from its copy of the plan. */
function openWeek(user: TestUser, weekId: string) {
  const key = weekKey(user.uid, id, weekId)
  const release = watch(key, startWeek(id, weekId, user.uid), () => {})
  const task = (taskId: string) => peek<WeekData>(key).data?.plans[user.uid]?.tasks.find((t) => t.id === taskId)
  return {
    task,
    until: (taskId: string, ok: (t: Task | undefined) => boolean) => eventually(() => ok(task(taskId))),
    close: () => {
      release()
      forget(key)
    },
  }
}

beforeAll(async () => {
  await setupEmulators()
  resetClock()
  lena = await createUser('Lena')
  sam = await createUser('Sam')
  kim = await createUser('Kim')
  ivy = await createUser('Ivy')
  max = await createUser('Max')
  // Kim judges; Ivy was in every period and has left the space since; Max joined after everything locked.
  await seed({
    [`spaces/${id}`]: spaceDoc({
      ownerId: lena.uid,
      memberIds: [lena.uid, sam.uid, kim.uid, max.uid],
      inviteCode: 'CROSSOUT',
      extra: { judges: [kim.uid], leftAt: { [ivy.uid]: ts(Date.now() - DAY) } },
    }),
  })
  space = await adminSpace(id)
})
afterAll(async () => {
  resetClock()
  await teardownEmulators()
})

describe('crossing out a week’s task, and undoing that', () => {
  const W = '2026-07-06'
  const members = () => [lena.uid, sam.uid, kim.uid, ivy.uid]

  beforeAll(async () => {
    await seed({
      [weekPath(W)]: { ...weekDoc('active', members()), judges: [kim.uid] },
      [`${weekPath(W)}/plans/${lena.uid}`]: { tasks: [{ id: 't1', title: 'Swim 3 times' }, { id: 't2', title: 'Run' }, { id: 't3', title: 'Read' }], updatedAt: old() },
      [`${weekPath(W)}/plans/${sam.uid}`]: { tasks: [{ id: 's1', title: 'Cook' }], updatedAt: old() },
      [`${weekPath(W)}/plans/${ivy.uid}`]: { tasks: [{ id: 'i1', title: 'Paint' }], updatedAt: old() },
    })
  })

  it('cross out, undo, cross out, undo, cross out: keys 1…5 with server times and the reason; no 3rd undo', async () => {
    await as(lena)
    const plan = `${weekPath(W)}/plans/${lena.uid}`
    await crossOutTask(space, week(W), 't1', '  The pool is\nclosed  all week ')
    let stored = await adminGet(plan)
    expect(Object.keys(stored?.cancels)).toEqual(['1:t1'])
    expect(stored?.cancels['1:t1'].why).toBe('The pool is closed  all week')
    expect(Object.keys(stored?.cancels['1:t1']).sort()).toEqual(['at', 'why'])
    expect(recent(stored?.cancels['1:t1'].at)).toBe(true)
    expect(millis(stored?.updatedAt)).toBe(millis(stored?.cancels['1:t1'].at))
    // Nothing else changed.
    expect(stored?.tasks).toEqual([{ id: 't1', title: 'Swim 3 times' }, { id: 't2', title: 'Run' }, { id: 't3', title: 'Read' }])
    expect(Object.keys(stored ?? {}).sort()).toEqual(['cancels', 'tasks', 'updatedAt'])

    // A retry after it went through (the answer was lost) writes nothing.
    await crossOutTask(space, week(W), 't1', 'Again')
    expect(await adminGet(plan)).toEqual(stored)

    await undoCrossOut(space, week(W), 't1')
    stored = await adminGet(plan)
    expect(Object.keys(stored?.cancels['2:t1'])).toEqual(['at'])
    await undoCrossOut(space, week(W), 't1')
    expect(Object.keys((await adminGet(plan))?.cancels)).toHaveLength(2)

    await crossOutTask(space, week(W), 't1', 'Still closed')
    await undoCrossOut(space, week(W), 't1')
    await crossOutTask(space, week(W), 't1', 'Closed for good')
    stored = await adminGet(plan)
    expect(Object.keys(stored?.cancels).sort()).toEqual(['1:t1', '2:t1', '3:t1', '4:t1', '5:t1'])
    expect([1, 3, 5].map((n) => stored?.cancels[`${n}:t1`].why)).toEqual(['The pool is closed  all week', 'Still closed', 'Closed for good'])
    expect([2, 4].map((n) => Object.keys(stored?.cancels[`${n}:t1`]))).toEqual([['at'], ['at']])
    const times = [1, 2, 3, 4, 5].map((n) => millis(stored?.cancels[`${n}:t1`].at))
    expect([...times].sort((a, b) => a - b)).toEqual(times)

    await rejectsWith(undoCrossOut(space, week(W), 't1'), NO_UNDOS)
    expect(await adminGet(plan)).toEqual(stored)
  })

  it('checks the reason first: one line, 1–120 characters', async () => {
    await as(lena)
    await rejectsWith(crossOutTask(space, week(W), 't2', ''), 'Say why in a few words.')
    await rejectsWith(crossOutTask(space, week(W), 't2', '  \n\r  '), 'Say why in a few words.')
    await rejectsWith(crossOutTask(space, week(W), 't2', 'x'.repeat(121)), 'Keep the reason to 120 characters.')
    expect((await adminGet(`${weekPath(W)}/plans/${lena.uid}`))?.cancels['1:t2']).toBeUndefined()
    await crossOutTask(space, week(W), 't2', `${'x'.repeat(119)}\n`)
    expect((await adminGet(`${weekPath(W)}/plans/${lena.uid}`))?.cancels['1:t2'].why).toBe('x'.repeat(119))
    await crossOutTask(space, week(W), 't3', `🏊 ${'y'.repeat(117)}`)
    expect((await adminGet(`${weekPath(W)}/plans/${lena.uid}`))?.cancels['1:t3'].why).toHaveLength(120)
  })

  it('everyone sees the task’s current state', async () => {
    await as(sam)
    const live = observe(startWeek(id, W, sam.uid))
    const data = (await live.until((l) => l.data?.plans[lena.uid]?.tasks.length === 3)).data!
    live.stop()
    const [t1, t2] = data.plans[lena.uid].tasks
    expect(t1.cancel).toMatchObject({ cancelled: true, changes: 5, why: 'Closed for good' })
    expect(t2.cancel).toMatchObject({ cancelled: true, changes: 1, why: 'x'.repeat(119) })
    expect(data.plans[sam.uid].tasks).toStrictEqual([{ id: 's1', title: 'Cook' }])
    expect(computeWeek(data, space, now()).members[lena.uid].cancelledCount).toBe(3)
  })

  it('explains every refusal', async () => {
    const PLANNING = '2026-07-13'
    await seed({
      [weekPath(PLANNING)]: { ...weekDoc('planning', members()), judges: [kim.uid] },
      [`${weekPath(PLANNING)}/plans/${lena.uid}`]: { tasks: [{ id: 'p1', title: 'Plan' }], updatedAt: old() },
    })
    await as(lena)
    await rejectsWith(crossOutTask(space, week(PLANNING), 'p1', 'Too early'), 'Your list hasn’t locked yet, so you can still delete the task.')
    await rejectsWith(undoCrossOut(space, week(PLANNING), 'p1'), 'Your list hasn’t locked yet, so you can still delete the task.')
    // Not on your list: someone else's task, or one that doesn't exist.
    await rejectsWith(crossOutTask(space, week(W), 's1', 'Not mine'), GENERIC)
    await rejectsWith(crossOutTask(space, week(W), 'nope', 'Not there'), GENERIC)
    await as(kim)
    await rejectsWith(crossOutTask(space, week(W), 'k1', 'Judging'), JUDGING_WEEK)
    await as(max)
    // Max isn't in this week at all.
    await rejectsWith(crossOutTask(space, week(W), 's1', 'Not in it'), GENERIC)
    await as(ivy)
    await rejectsWith(crossOutTask(space, week(W), 'i1', 'Left'), NOT_IN_SPACE)
    // With a copy of the space from before she left: the server refuses, and the re-check says why.
    await rejectsWith(crossOutTask({ ...space, memberIds: [...space.memberIds, ivy.uid] }, week(W), 'i1', 'Left'), NOT_IN_SPACE)
    expect((await adminGet(`${weekPath(W)}/plans/${ivy.uid}`))?.cancels).toBeUndefined()
  })

  it('from reviews opening on, nothing changes; a refusal is re-checked against the window', async () => {
    const REVIEW = '2026-07-20'
    const seeded = weekDoc('review', members())
    await seed({
      [weekPath(REVIEW)]: { ...seeded, judges: [kim.uid] },
      [`${weekPath(REVIEW)}/plans/${lena.uid}`]: {
        tasks: [{ id: 'r1', title: 'Swim' }, { id: 'r2', title: 'Run' }],
        cancels: { '1:r1': { at: old(), why: 'Pool closed' } },
        updatedAt: old(),
      },
    })
    const reviewOpenAt = millis(seeded.reviewOpenAt)
    await as(lena)
    try {
      await rejectsWith(crossOutTask(space, week(REVIEW), 'r2', 'Too late'), REVIEWS_OPEN)
      await rejectsWith(undoCrossOut(space, week(REVIEW), 'r1'), REVIEWS_OPEN)
      // A device a little behind the server's clock asks anyway: the server refuses, and it was the window.
      setClock(reviewOpenAt - 20_000)
      await rejectsWith(crossOutTask(space, week(REVIEW), 'r2', 'Too late'), REVIEWS_OPEN)
      // Far behind: the re-check can't tell why, so it says to try again.
      setClock(reviewOpenAt - HOUR)
      await rejectsWith(crossOutTask(space, week(REVIEW), 'r2', 'Too late'), 'Couldn’t cross it out. Try again.')
      await rejectsWith(undoCrossOut(space, week(REVIEW), 'r1'), 'Couldn’t undo it. Try again.')
    } finally {
      resetClock()
    }
    expect(Object.keys((await adminGet(`${weekPath(REVIEW)}/plans/${lena.uid}`))?.cancels)).toEqual(['1:r1'])
  })

  it('fails at once offline, and nothing is queued', async () => {
    await as(sam)
    const { db } = getFirebase()
    await disableNetwork(db)
    try {
      await rejectsWith(crossOutTask(space, week(W), 's1', 'Offline'), OFFLINE)
      await rejectsWith(undoCrossOut(space, week(W), 's1'), OFFLINE)
    } finally {
      await enableNetwork(db)
    }
    // Back online, a queued write would land now.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect((await adminGet(`${weekPath(W)}/plans/${sam.uid}`))?.cancels).toBeUndefined()
  })
})

describe('ticks on a crossed-out task', () => {
  const W = '2026-07-27'

  it('are refused for the task and its steps, and allowed again after an undo; earlier ticks stay', async () => {
    await seed({
      [weekPath(W)]: weekDoc('active', [lena.uid, sam.uid]),
      [`${weekPath(W)}/plans/${lena.uid}`]: { tasks: [{ id: 'c1', title: 'Swim', subs: ['c1a|Monday', 'c1b|Wednesday'] }, { id: 'c2', title: 'Run' }], updatedAt: old() },
    })
    await as(lena)
    const open = openWeek(lena, W)
    try {
      await open.until('c1', (t) => t !== undefined)
      await setTaskDone(space, W, 'c1a', true)
      await crossOutTask(space, week(W), 'c1', 'The pool is closed')
      await open.until('c1', (t) => t?.cancel?.cancelled === true)
      await rejectsWith(setTaskDone(space, W, 'c1b', true), CROSSED_OUT_TICK)
      await rejectsWith(setTaskDone(space, W, 'c1a', false), CROSSED_OUT_TICK)
      await rejectsWith(setTaskDone(space, W, 'c1', true), CROSSED_OUT_TICK)
      // The other tasks tick as usual.
      await setTaskDone(space, W, 'c2', true)
      expect((await adminGet(`${weekPath(W)}/progress/${lena.uid}`))?.done).toEqual({ c1a: true, c2: true })

      await undoCrossOut(space, week(W), 'c1')
      await open.until('c1', (t) => t?.cancel?.cancelled === false)
      await setTaskDone(space, W, 'c1b', true)
      expect((await adminGet(`${weekPath(W)}/progress/${lena.uid}`))?.done).toEqual({ c1a: true, c1b: true, c2: true })
    } finally {
      open.close()
    }
  })
})

describe('the week append keeps the cross-outs', () => {
  const W = '2026-08-03'

  it('updates a plan that has a log, and still starts a plan when there is none', async () => {
    await seed({
      [weekPath(W)]: weekDoc('active', [lena.uid, sam.uid]),
      [`${weekPath(W)}/plans/${lena.uid}`]: { tasks: [{ id: 'a1', title: 'Swim' }], updatedAt: old() },
    })
    await as(lena)
    const plan = `${weekPath(W)}/plans/${lena.uid}`
    await crossOutTask(space, week(W), 'a1', 'Pool closed')
    const log = (await adminGet(plan))?.cancels
    const task = await addTaskAfterLock(space, W, { title: 'Run instead', subtasks: ['Monday'] })
    const stored = await adminGet(plan)
    expect(stored?.cancels).toEqual(log)
    expect(stored?.tasks.map((t: Task) => t.id)).toEqual(['a1', task.id])
    expect(Object.keys(stored?.added)).toEqual([task.id])
    // And the added task can be crossed out too.
    await crossOutTask(space, week(W), task.id, 'Knee hurts')
    expect(Object.keys((await adminGet(plan))?.cancels).sort()).toEqual(['1:a1', `1:${task.id}`].sort())

    await as(sam)
    const first = await addTaskAfterLock(space, W, { title: 'Cook' })
    expect(await adminGet(`${weekPath(W)}/plans/${sam.uid}`)).toMatchObject({ tasks: [{ id: first.id, title: 'Cook' }] })
  })
})

describe('adding to a locked monthly list', () => {
  // Real-time lists, named for their months in the messages.
  const OPEN = '2025-10'
  const FULL = '2025-08'
  const EARLY = '2025-11'
  const LATE = '2025-12'
  const members = () => [lena.uid, sam.uid, kim.uid, ivy.uid]
  const plan = (monthId: string, user: TestUser) => `${listPath(monthId)}/plans/${user.uid}`

  beforeAll(async () => {
    await seed({
      [listPath(OPEN)]: listDoc(3 * DAY, 2 * DAY, members(), [kim.uid]),
      [plan(OPEN, lena)]: { tasks: [{ id: 'm1', title: 'Finish the short film' }, { id: 'm2', title: 'Read two books', subs: ['m2a|Book one'] }], updatedAt: old() },
      // Sam saved an empty list before the lock: no list.
      [plan(OPEN, sam)]: { tasks: [], updatedAt: old() },
      [`${plan(OPEN, ivy)}`]: { tasks: [{ id: 'v1', title: 'Paint' }], updatedAt: old() },
      [listPath(FULL)]: listDoc(3 * DAY, 2 * DAY, members(), [kim.uid]),
      [plan(FULL, lena)]: { tasks: Array.from({ length: 25 }, (_, i) => ({ id: `f${i}`, title: `F${i}` })), updatedAt: old() },
      [listPath(EARLY)]: listDoc(-DAY, 20 * DAY, members(), [kim.uid]),
      [plan(EARLY, lena)]: { tasks: [{ id: 'e1', title: 'Early' }], updatedAt: old() },
      [listPath(LATE)]: listDoc(25 * DAY, -HOUR, members(), [kim.uid]),
      [plan(LATE, lena)]: { tasks: [{ id: 'l1', title: 'Late' }], updatedAt: old() },
    })
  })

  it('appends one task with its steps and its add time; the rest stays as it was', async () => {
    await as(lena)
    const before = Date.now()
    const task = await addMonthlyTaskAfterLock(space, OPEN, { title: '  Learn a song ', subtasks: ['Pick one', ' ', 'Practice'] })
    expect(task).toMatchObject({ title: 'Learn a song', subtasks: [{ title: 'Pick one' }, { title: 'Practice' }] })
    expect(task.addedAt).toBeGreaterThanOrEqual(before)
    const stored = await adminGet(plan(OPEN, lena))
    expect(stored?.tasks).toEqual([
      { id: 'm1', title: 'Finish the short film' },
      { id: 'm2', title: 'Read two books', subs: ['m2a|Book one'] },
      { id: task.id, title: 'Learn a song', subs: task.subtasks?.map((s) => `${s.id}|${s.title}`) },
    ])
    expect(Object.keys(stored?.added)).toEqual([task.id])
    expect(recent(stored?.added[task.id])).toBe(true)
    expect(Object.keys(stored ?? {}).sort()).toEqual(['added', 'tasks', 'updatedAt'])

    // Everyone sees when it was added.
    await as(sam)
    const live = observe(startMonthly(id, OPEN, sam.uid))
    const data = (await live.until((l) => l.data?.plans[lena.uid]?.tasks.length === 3)).data!
    live.stop()
    expect(Math.abs((data.plans[lena.uid].tasks[2].addedAt ?? 0) - Date.now())).toBeLessThan(60_000)
  })

  it('a retry with the same id adds it once; a later add keeps the cross-outs', async () => {
    await as(lena)
    const taskId = newTaskId()
    await addMonthlyTaskAfterLock(space, OPEN, { id: taskId, title: 'Call grandma' })
    await addMonthlyTaskAfterLock(space, OPEN, { id: taskId, title: 'Call grandma' })
    let stored = await adminGet(plan(OPEN, lena))
    expect(stored?.tasks.filter((t: Task) => t.id === taskId)).toHaveLength(1)

    await crossOutTask(space, month(OPEN), 'm1', 'The festival was cancelled')
    const log = (await adminGet(plan(OPEN, lena)))?.cancels
    expect(Object.keys(log)).toEqual(['1:m1'])
    const next = await addMonthlyTaskAfterLock(space, OPEN, { title: 'Write a poem' })
    stored = await adminGet(plan(OPEN, lena))
    expect(stored?.cancels).toEqual(log)
    expect(stored?.tasks.map((t: Task) => t.id).slice(-2)).toEqual([taskId, next.id])
  })

  it('explains every refusal', async () => {
    await as(lena)
    await rejectsWith(addMonthlyTaskAfterLock(space, OPEN, { title: '   ' }), 'Give the task a title.')
    await rejectsWith(addMonthlyTaskAfterLock(space, OPEN, { title: 'Big', subtasks: Array.from({ length: 9 }, (_, i) => `Step ${i}`) }), 'A task can have up to 8 steps.')
    await rejectsWith(addMonthlyTaskAfterLock(space, FULL, { title: 'One more' }), 'Your August list can have up to 25 tasks.')
    await rejectsWith(addMonthlyTaskAfterLock(space, EARLY, { title: 'Early' }), 'Your November list hasn’t locked yet. Add the task to it instead.')
    await rejectsWith(addMonthlyTaskAfterLock(space, LATE, { title: 'Late' }), 'Adding tasks closed when reviews opened.')
    // No list at its lock: an empty one, none at all, or no list doc (nobody opened the app in time).
    await as(sam)
    await rejectsWith(addMonthlyTaskAfterLock(space, OPEN, { title: 'Start one' }), 'You had no October list when it locked, so there’s nothing to add to.')
    await rejectsWith(addMonthlyTaskAfterLock(space, FULL, { title: 'Start one' }), 'You had no August list when it locked, so there’s nothing to add to.')
    const none = '2027-02'
    const bounds = monthlyBounds(none, (w) => weekBounds(w, 'UTC'))
    setClock(bounds.lockAt + DAY)
    try {
      await rejectsWith(addMonthlyTaskAfterLock(space, none, { title: 'Start one' }), 'You had no February list when it locked, so there’s nothing to add to.')
    } finally {
      resetClock()
    }
    await as(kim)
    await rejectsWith(addMonthlyTaskAfterLock(space, OPEN, { title: 'Judge' }), JUDGING_MONTH)
    await as(max)
    await rejectsWith(addMonthlyTaskAfterLock(space, OPEN, { title: 'Late joiner' }), 'This month’s list started without you. You’re in from next month.')
    await as(ivy)
    await rejectsWith(addMonthlyTaskAfterLock(space, OPEN, { title: 'Gone' }), NOT_IN_SPACE)
    expect((await adminGet(plan(OPEN, sam)))?.tasks).toEqual([])
    expect((await adminGet(plan(FULL, lena)))?.tasks).toHaveLength(25)
    expect(await adminGet(plan(FULL, sam))).toBeUndefined()
  })

  it('fails at once offline', async () => {
    await as(lena)
    const { db } = getFirebase()
    await disableNetwork(db)
    try {
      await rejectsWith(addMonthlyTaskAfterLock(space, OPEN, { title: 'Offline' }), OFFLINE)
    } finally {
      await enableNetwork(db)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect((await adminGet(plan(OPEN, lena)))?.tasks.some((t: Task) => t.title === 'Offline')).toBe(false)
  })
})

describe('crossing out a monthly list’s task', () => {
  const OPEN = '2025-07'
  const EARLY = '2025-06'

  it('works in the list’s own window, freezes its ticks, and is undone the same way', async () => {
    await seed({
      [listPath(OPEN)]: listDoc(3 * DAY, 2 * DAY, [lena.uid, sam.uid, kim.uid], [kim.uid]),
      [`${listPath(OPEN)}/plans/${lena.uid}`]: { tasks: [{ id: 'm1', title: 'Film', subs: ['m1a|Shoot', 'm1b|Edit'] }], updatedAt: old() },
      [listPath(EARLY)]: listDoc(-DAY, 20 * DAY, [lena.uid, sam.uid, kim.uid], [kim.uid]),
      [`${listPath(EARLY)}/plans/${lena.uid}`]: { tasks: [{ id: 'e1', title: 'Early' }], updatedAt: old() },
    })
    await as(lena)
    const key = monthlyKey(lena.uid, id, OPEN)
    const release = watch(key, startMonthly(id, OPEN, lena.uid), () => {})
    const m1 = () => peek<MonthlyData>(key).data?.plans[lena.uid]?.tasks[0]
    try {
      await eventually(() => m1() !== undefined)
      await crossOutTask(space, month(OPEN), 'm1', 'The camera broke')
      const stored = await adminGet(`${listPath(OPEN)}/plans/${lena.uid}`)
      expect(stored?.cancels['1:m1'].why).toBe('The camera broke')
      await eventually(() => m1()?.cancel?.cancelled === true)
      await rejectsWith(setMonthlyTaskDone(space, OPEN, 'm1a', true), CROSSED_OUT_TICK)
      await undoCrossOut(space, month(OPEN), 'm1')
      await eventually(() => m1()?.cancel?.cancelled === false)
      await setMonthlyTaskDone(space, OPEN, 'm1a', true)
      expect((await adminGet(`${listPath(OPEN)}/progress/${lena.uid}`))?.done).toEqual({ m1a: true })
    } finally {
      release()
      forget(key)
    }
    await rejectsWith(crossOutTask(space, month(EARLY), 'e1', 'Too early'), 'Your June list hasn’t locked yet, so you can still delete the task.')
    await as(kim)
    await rejectsWith(crossOutTask(space, month(OPEN), 'k1', 'Judging'), JUDGING_MONTH)
  })
})

describe('the fair vote', () => {
  const W = '2026-08-10'
  const M = '2025-05'

  beforeAll(async () => {
    const crossedOut = { tasks: [{ id: 'x1', title: 'Swim' }, { id: 'x2', title: 'Run' }], cancels: { '1:x1': { at: old(), why: 'Pool closed' } }, updatedAt: old() }
    await seed({
      [weekPath(W)]: { ...weekDoc('review', [lena.uid, sam.uid, kim.uid]), judges: [kim.uid] },
      [`${weekPath(W)}/plans/${lena.uid}`]: crossedOut,
      [`${weekPath(W)}/plans/${sam.uid}`]: { tasks: [{ id: 's1', title: 'Cook' }], updatedAt: old() },
      [listPath(M)]: listDoc(25 * DAY, -HOUR, [lena.uid, sam.uid, kim.uid], [kim.uid]),
      [`${listPath(M)}/plans/${lena.uid}`]: crossedOut,
    })
  })

  it('is submitted in a week’s reviews and reads back as fair, with the task crossed out', async () => {
    await as(sam)
    await rejectsWith(submitReviews(space, W, [{ revieweeId: lena.uid, marks: { x1: 'Fair' as never } }]), GENERIC)
    await submitReviews(space, W, [{ revieweeId: lena.uid, marks: { x1: 'fair', x2: 1 } }])
    expect((await adminGet(`${weekPath(W)}/reviews/${sam.uid}_${lena.uid}`))?.marks).toEqual({ x1: 'fair', x2: 1 })
    const live = observe(startWeek(id, W, sam.uid))
    const data = (await live.until((l) => l.data?.reviews.length === 1 && l.data.plans[lena.uid] !== undefined)).data!
    live.stop()
    expect(data.reviews[0].marks).toEqual({ x1: 'fair', x2: 1 })
    expect(data.plans[lena.uid].tasks[0].cancel).toMatchObject({ cancelled: true, changes: 1, why: 'Pool closed' })
    // Old clients' marks still go through.
    await as(kim)
    await submitReviews(space, W, [
      { revieweeId: lena.uid, marks: { x1: 0, x2: 0.5 } },
      { revieweeId: sam.uid, marks: { s1: 1 } },
    ])
  })

  it('is submitted in a monthly list’s reviews and reads back as fair', async () => {
    await as(kim)
    await submitMonthlyReviews(space, M, [{ revieweeId: lena.uid, marks: { x1: 'fair', x2: 0 } }])
    expect((await adminGet(`${listPath(M)}/reviews/${kim.uid}_${lena.uid}`))?.marks).toEqual({ x1: 'fair', x2: 0 })
    const live = observe(startMonthly(id, M, kim.uid))
    const data = (await live.until((l) => l.data?.reviews.length === 1 && l.data.plans[lena.uid] !== undefined)).data!
    live.stop()
    expect(data.reviews[0].marks).toEqual({ x1: 'fair', x2: 0 })
    expect(data.plans[lena.uid].tasks[0].cancel?.cancelled).toBe(true)
  })
})
