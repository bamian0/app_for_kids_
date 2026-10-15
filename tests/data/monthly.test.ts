// Monthly lists (SPEC §9.5) against the emulators. A list can only be made from 8 days before its month's
// first week until its second week's lists lock, so most of this file runs the real rules on a moved clock
// (travelTo): a month four months ahead, walked through from before its window to its review.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deleteMyAccount, ensureSpace, removeMember, saveMonthlyPlan, setJudge, setMonthlyTaskDone, submitMonthlyReviews } from '../../src/data/api.ts'
import { ensureMonthly, monthListCounts, startMonthData, startMonthly } from '../../src/data/monthly.ts'
import { now } from '../../src/domain/clock.ts'
import { addMonths, monthlyBounds, monthlyWeeks, weekBounds, weekIdsInMonth } from '../../src/domain/time.ts'
import type { MonthlyData, Space } from '../../src/domain/types.ts'
import {
  adminGet,
  adminSpace,
  as,
  boundsDoc,
  createUser,
  DAY,
  HOUR,
  observe,
  PASSWORD,
  rejectsWith,
  resetClock,
  seed,
  setupEmulators,
  spaceDoc,
  teardownEmulators,
  travelBack,
  travelTo,
  ts,
  type TestUser,
} from './helpers.ts'

const CLOSED = 'You can’t change this anymore.'
const NOT_IN_LIST = 'This month’s list started without you. You’re in from next month.'

let lena: TestUser
let sam: TestUser
let kim: TestUser
let ben: TestUser
let ivy: TestUser

const month = addMonths(new Date().toISOString().slice(0, 7), 4)
const { first, lock, last } = monthlyWeeks(month)
/** Minutes after a week's Monday 00:00 (UTC). */
const at = (weekId: string, minutes: number) => weekBounds(weekId, 'UTC').startAt + minutes * 60_000
const id = 'monthly'
const listPath = `spaces/${id}/monthly/${month}`
const ms = (v: { toMillis(): number } | undefined) => v?.toMillis()

async function space(): Promise<Space> {
  return adminSpace(id)
}

beforeAll(async () => {
  await setupEmulators()
  resetClock()
  lena = await createUser('Lena')
  sam = await createUser('Sam')
  kim = await createUser('Kim')
  ben = await createUser('Ben')
  ivy = await createUser('Ivy')
})
afterAll(async () => {
  await travelBack()
  await teardownEmulators()
})

