// Tasks with steps, tasks added after the lock, and the earnings that follow tasks (SPEC §6.1–§6.3),
// through the same functions the screens call, against the emulators and the real rules.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { doc, serverTimestamp, setDoc } from 'firebase/firestore'
import { addTaskAfterLock, createSpace, joinSpace, savePlan, setBaseline, setTaskDone, setTaskRevenue } from '../../src/data/api.ts'
import { inBackground, moneyKeys, startEarnings, startMoneyState } from '../../src/data/money.ts'
import { forget, peek, watch } from '../../src/data/store.ts'
import { startWeek, weekKey } from '../../src/data/weeks.ts'
import { now } from '../../src/domain/clock.ts'
import { newTaskId } from '../../src/domain/ids.ts'
import { balanceOf, earningId } from '../../src/domain/money.ts'
import { addedAfterLock, computeWeek } from '../../src/domain/scoring.ts'
import { addWeeks, weekIdFor } from '../../src/domain/time.ts'
import type { Earning, MoneyState, Space, Task } from '../../src/domain/types.ts'
import { getFirebase } from '../../src/firebase/app.ts'
import {
  adminGet,
  as,
  createUser,
  eventually,
  observe,
  rejectsWith,
  resetClock,
  seed,
  setupEmulators,
  teardownEmulators,
  ts,
  weekDoc,
  DAY,
  type TestUser,
} from './helpers.ts'

const CLOSED = "You can't change this anymore."
const GENERIC = 'Something went wrong. Try again.'

let alex: TestUser
let sam: TestUser
let space: Space

const nextWeek = () => addWeeks(weekIdFor(now(), space.timezone), 1)
const weekPath = (weekId: string) => `spaces/${space.id}/weeks/${weekId}`
const earningPath = (user: TestUser, weekId: string, taskId: string) => `users/${user.uid}/earnings/${earningId(space.id, weekId, taskId)}`
const earnedAt = async (user: TestUser, weekId: string, taskId: string) => (await adminGet(earningPath(user, weekId, taskId)))?.earnedAt ?? null

beforeAll(async () => {
  await setupEmulators()
  resetClock()
  alex = await createUser('Alex')
  sam = await createUser('Sam')
  await as(alex)
  space = await createSpace({ name: 'Film crew', reward: 'Dinner on me', penalty: 'Coffee for a week' })
  await as(sam)
  await joinSpace(space.inviteCode)
  space = { ...space, memberIds: [alex.uid, sam.uid] }
})
afterAll(teardownEmulators)

describe('tasks with steps', () => {
  it('stores steps as id|title lines and reads them back as subtasks', async () => {
    const W = nextWeek()
    await as(alex)
    await savePlan(space, W, [
      {
        id: 't1',
        title: 'Shoot the ad',
        subtasks: [
          { id: 's1', title: 'Scout the place' },
          { id: 's2', title: 'Rent a\nlens ' },
          { id: 's3', title: '   ' },
        ],
      },
      // addedAt is never written before the lock.
      { id: 't2', title: 'Edit', subtasks: [], addedAt: 123 },
    ])
    const stored = await adminGet(`${weekPath(W)}/plans/${alex.uid}`)
    expect(stored?.tasks).toEqual([
      { id: 't1', title: 'Shoot the ad', subs: ['s1|Scout the place', 's2|Rent a lens'] },
      { id: 't2', title: 'Edit' },
    ])
    expect(Object.keys(stored ?? {}).sort()).toEqual(['tasks', 'updatedAt'])

    const live = observe(startWeek(space.id, W, alex.uid))
    const state = await live.until((l) => l.data?.plans[alex.uid]?.tasks.length === 2)
    live.stop()
    expect(state.data?.plans[alex.uid].tasks).toStrictEqual([
      { id: 't1', title: 'Shoot the ad', subtasks: [{ id: 's1', title: 'Scout the place' }, { id: 's2', title: 'Rent a lens' }] },
      { id: 't2', title: 'Edit' },
    ])
  })

  it('checks steps before writing', async () => {
    const W = nextWeek()
    await as(alex)
    const steps = (n: number, title = 'Step') => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, title }))
    await rejectsWith(savePlan(space, W, [{ id: 't1', title: 'Big', subtasks: steps(9) }]), 'A task can have up to 8 steps.')
    await rejectsWith(savePlan(space, W, [{ id: 't1', title: 'Long', subtasks: steps(1, 'x'.repeat(121)) }]), 'Keep each step under 120 characters.')
    // Step ids are check-off keys: unique across the whole list, and shaped like task ids.
    await rejectsWith(savePlan(space, W, [{ id: 't1', title: 'A', subtasks: [{ id: 't1', title: 'Same as its task' }] }]), GENERIC)
    await rejectsWith(savePlan(space, W, [{ id: 't1', title: 'A', subtasks: [{ id: 'x', title: 'X' }] }, { id: 't2', title: 'B', subtasks: [{ id: 'x', title: 'X' }] }]), GENERIC)
    await rejectsWith(savePlan(space, W, [{ id: 't1', title: 'A', subtasks: [{ id: 'no|bars', title: 'X' }] }]), GENERIC)
    // A full list of full tasks is within the rules' limits.
    const full = Array.from({ length: 25 }, (_, t) => ({ id: `t${t}`, title: `Task ${t}`, subtasks: steps(8).map((s) => ({ ...s, id: `t${t}${s.id}` })) }))
    await savePlan(space, W, full)
    expect((await adminGet(`${weekPath(W)}/plans/${alex.uid}`))?.tasks).toHaveLength(25)
  })

  it('renames and deletes your earnings along with the tasks', async () => {
    const W = nextWeek()
    await as(alex)
    await savePlan(space, W, [{ id: 't1', title: 'Client work' }, { id: 't2', title: 'Pitch' }, { id: 't3', title: 'Edit' }])
    await setTaskRevenue(space, W, { id: 't1', title: 'Client work' }, 800, false)
    await setTaskRevenue(space, W, { id: 't2', title: 'Pitch' }, 0, false)
    // Rename t1, delete t2. Nothing about the earnings holds up the save.
    await savePlan(space, W, [{ id: 't1', title: 'Client work for Nike ' }, { id: 't3', title: 'Edit' }])
    await eventually(async () => (await adminGet(earningPath(alex, W, 't1')))?.title === 'Client work for Nike')
    await eventually(async () => (await adminGet(earningPath(alex, W, 't2'))) === undefined)
    expect(await adminGet(earningPath(alex, W, 't1'))).toMatchObject({ amount: 800, earnedAt: null, taskId: 't1', weekId: W, spaceId: space.id })
  })

  it('never deletes the earning of a task that is about to be saved', async () => {
    const W = nextWeek()
    await as(alex)
    // The open week (as on the week screen) and the earnings list (as for the amounts on it).
    const releaseWeek = watch(weekKey(alex.uid, space.id, W), startWeek(space.id, W, alex.uid), () => {})
    const releaseEarnings = watch(moneyKeys.earnings(alex.uid), startEarnings(alex.uid), () => {})
    try {
      await savePlan(space, W, [{ id: 't1', title: 'Client work' }])
      // The task sheet switches revenue on for a new task before the list editor saves it...
      await setTaskRevenue(space, W, { id: 'new1', title: 'Wedding' }, 1200, false)
      // ...while an earlier save, without it, is still going out.
      await savePlan(space, W, [{ id: 't1', title: 'Client work, day 2' }])
      await eventually(async () => (await adminGet(earningPath(alex, W, 't1')))?.title === 'Client work, day 2')
      expect(await adminGet(earningPath(alex, W, 'new1'))).toMatchObject({ title: 'Wedding', amount: 1200 })
    } finally {
      releaseWeek()
      releaseEarnings()
      forget(weekKey(alex.uid, space.id, W))
      forget(moneyKeys.earnings(alex.uid))
    }
  })
})