describe('upkeep', () => {
  it('makes nothing more than 8 days before the month’s first week', async () => {
    await travelTo(weekBounds(first, 'UTC').startAt - 9 * DAY)
    const joined = now() - 40 * DAY
    await seed({
      [`spaces/${id}`]: spaceDoc({ ownerId: lena.uid, memberIds: [lena.uid, sam.uid, kim.uid, ben.uid], createdAt: joined, joinedAt: joined, extra: { judges: [kim.uid] } }),
    })
    await as(lena)
    await ensureMonthly(await space(), month)
    expect(await adminGet(listPath)).toBeUndefined()
  })

  it('in its first week, makes the list on its weeks’ times with every member and the space’s judges', async () => {
    await travelTo(at(first, 2 * 1440 + 600))
    await as(sam)
    await ensureSpace(await space())
    const list = await adminGet(listPath)
    const expected = monthlyBounds(month, (w) => weekBounds(w, 'UTC'))
    expect([ms(list?.startAt), ms(list?.lockAt), ms(list?.reviewOpenAt), ms(list?.deadlineAt)]).toEqual([expected.startAt, expected.lockAt, expected.reviewOpenAt, expected.deadlineAt])
    expect(list).toMatchObject({ members: [lena.uid, sam.uid, kim.uid, ben.uid], judges: [kim.uid], submittedBy: [] })
    expect(Object.keys(list ?? {}).sort()).toEqual(['deadlineAt', 'judges', 'lockAt', 'members', 'reviewOpenAt', 'startAt', 'submittedBy'])
    // Its lock is the second week's stored lock.
    expect(ms(list?.lockAt)).toBe(ms((await adminGet(`spaces/${id}/weeks/${lock}`))?.lockAt))
  })

  it('switching role moves the open list’s judges with the space’s', async () => {
    await as(sam)
    await setJudge(id, true)
    expect((await adminGet(listPath))?.judges).toEqual([kim.uid, sam.uid])
    await setJudge(id, false)
    expect((await adminGet(listPath))?.judges).toEqual([kim.uid])
  })

  it('adds someone who joined while it’s open; only the owner takes out someone an older app left behind', async () => {
    // Ivy joins; Ben leaves with an older app, which leaves him in the list.
    const s = await adminSpace(id)
    await seed({
      [`spaces/${id}`]: spaceDoc({
        ownerId: lena.uid, memberIds: [lena.uid, sam.uid, kim.uid, ivy.uid], createdAt: s.createdAt, joinedAt: now() - 40 * DAY,
        extra: { judges: [kim.uid], leftAt: { [ben.uid]: ts(Date.now()) } },
      }),
    })
    await as(sam)
    await ensureMonthly(await space(), month)
    expect((await adminGet(listPath))?.members).toEqual([lena.uid, sam.uid, kim.uid, ben.uid, ivy.uid])
    await as(lena)
    await ensureMonthly(await space(), month)
    expect((await adminGet(listPath))?.members).toEqual([lena.uid, sam.uid, kim.uid, ivy.uid])
  })

  it('removing someone, or deleting your account, takes you out of a list that hasn’t locked', async () => {
    // The owner removes Ivy; then Ben, back in the space, deletes his account.
    await as(lena)
    await removeMember(id, ivy.uid)
    expect((await adminGet(listPath))?.members).toEqual([lena.uid, sam.uid, kim.uid])
    expect((await adminGet(`spaces/${id}`))?.memberIds).toEqual([lena.uid, sam.uid, kim.uid])
    await seed({
      [`spaces/${id}`]: spaceDoc({
        ownerId: lena.uid, memberIds: [lena.uid, sam.uid, kim.uid, ben.uid], createdAt: now() - 40 * DAY, joinedAt: now() - 40 * DAY,
        extra: { judges: [kim.uid], leftAt: { [ivy.uid]: ts(Date.now()) } },
      }),
    })
    // (Kim's upkeep: each member list runs once per session, and Sam's ran with this one before.)
    await as(kim)
    await ensureMonthly(await space(), month)
    expect((await adminGet(listPath))?.members).toEqual([lena.uid, sam.uid, kim.uid, ben.uid])
    await as(ben)
    await deleteMyAccount(PASSWORD)
    expect((await adminGet(listPath))?.members).toEqual([lena.uid, sam.uid, kim.uid])
  })
})