describe('adding tasks after the lock', () => {
  const ACTIVE = '2026-07-06'
  const REVIEW = '2026-07-13'
  const FULL = '2026-07-20'
  const ALONE = '2026-07-27'

  beforeAll(async () => {
    const old = ts(Date.now() - 3 * DAY)
    await seed({
      [weekPath(ACTIVE)]: weekDoc('active', [alex.uid, sam.uid]),
      [`${weekPath(ACTIVE)}/plans/${alex.uid}`]: { tasks: [{ id: 'a1', title: 'Planned', subs: ['a1s|Step'] }], updatedAt: old },
      [weekPath(REVIEW)]: weekDoc('review', [alex.uid, sam.uid]),
      [weekPath(FULL)]: weekDoc('active', [alex.uid, sam.uid]),
      [`${weekPath(FULL)}/plans/${alex.uid}`]: { tasks: Array.from({ length: 25 }, (_, i) => ({ id: `f${i}`, title: `F${i}` })), updatedAt: old },
      [weekPath(ALONE)]: weekDoc('active', [alex.uid]),
    })
  })

  it('appends one task with its steps; the rest of the list stays as it was', async () => {
    await as(alex)
    const before = Date.now()
    const task = await addTaskAfterLock(space, ACTIVE, { title: '  Client work ', subtasks: ['Call them', ' ', 'Send the\ninvoice'] })
    expect(task).toMatchObject({ title: 'Client work', subtasks: [{ title: 'Call them' }, { title: 'Send the invoice' }] })
    expect(task.addedAt).toBeGreaterThanOrEqual(before)
    expect(task.subtasks?.every((s) => /^[a-z][a-z0-9]{9}$/.test(s.id))).toBe(true)

    const stored = await adminGet(`${weekPath(ACTIVE)}/plans/${alex.uid}`)
    expect(stored?.tasks).toEqual([
      { id: 'a1', title: 'Planned', subs: ['a1s|Step'] },
      { id: task.id, title: 'Client work', subs: task.subtasks?.map((s) => `${s.id}|${s.title}`) },
    ])
    expect(Object.keys(stored?.added)).toEqual([task.id])
    expect(stored?.added[task.id].toMillis()).toBeGreaterThan(before - 60_000)

    // A second one adds its own key to `added` and keeps the first.
    const second = await addTaskAfterLock(space, ACTIVE, { title: 'Pitch deck' })
    expect(second.subtasks).toBeUndefined()
    const again = await adminGet(`${weekPath(ACTIVE)}/plans/${alex.uid}`)
    expect(again?.tasks.map((t: Task) => t.id)).toEqual(['a1', task.id, second.id])
    expect(again?.tasks[2]).toEqual({ id: second.id, title: 'Pitch deck' })
    expect(Object.keys(again?.added).sort()).toEqual([task.id, second.id].sort())

    // Everyone sees when it was added.
    await as(sam)
    const live = observe(startWeek(space.id, ACTIVE, sam.uid))
    const state = await live.until((l) => l.data?.plans[alex.uid]?.tasks.length === 3)
    live.stop()
    const [planned, added] = state.data!.plans[alex.uid].tasks
    const lockAt = state.data!.week!.lockAt
    expect(addedAfterLock(planned, lockAt)).toBe(false)
    expect(addedAfterLock(added, lockAt)).toBe(true)
    expect(Math.abs((added.addedAt ?? 0) - Date.now())).toBeLessThan(60_000)
    const result = computeWeek(state.data!, space, now())
    expect(result.members[alex.uid].taskCount).toBe(3)
    expect(result.members[alex.uid].tasks[1]).toMatchObject({ addedAt: added.addedAt, subtasks: [{ done: false }, { done: false }] })
  })

  it('trying again after an add went through doesn’t add the task twice', async () => {
    await as(alex)
    const id = newTaskId()
    await addTaskAfterLock(space, ACTIVE, { id, title: 'Send the invoice' })
    // The answer was lost (offline, a retried transaction): the same add again is simply done.
    await addTaskAfterLock(space, ACTIVE, { id, title: 'Send the invoice' })
    const stored = await adminGet(`${weekPath(ACTIVE)}/plans/${alex.uid}`)
    expect(stored?.tasks.filter((t: Task) => t.id === id)).toEqual([{ id, title: 'Send the invoice' }])
    expect(Object.keys(stored?.added).filter((key) => key === id)).toHaveLength(1)
    await rejectsWith(addTaskAfterLock(space, ACTIVE, { id: 'not|an id', title: 'X' }), GENERIC)
  })

  it('a copy of a task from the lock counts once, and doesn’t make the original look added', async () => {
    const DUP = '2026-08-17'
    await seed({
      [weekPath(DUP)]: weekDoc('active', [alex.uid, sam.uid]),
      [`${weekPath(DUP)}/plans/${alex.uid}`]: { tasks: [{ id: 't0', title: 'Finish the edit' }, { id: 't1', title: 'Call the client' }], updatedAt: ts(Date.now() - 3 * DAY) },
      [`${weekPath(DUP)}/progress/${alex.uid}`]: { done: { t1: true }, updatedAt: ts(Date.now() - DAY) },
    })
    await as(alex)
    // Written by hand, not by the app: the rules can't tell the id is already on the list.
    await setDoc(doc(getFirebase().db, `${weekPath(DUP)}/plans/${alex.uid}`), {
      tasks: [{ id: 't0', title: 'Finish the edit' }, { id: 't1', title: 'Call the client' }, { id: 't1', title: 'Call the client' }],
      added: { t1: serverTimestamp() },
      updatedAt: serverTimestamp(),
    })
    await as(sam)
    const live = observe(startWeek(space.id, DUP, sam.uid))
    const state = await live.until((l) => (l.data?.plans[alex.uid]?.updatedAt ?? 0) > Date.now() - 60_000)
    live.stop()
    expect(state.data!.plans[alex.uid].tasks).toStrictEqual([
      { id: 't0', title: 'Finish the edit' },
      { id: 't1', title: 'Call the client' },
    ])
    const result = computeWeek(state.data!, space, now()).members[alex.uid]
    expect(result.taskCount).toBe(2)
    expect(result.provisionalScore).toBe(50)
  })

  it('someone with no list at the lock can start one this way', async () => {
    await as(sam)
    const task = await addTaskAfterLock(space, ACTIVE, { title: 'Color grade' })
    expect((await adminGet(`${weekPath(ACTIVE)}/plans/${sam.uid}`))?.tasks).toEqual([{ id: task.id, title: 'Color grade' }])
  })

  it('an added task is final: the list can no longer be saved', async () => {
    await as(alex)
    await rejectsWith(savePlan(space, ACTIVE, [{ id: 'a1', title: 'Planned' }]), CLOSED)
  })

  it('explains every refusal', async () => {
    await as(alex)
    await rejectsWith(addTaskAfterLock(space, ACTIVE, { title: '   ' }), 'Give the task a title.')
    await rejectsWith(addTaskAfterLock(space, ACTIVE, { title: 'x'.repeat(121) }), 'Keep each task under 120 characters.')
    await rejectsWith(addTaskAfterLock(space, ACTIVE, { title: 'Big', subtasks: Array.from({ length: 9 }, (_, i) => `Step ${i}`) }), 'A task can have up to 8 steps.')
    await rejectsWith(addTaskAfterLock(space, ACTIVE, { title: 'Long', subtasks: ['x'.repeat(121)] }), 'Keep each step under 120 characters.')
    await rejectsWith(addTaskAfterLock(space, nextWeek(), { title: 'Early' }), 'Your list hasn’t locked yet. Add the task to it instead.')
    await rejectsWith(addTaskAfterLock(space, REVIEW, { title: 'Late' }), 'Adding tasks closes when reviews open on Friday.')
    await rejectsWith(addTaskAfterLock(space, FULL, { title: 'One more' }), 'You can plan up to 25 tasks a week.')
    await rejectsWith(addTaskAfterLock({ ...space, memberIds: [sam.uid] }, ACTIVE, { title: 'Gone' }), 'You’re no longer in this space.')
    await as(sam)
    // Sam joined after this week locked.
    await rejectsWith(addTaskAfterLock(space, ALONE, { title: 'Sneaking in' }), "You joined after this week's lists locked. You're in from next week.")
    expect(await adminGet(`${weekPath(ALONE)}/plans/${sam.uid}`)).toBeUndefined()
    expect((await adminGet(`${weekPath(FULL)}/plans/${alex.uid}`))?.tasks).toHaveLength(25)
  })
})

describe('check-offs keep the task’s earning in step', () => {
  const W = '2026-08-03'

  beforeAll(async () => {
    await seed({
      [weekPath(W)]: weekDoc('active', [alex.uid, sam.uid]),
      [`${weekPath(W)}/plans/${alex.uid}`]: {
        tasks: [{ id: 'c1', title: 'Client work', subs: ['c1a|Call', 'c1b|Deliver'] }, { id: 'p1', title: 'Plain' }, { id: 'q1', title: 'No revenue' }],
        updatedAt: ts(Date.now() - 3 * DAY),
      },
    })
  })

  it('ticking the last step earns it, unticking any step un-earns it (from what the device has)', async () => {
    await as(alex)
    const releaseWeek = watch(weekKey(alex.uid, space.id, W), startWeek(space.id, W, alex.uid), () => {})
    const releaseEarnings = watch(moneyKeys.earnings(alex.uid), startEarnings(alex.uid), () => {})
    try {
      await eventually(() => peek(weekKey(alex.uid, space.id, W)).data !== undefined)
      await setTaskRevenue(space, W, { id: 'c1', title: 'Client work' }, 800, false)
      await setTaskRevenue(space, W, { id: 'p1', title: 'Plain' }, 50, false)
      await eventually(() => peek<Earning[]>(moneyKeys.earnings(alex.uid)).data?.filter((e) => e.weekId === W).length === 2)

      await setTaskDone(space, W, 'c1a', true)
      expect(await earnedAt(alex, W, 'c1')).toBeNull()
      // One batch with the check-off: earned the moment the call resolves.
      await setTaskDone(space, W, 'c1b', true)
      const earned = await earnedAt(alex, W, 'c1')
      expect(earned?.toMillis()).toBeGreaterThan(Date.now() - 60_000)
      // The task's own key means nothing for a task with steps.
      await setTaskDone(space, W, 'c1', false)
      expect((await earnedAt(alex, W, 'c1'))?.toMillis()).toBe(earned.toMillis())
      await setTaskDone(space, W, 'c1a', false)
      expect(await earnedAt(alex, W, 'c1')).toBeNull()

      await setTaskDone(space, W, 'p1', true)
      expect(await earnedAt(alex, W, 'p1')).not.toBeNull()
      await setTaskDone(space, W, 'p1', false)
      expect(await earnedAt(alex, W, 'p1')).toBeNull()
      // A task without revenue: just the check-off.
      await setTaskDone(space, W, 'q1', true)
      expect(await adminGet(earningPath(alex, W, 'q1'))).toBeUndefined()
      expect((await adminGet(`${weekPath(W)}/progress/${alex.uid}`))?.done).toEqual({ c1a: false, c1b: true, c1: false, p1: false, q1: true })
    } finally {
      releaseWeek()
      releaseEarnings()
      forget(weekKey(alex.uid, space.id, W))
      forget(moneyKeys.earnings(alex.uid))
    }
  })

  it('two quick ticks on the last two steps still earn the task', async () => {
    const QUICK = '2026-08-24'
    await seed({
      [weekPath(QUICK)]: weekDoc('active', [alex.uid, sam.uid]),
      [`${weekPath(QUICK)}/plans/${alex.uid}`]: { tasks: [{ id: 'd1', title: 'Deliver', subs: ['d1a|Export', 'd1b|Upload'] }], updatedAt: ts(Date.now() - 3 * DAY) },
    })
    await as(alex)
    const releaseWeek = watch(weekKey(alex.uid, space.id, QUICK), startWeek(space.id, QUICK, alex.uid), () => {})
    const releaseEarnings = watch(moneyKeys.earnings(alex.uid), startEarnings(alex.uid), () => {})
    try {
      await eventually(() => peek(weekKey(alex.uid, space.id, QUICK)).data !== undefined)
      await setTaskRevenue(space, QUICK, { id: 'd1', title: 'Deliver' }, 300, false)
      await eventually(() => peek<Earning[]>(moneyKeys.earnings(alex.uid)).data?.some((e) => e.taskId === 'd1') === true)
      // The second tap comes before the first has written anything: it must still see the first.
      await Promise.all([setTaskDone(space, QUICK, 'd1a', true), setTaskDone(space, QUICK, 'd1b', true)])
      expect((await adminGet(`${weekPath(QUICK)}/progress/${alex.uid}`))?.done).toEqual({ d1a: true, d1b: true })
      expect(await earnedAt(alex, QUICK, 'd1')).not.toBeNull()
    } finally {
      releaseWeek()
      releaseEarnings()
      forget(weekKey(alex.uid, space.id, QUICK))
      forget(moneyKeys.earnings(alex.uid))
    }
  })

  it('a refused check-off doesn’t hold up the next one', async () => {
    const OVER = '2026-06-29'
    await seed({ [weekPath(OVER)]: weekDoc('closed', [alex.uid, sam.uid]) })
    await as(alex)
    await rejectsWith(setTaskDone(space, OVER, 'x1', true), CLOSED)
    await rejectsWith(setTaskDone(space, OVER, 'x1', true), CLOSED)
  })

  it('catches up from the server when this device has nothing cached', async () => {
    // Sam's list and earning were written elsewhere (another device): this client has never seen them.
    const id = earningId(space.id, W, 'v1')
    await seed({
      [`${weekPath(W)}/plans/${sam.uid}`]: { tasks: [{ id: 'v1', title: 'Video', subs: ['v1a|Cut', 'v1b|Export'] }], updatedAt: ts(Date.now() - 3 * DAY) },
      [`users/${sam.uid}/earnings/${id}`]: { spaceId: space.id, weekId: W, taskId: 'v1', title: 'Video', amount: 400, earnedAt: null, updatedAt: ts(Date.now() - DAY) },
    })
    await as(sam)
    await setTaskDone(space, W, 'v1a', true)
    await setTaskDone(space, W, 'v1b', true)
    await eventually(async () => (await earnedAt(sam, W, 'v1')) !== null)
    await setTaskDone(space, W, 'v1b', false)
    await eventually(async () => (await earnedAt(sam, W, 'v1')) === null)
    expect((await adminGet(`${weekPath(W)}/progress/${sam.uid}`))?.done).toEqual({ v1a: true, v1b: false })
  })

  it('switching revenue on for a done task earns it now; changing the amount keeps when', async () => {
    await as(alex)
    await setTaskRevenue(space, W, { id: 'q1', title: 'No revenue' }, null, true)
    await setTaskRevenue(space, W, { id: 'q1', title: 'Now revenue' }, 120.5, true)
    const first = await adminGet(earningPath(alex, W, 'q1'))
    expect(first).toMatchObject({ title: 'Now revenue', amount: 120.5, taskId: 'q1' })
    expect(first?.earnedAt.toMillis()).toBeGreaterThan(Date.now() - 60_000)
    await setTaskRevenue(space, W, { id: 'q1', title: 'Now revenue' }, 300, true)
    const second = await adminGet(earningPath(alex, W, 'q1'))
    expect(second?.amount).toBe(300)
    expect(second?.earnedAt.toMillis()).toBe(first?.earnedAt.toMillis())
    await setTaskRevenue(space, W, { id: 'q1', title: 'Now revenue' }, 300, false)
    expect(await earnedAt(alex, W, 'q1')).toBeNull()
    await setTaskRevenue(space, W, { id: 'q1', title: 'Now revenue' }, null, false)
    expect(await adminGet(earningPath(alex, W, 'q1'))).toBeUndefined()
    await rejectsWith(setTaskRevenue(space, W, { id: 'q1', title: 'x' }, -5, false), 'Enter an amount.')
    await rejectsWith(setTaskRevenue(space, W, { id: 'q1', title: 'x' }, 2_000_000_000, false), 'That amount is too large.')
  })
})