describe('planning, ticking and reviewing', () => {
  it('plans before the lock; a judge has no list; at most 25 tasks', async () => {
    await travelTo(at(first, 2 * 1440 + 720))
    await as(lena)
    await saveMonthlyPlan(await space(), month, [
      { id: 'm1', title: 'Finish the short film' },
      { id: 'm2', title: 'Read two books', subtasks: [{ id: 'b1', title: 'Book one' }, { id: 'b2', title: 'Book two' }] },
      { id: 'm3', title: '  ' },
    ])
    expect((await adminGet(`${listPath}/plans/${lena.uid}`))?.tasks).toEqual([
      { id: 'm1', title: 'Finish the short film' },
      { id: 'm2', title: 'Read two books', subs: ['b1|Book one', 'b2|Book two'] },
    ])
    await as(sam)
    await saveMonthlyPlan(await space(), month, [{ id: 's1', title: 'Run 100 km' }])
    const many = Array.from({ length: 26 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}` }))
    await rejectsWith(saveMonthlyPlan(await space(), month, many), 'You can plan up to 25 tasks a month.')
    await as(kim)
    await rejectsWith(saveMonthlyPlan(await space(), month, [{ id: 'k1', title: 'Judge things' }]), 'You’re judging this month’s lists, so there’s no list to plan.')
  })

  it('loads the list with the month’s weeks only from the month’s last week', async () => {
    const s = await space()
    expect(monthListCounts(s, month, now())).toBe(false)
    await as(lena)
    const early = observe(startMonthData(id, month, lena.uid, false))
    const data = (await early.until((l) => l.data !== undefined)).data
    expect(data?.weeks.map((w) => w.weekId)).toEqual(weekIdsInMonth(month))
    expect(data?.monthly).toBeUndefined()
    early.stop()
    expect(monthListCounts(s, month, at(last, 0) - 1)).toBe(false)
    expect(monthListCounts(s, month, at(last, 0))).toBe(true)
  })

  it('after the lock, nothing changes on the list, but it’s ticked until its deadline', async () => {
    await travelTo(at(lock, 2 * 1440 + 600))
    await as(lena)
    await rejectsWith(saveMonthlyPlan(await space(), month, [{ id: 'm1', title: 'Changed' }]), CLOSED)
    await setMonthlyTaskDone(await space(), month, 'm1', true)
    await setMonthlyTaskDone(await space(), month, 'b1', true)
    expect((await adminGet(`${listPath}/progress/${lena.uid}`))?.done).toEqual({ m1: true, b1: true })
    // Someone who joins after the lock isn't in this month's list.
    await seed({
      [`spaces/${id}`]: spaceDoc({
        ownerId: lena.uid, memberIds: [lena.uid, sam.uid, kim.uid, ivy.uid], createdAt: now() - 40 * DAY, joinedAt: now() - 40 * DAY,
        extra: { judges: [kim.uid], leftAt: { [ben.uid]: ts(Date.now()) } },
      }),
    })
    await as(ivy)
    await rejectsWith(setMonthlyTaskDone(await space(), month, 'x1', true), NOT_IN_LIST)
    await rejectsWith(saveMonthlyPlan(await space(), month, [{ id: 'x1', title: 'Late' }]), CLOSED)
  })

  it('is reviewed in the month’s last week, in its own submit', async () => {
    await travelTo(at(last, 600))
    await as(sam)
    await rejectsWith(submitMonthlyReviews(await space(), month, [{ revieweeId: lena.uid, marks: { m1: 1, m2: 0.5 } }]), 'Monthly lists are reviewed in the month’s last week.')
    // From the last week on, the month's data carries the list.
    expect(monthListCounts(await space(), month, now())).toBe(true)
    const withList = observe(startMonthData(id, month, sam.uid, true))
    const data = (await withList.until((l) => l.data?.monthly?.monthly != null)).data
    expect(data?.monthly?.plans[lena.uid]?.tasks.map((t) => t.id)).toEqual(['m1', 'm2'])
    withList.stop()

    const list = await adminGet(listPath)
    await travelTo((ms(list?.reviewOpenAt) as number) + HOUR)
    await submitMonthlyReviews(await space(), month, [{ revieweeId: lena.uid, marks: { m1: 1, m2: 0.5 } }])
    expect(await adminGet(`${listPath}/reviews/${sam.uid}_${lena.uid}`)).toMatchObject({ reviewerId: sam.uid, revieweeId: lena.uid, marks: { m1: 1, m2: 0.5 } })
    expect((await adminGet(listPath))?.submittedBy).toEqual([sam.uid])
    await as(kim)
    await submitMonthlyReviews(await space(), month, [{ revieweeId: lena.uid, marks: { m1: 1, m2: 1 } }, { revieweeId: sam.uid, marks: { s1: 0 } }])
    await travelTo((ms(list?.deadlineAt) as number) + HOUR)
    await as(lena)
    await rejectsWith(submitMonthlyReviews(await space(), month, [{ revieweeId: sam.uid, marks: { s1: 1 } }]), CLOSED)
  })
})

describe('the blind reveal', () => {
  it('a revealed list is never published with only your own reviews', async () => {
    await travelBack()
    const old = '2026-06'
    const path = `spaces/old/monthly/${old}`
    const t = Date.now()
    await seed({
      'spaces/old': spaceDoc({ ownerId: lena.uid, memberIds: [lena.uid, sam.uid], inviteCode: 'OLDLIST2' }),
      [path]: { ...boundsDoc({ startAt: t - 30 * DAY, lockAt: t - 22 * DAY, reviewOpenAt: t - 2 * DAY, deadlineAt: t + DAY }, [lena.uid, sam.uid], { judges: [], submittedBy: [lena.uid, sam.uid] }) },
      [`${path}/plans/${lena.uid}`]: { tasks: [{ id: 'l1', title: 'L1' }], updatedAt: ts(t - 25 * DAY) },
      [`${path}/plans/${sam.uid}`]: { tasks: [{ id: 's1', title: 'S1' }], updatedAt: ts(t - 25 * DAY) },
      [`${path}/reviews/${lena.uid}_${sam.uid}`]: { reviewerId: lena.uid, revieweeId: sam.uid, marks: { s1: 1 }, submittedAt: ts(t - DAY) },
      [`${path}/reviews/${sam.uid}_${lena.uid}`]: { reviewerId: sam.uid, revieweeId: lena.uid, marks: { l1: 0 }, submittedAt: ts(t - DAY) },
    })
    await as(lena)
    const states: (MonthlyData | undefined)[] = []
    const live = observe(startMonthly('old', old, lena.uid))
    const stop = startMonthly('old', old, lena.uid)((next) => states.push(next.data))
    await live.until((l) => (l.data?.reviews.length ?? 0) === 2)
    stop()
    live.stop()
    for (const state of states) if (state) expect(state.reviews.length).toBe(2)
  })
})