describe('a full list of steps', () => {
  const W = '2026-08-10'

  it('makes room for the last tick by clearing ticks of deleted tasks', async () => {
    // 25 tasks × 8 steps = 200 step ids, the cap of a progress doc.
    const tasks = Array.from({ length: 25 }, (_, t) => ({ id: `t${t}`, title: `Task ${t}`, subs: Array.from({ length: 8 }, (_, s) => `t${t}s${s}|Step ${s}`) }))
    const steps = tasks.flatMap((t) => t.subs.map((line) => line.slice(0, line.indexOf('|'))))
    // Every step but the last is ticked, plus one tick left by a task deleted on Monday.
    const done = Object.fromEntries([...steps.slice(0, -1).map((id) => [id, true]), ['gone', true]])
    await seed({
      [weekPath(W)]: weekDoc('active', [alex.uid, sam.uid]),
      [`${weekPath(W)}/plans/${alex.uid}`]: { tasks, updatedAt: ts(Date.now() - 3 * DAY) },
      [`${weekPath(W)}/progress/${alex.uid}`]: { done, updatedAt: ts(Date.now() - DAY) },
    })
    await as(alex)
    const release = watch(weekKey(alex.uid, space.id, W), startWeek(space.id, W, alex.uid), () => {})
    try {
      await eventually(() => peek<{ progress: Record<string, unknown> }>(weekKey(alex.uid, space.id, W)).data?.progress[alex.uid] !== undefined)
      await setTaskDone(space, W, steps[steps.length - 1], true)
      const stored = (await adminGet(`${weekPath(W)}/progress/${alex.uid}`))?.done as Record<string, boolean>
      expect(Object.keys(stored)).toHaveLength(200)
      expect(stored.gone).toBeUndefined()
      expect(steps.every((id) => stored[id] === true)).toBe(true)
    } finally {
      release()
      forget(weekKey(alex.uid, space.id, W))
    }
  })
})

describe('money earned before the balance was set', () => {
  const W = '2026-09-07'

  it('stays earned when its task is un-done, so ticking again doesn’t count it twice', async () => {
    await seed({
      [weekPath(W)]: weekDoc('active', [alex.uid, sam.uid]),
      [`${weekPath(W)}/plans/${alex.uid}`]: {
        tasks: [{ id: 'r1', title: 'Wedding' }, { id: 'r2', title: 'Ad', subs: ['r2a|Shoot', 'r2b|Edit'] }],
        updatedAt: ts(Date.now() - 3 * DAY),
      },
    })
    await as(alex)
    const keys = { week: weekKey(alex.uid, space.id, W), earnings: moneyKeys.earnings(alex.uid), state: moneyKeys.state(alex.uid) }
    const releases = [
      watch(keys.week, startWeek(space.id, W, alex.uid), () => {}),
      watch(keys.earnings, startEarnings(alex.uid), () => {}),
      watch(keys.state, startMoneyState(alex.uid), () => {}),
    ]
    const stored = async (taskId: string) => (await earnedAt(alex, W, taskId))?.toMillis() ?? null
    try {
      await eventually(() => peek(keys.week).data !== undefined && peek(keys.state).data !== undefined)
      await setTaskRevenue(space, W, { id: 'r1', title: 'Wedding' }, 500, false)
      await setTaskRevenue(space, W, { id: 'r2', title: 'Ad' }, 300, false)
      await eventually(() => peek<Earning[]>(keys.earnings).data?.filter((e) => e.weekId === W).length === 2)
      await setTaskDone(space, W, 'r1', true)
      await setTaskDone(space, W, 'r2a', true)
      await setTaskDone(space, W, 'r2b', true)
      const r1 = await stored('r1')
      const r2 = await stored('r2')
      expect(r1).not.toBeNull()
      expect(r2).not.toBeNull()

      // "I have 1,500 now": both earnings are in it.
      await setBaseline(1500)
      const baselineAt = (await adminGet(`users/${alex.uid}/money/state`))?.baselineAt.toMillis()
      await eventually(() => peek<MoneyState | null>(keys.state).data?.baselineAt === baselineAt)

      // A mis-tap and a fix, from what this device has: the money stays where it was.
      await setTaskDone(space, W, 'r1', false)
      expect(await stored('r1')).toBe(r1)
      await setTaskDone(space, W, 'r1', true)
      expect(await stored('r1')).toBe(r1)
      // So does changing the amount of a task that isn't done.
      await setTaskDone(space, W, 'r1', false)
      await setTaskRevenue(space, W, { id: 'r1', title: 'Wedding' }, 600, false)
      expect(await adminGet(earningPath(alex, W, 'r1'))).toMatchObject({ amount: 600 })
      expect(await stored('r1')).toBe(r1)

      // From the server, when this device has no earnings cached.
      releases[1]()
      forget(keys.earnings)
      await setTaskDone(space, W, 'r2b', false)
      await setTaskDone(space, W, 'r2b', true)
      await inBackground(`${alex.uid}|earning|${space.id}|${W}`, async () => {})
      expect(await stored('r2')).toBe(r2)

      const earnings = observe(startEarnings(alex.uid))
      const all = (await earnings.until((l) => l.data?.some((e) => e.taskId === 'r1' && e.amount === 600) === true)).data!
      earnings.stop()
      expect(balanceOf(peek<MoneyState | null>(keys.state).data ?? null, all, [])).toBe(1500)
    } finally {
      releases.forEach((release) => release())
      Object.values(keys).forEach(forget)
    }
  })
})
