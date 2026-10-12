import { describe, expect, it } from 'vitest'
import type { Mark, Space, Task, UID, WeekData, WeekId } from '../src/domain/types.ts'
import { dueWindows, formatPercent, hoursFromNow, isNudge, listNames, offsetToStore, planReminders, planSpace, reminderKey, type PlanResult } from './reminders-plan.ts'

// Europe/Berlin is UTC+2 until Sun 2026-10-25, UTC+1 after. Bounds are written out explicitly.
const at = (iso: string) => Date.parse(iso)
type Bounds = { startAt: number; lockAt: number; reviewOpenAt: number; deadlineAt: number }
const BOUNDS: Record<WeekId, Bounds> = {
  '2026-10-05': { startAt: at('2026-10-04T22:00Z'), lockAt: at('2026-10-05T22:00Z'), reviewOpenAt: at('2026-10-08T22:00Z'), deadlineAt: at('2026-10-09T22:00Z') },
  '2026-10-12': { startAt: at('2026-10-11T22:00Z'), lockAt: at('2026-10-12T22:00Z'), reviewOpenAt: at('2026-10-15T22:00Z'), deadlineAt: at('2026-10-16T22:00Z') },
}
const W = '2026-10-12'
const OCTOBER_WEEKS = ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']

const PROFILES = { a: { name: 'Anna' }, b: { name: 'Ben' }, c: { name: 'Chris' }, d: { name: 'Dana' } }

function makeSpace(overrides: Partial<Space> = {}): Space {
  return {
    id: 's1',
    name: 'Film Club',
    reward: 'Dinner on me',
    penalty: 'Coffee for a week',
    ownerId: 'a',
    memberIds: ['a', 'b', 'c', 'd'],
    joinedAt: {},
    timezone: 'Europe/Berlin',
    inviteCode: 'ABCD2345',
    threshold: 90,
    latePenalty: 5,
    createdAt: 0,
    ...overrides,
  }
}

interface WeekSpec {
  members?: UID[]
  submittedBy?: UID[]
  /** Task count per member; task ids are `${uid}1`, `${uid}2`, … */
  plans?: Record<UID, number>
  /** Whole task lists, for tasks with steps (instead of `plans`). */
  tasks?: Record<UID, Task[]>
  done?: Record<UID, string[]>
  reviews?: [reviewer: UID, reviewee: UID, marks: Record<string, Mark>][]
}

function makeWeek(weekId: WeekId, spec: WeekSpec | null, spaceId = 's1', bounds: Bounds = BOUNDS[weekId]): WeekData {
  const data: WeekData = { spaceId, weekId, week: null, plans: {}, progress: {}, reviews: [] }
  if (!spec) return data
  data.week = { id: weekId, spaceId, ...bounds, members: spec.members ?? [], submittedBy: spec.submittedBy ?? [] }
  for (const [uid, n] of Object.entries(spec.plans ?? {})) {
    data.plans[uid] = { uid, updatedAt: 0, tasks: Array.from({ length: n }, (_, i) => ({ id: `${uid}${i + 1}`, title: `Task ${i + 1}` })) }
  }
  for (const [uid, tasks] of Object.entries(spec.tasks ?? {})) data.plans[uid] = { uid, updatedAt: 0, tasks }
  for (const [uid, ids] of Object.entries(spec.done ?? {})) {
    data.progress[uid] = { uid, updatedAt: 0, done: Object.fromEntries(ids.map((id) => [id, true])) }
  }
  data.reviews = (spec.reviews ?? []).map(([reviewerId, revieweeId, marks]) => ({
    id: `${reviewerId}_${revieweeId}`,
    reviewerId,
    revieweeId,
    marks,
    submittedAt: bounds.reviewOpenAt,
  }))
  return data
}

function plan(space: Space, weeks: WeekData[], nowMs: number, sent: string[] = []): PlanResult {
  const byId = Object.fromEntries(weeks.map((w) => [w.weekId, w]))
  return planSpace({ space, weeks: byId }, PROFILES, new Set(sent), nowMs)
}

const kinds = (space: Space, iso: string) => dueWindows(space, at(iso)).map((w) => w.kind)
const bodies = (result: PlanResult) => Object.fromEntries(result.send.map((r) => [r.uid, `${r.title} | ${r.body}`]))
const key = (kind: Parameters<typeof reminderKey>[2], uid: UID, period = W) => reminderKey('s1', period, kind, uid)

describe('dueWindows', () => {
  const berlin = makeSpace()
  const la = makeSpace({ id: 's2', timezone: 'America/Los_Angeles' })

  it('has nothing due in the middle of the week', () => {
    expect(kinds(berlin, '2026-10-14T10:00Z')).toEqual([])
    expect(kinds(berlin, '2026-10-13T08:00Z')).toEqual([])
  })

  it('opens the plan reminder Monday 18:00 local until the list locks', () => {
    expect(kinds(berlin, '2026-10-12T15:59Z')).toEqual([])
    expect(dueWindows(berlin, at('2026-10-12T16:00Z'))).toEqual([
      { kind: 'plan', period: W, weekIds: [W], opensAt: at('2026-10-12T16:00Z'), closesAt: BOUNDS[W].lockAt, expiresAt: BOUNDS[W].lockAt },
    ])
    // A run delayed to 23:59 still sends it.
    expect(kinds(berlin, '2026-10-12T21:59Z')).toEqual(['plan'])
    expect(kinds(berlin, '2026-10-12T22:00Z')).toEqual([])
  })

  it('opens the no-progress nudge Wednesday 18:00 until midnight, the open-tasks nudge Thursday 18:00 until reviews open', () => {
    expect(kinds(berlin, '2026-10-14T15:59Z')).toEqual([])
    expect(dueWindows(berlin, at('2026-10-14T16:00Z'))).toEqual([
      { kind: 'no-progress', period: W, weekIds: [W], opensAt: at('2026-10-14T16:00Z'), closesAt: at('2026-10-14T22:00Z'), expiresAt: at('2026-10-14T22:00Z') },
    ])
    expect(kinds(berlin, '2026-10-14T21:59Z')).toEqual(['no-progress'])
    expect(kinds(berlin, '2026-10-14T22:00Z')).toEqual([])
    expect(kinds(berlin, '2026-10-15T15:59Z')).toEqual([])
    expect(dueWindows(berlin, at('2026-10-15T16:00Z'))).toEqual([
      { kind: 'open-tasks', period: W, weekIds: [W], opensAt: at('2026-10-15T16:00Z'), closesAt: BOUNDS[W].reviewOpenAt, expiresAt: BOUNDS[W].reviewOpenAt },
    ])
    expect(kinds(berlin, '2026-10-15T21:59Z')).toEqual(['open-tasks'])
    expect(kinds(berlin, '2026-10-15T22:00Z')).toEqual([])
  })

  it('opens the review reminder Friday 09:00, then the last call 20:00 until the deadline', () => {
    expect(kinds(berlin, '2026-10-16T06:59Z')).toEqual([])
    expect(kinds(berlin, '2026-10-16T07:00Z')).toEqual(['review'])
    expect(kinds(berlin, '2026-10-16T17:59Z')).toEqual(['review'])
    expect(kinds(berlin, '2026-10-16T18:00Z')).toEqual(['last-call'])
    expect(kinds(berlin, '2026-10-16T21:59Z')).toEqual(['last-call'])
    expect(kinds(berlin, '2026-10-16T22:00Z')).toEqual([])
    const [review] = dueWindows(berlin, at('2026-10-16T07:00Z'))
    expect(review.expiresAt).toBe(BOUNDS[W].deadlineAt)
  })

  it('opens the results reminder Saturday 09:00 through Sunday', () => {
    expect(kinds(berlin, '2026-10-17T06:59Z')).toEqual([])
    expect(dueWindows(berlin, at('2026-10-17T07:00Z'))).toMatchObject([{ kind: 'results', period: W, weekIds: [W] }])
    expect(kinds(berlin, '2026-10-18T21:59Z')).toEqual(['results'])
    expect(kinds(berlin, '2026-10-18T22:00Z')).toEqual([])
  })

  it('opens the verdict for the previous month on the 1st at 10:00 for two days', () => {
    // Sun 2026-11-01 in Berlin (UTC+1): the weekend results window is open too.
    expect(kinds(berlin, '2026-11-01T08:59Z')).toEqual(['results'])
    const windows = dueWindows(berlin, at('2026-11-01T09:00Z'))
    expect(windows.map((w) => w.kind)).toEqual(['results', 'verdict'])
    expect(windows[1]).toMatchObject({ period: '2026-10', weekIds: OCTOBER_WEEKS, closesAt: at('2026-11-02T23:00Z') })
    // Monday 23:59 (the plan window is open too) is the last minute of it.
    expect(kinds(berlin, '2026-11-02T22:59Z')).toEqual(['plan', 'verdict'])
    expect(kinds(berlin, '2026-11-02T23:00Z')).toEqual([])
  })

  it('uses wall-clock time in the space timezone, across a DST change', () => {
    // US DST ends 2026-11-01 02:00, so 10:00 that day is UTC−8.
    expect(kinds(la, '2026-11-01T17:59Z')).not.toContain('verdict')
    expect(kinds(la, '2026-11-01T18:00Z')).toContain('verdict')
    // Friday 18:30Z: 20:30 in Berlin (last call) but 11:30 in Los Angeles (review).
    expect(kinds(berlin, '2026-10-16T18:30Z')).toEqual(['last-call'])
    expect(kinds(la, '2026-10-16T18:30Z')).toEqual(['review'])
  })

  it('handles the year boundary', () => {
    // Fri 2027-01-01 is also review day for the week of Dec 28, which belongs to January.
    expect(dueWindows(makeSpace(), at('2027-01-01T09:30Z'))).toMatchObject([
      { kind: 'review', period: '2026-12-28' },
      { kind: 'verdict', period: '2026-12', weekIds: ['2026-11-30', '2026-12-07', '2026-12-14', '2026-12-21'] },
    ])
  })
})

describe('plan reminder', () => {
  const now = at('2026-10-12T17:17Z') // Monday 19:17

  it('goes to every member with no tasks, joined to the week or not, with the time left', () => {
    const week = makeWeek(W, { members: ['a', 'b'], plans: { a: 2, b: 0 } })
    const result = plan(makeSpace(), [week], now)
    expect(result.send.map((r) => r.uid)).toEqual(['b', 'c', 'd'])
    expect(result.send[0]).toEqual({
      key: 's1_2026-10-12_plan_b',
      kind: 'plan',
      spaceId: 's1',
      uid: 'b',
      title: 'Lock in your week',
      body: 'Your list for Film Club locks in 5 hours. Nothing planned = 0%.',
      url: './',
      tag: 'plan-s1',
      expiresAt: BOUNDS[W].lockAt,
    })
    // Chris isn't in the week yet: he will be once anyone opens the app, so no 0% claim until then.
    expect(result.send[1].body).toBe('Your list for Film Club locks in 5 hours.')
    // Anna can still delete her tasks before lock, so her answer isn't final.
    expect(result.skipped).toEqual([])
  })

  it('goes to everyone when nobody has opened the week yet', () => {
    expect(plan(makeSpace(), [makeWeek(W, null)], now).send.map((r) => r.uid)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('goes by the stored lock: nothing once it has passed', () => {
    const early = makeWeek(W, { members: ['a', 'b'] })
    early.week!.lockAt = at('2026-10-12T17:00Z')
    expect(plan(makeSpace(), [early], now)).toEqual({ send: [], skipped: ['a', 'b', 'c', 'd'].map((u) => key('plan', u)) })
  })
})

describe('midweek nudges', () => {
  const WED = at('2026-10-14T16:17Z') // Wednesday 18:17 in Berlin
  const THU = at('2026-10-15T16:17Z') // Thursday 18:17
  // Anna has two tasks, Ben one with two steps, Chris none, Dana one with a single step and one
  // without. Eve joined after the lock.
  const space = makeSpace({ memberIds: ['a', 'b', 'c', 'd', 'e'] })
  const ben: Task[] = [{ id: 'b1', title: 'Shoot', subtasks: [{ id: 'b1x', title: 'Scout' }, { id: 'b1y', title: 'Rent a lens' }] }]
  const dana: Task[] = [{ id: 'd1', title: 'Edit', subtasks: [{ id: 'd1x', title: 'Rough cut' }] }, { id: 'd2', title: 'Pitch' }]
  const week = (done: Record<UID, string[]> = {}) => makeWeek(W, { members: ['a', 'b', 'c', 'd'], plans: { a: 2 }, tasks: { b: ben, d: dana }, done })
  const everyone = (kind: 'no-progress' | 'open-tasks') => ['a', 'b', 'c', 'd', 'e'].map((u) => key(kind, u))

  it('are the kinds the job loads per person', () => {
    expect((['plan', 'no-progress', 'open-tasks', 'review', 'last-call', 'results', 'verdict'] as const).filter(isNudge)).toEqual(['no-progress', 'open-tasks'])
  })

  it('on Wednesday evening, nudge whoever has ticked nothing on their current list', () => {
    // One of Ben's steps is progress. Dana's ticks are a task deleted before the lock and her stepped
    // task's own key (ignored once it has steps), so she has ticked nothing.
    const data = week({ b: ['b1x'], d: ['gone', 'd1'] })
    // A tick taken back isn't progress either.
    data.progress.a = { uid: 'a', updatedAt: 0, done: { a1: false } }
    const result = plan(space, [data], WED)
    expect(bodies(result)).toEqual({
      a: 'Nothing ticked yet | Halfway through the week in Film Club. 2 tasks to go before Friday.',
      d: 'Nothing ticked yet | Halfway through the week in Film Club. 2 tasks to go before Friday.',
    })
    expect(result.send[0]).toEqual({
      key: 's1_2026-10-12_no-progress_a',
      kind: 'no-progress',
      spaceId: 's1',
      uid: 'a',
      title: 'Nothing ticked yet',
      body: 'Halfway through the week in Film Club. 2 tasks to go before Friday.',
      url: './',
      tag: 'no-progress-s1',
      expiresAt: at('2026-10-14T22:00Z'),
    })
    // Eve isn't in the week and nobody joins it after the lock. Chris can still add a task and Ben
    // can untick his step, so theirs aren't final.
    expect(result.skipped).toEqual([key('no-progress', 'e')])
    const solo = makeWeek(W, { members: ['a'], plans: { a: 1 } })
    expect(plan(makeSpace({ memberIds: ['a'] }), [solo], WED).send[0].body).toBe('Halfway through the week in Film Club. 1 task to go before Friday.')
  })

  it('on Thursday evening, count the tasks still open; a task with steps is done only when every step is', () => {
    // Anna already had Wednesday's nudge. Ben ticked one step of two, Dana finished her stepped task.
    const result = plan(space, [week({ b: ['b1x'], d: ['d1x'] })], THU, [key('no-progress', 'a')])
    expect(bodies(result)).toEqual({
      a: '2 of 2 tasks still open | Reviews in Film Club start in 6 hours. Finish what you can before then.',
      b: '1 of 1 task still open | Reviews in Film Club start in 6 hours. Finish what you can before then.',
      d: '1 of 2 tasks still open | Reviews in Film Club start in 6 hours. Finish what you can before then.',
    })
    expect(result.send[0]).toMatchObject({ key: key('open-tasks', 'a'), kind: 'open-tasks', tag: 'open-tasks-s1', expiresAt: BOUNDS[W].reviewOpenAt })
    // Not Wednesday's tag: replacing a notification still on screen doesn't alert (renotify is off).
    expect(result.send[0].tag).not.toBe(plan(space, [week()], WED).send[0].tag)
    expect(result.skipped).toEqual([key('open-tasks', 'e')])
  })

  it('leave alone whoever has finished, until they untick something', () => {
    // Ben's own key doesn't finish a task with steps.
    const result = plan(space, [week({ a: ['a1', 'a2'], b: ['b1'], d: ['d1x', 'd2'] })], THU)
    expect(result.send.map((r) => r.uid)).toEqual(['b'])
    expect(result.skipped).toEqual([key('open-tasks', 'e')])
  })

  it('open at 18:00 sharp and run to the last minute before midnight', () => {
    const data = week()
    expect(plan(space, [data], at('2026-10-14T15:59Z')).send).toEqual([])
    expect(plan(space, [data], at('2026-10-14T16:00Z')).send.map((r) => `${r.kind}:${r.uid}`)).toEqual(['no-progress:a', 'no-progress:b', 'no-progress:d'])
    expect(plan(space, [data], at('2026-10-14T21:59Z')).send.map((r) => r.uid)).toEqual(['a', 'b', 'd'])
    expect(plan(space, [data], at('2026-10-14T22:00Z'))).toEqual({ send: [], skipped: [] })
    expect(plan(space, [data], at('2026-10-15T15:59Z'))).toEqual({ send: [], skipped: [] })
    expect(bodies(plan(space, [data], at('2026-10-15T16:00Z'))).a).toBe('2 of 2 tasks still open | Reviews in Film Club start in 6 hours. Finish what you can before then.')
    expect(bodies(plan(space, [data], at('2026-10-15T21:59Z'))).a).toBe('2 of 2 tasks still open | Reviews in Film Club start in under an hour. Finish what you can before then.')
    expect(plan(space, [data], at('2026-10-15T22:00Z'))).toEqual({ send: [], skipped: [] })
  })

  it('go by the stored review opening: nothing once it has passed', () => {
    // Someone created the week with reviews opening an hour early, at Thursday 23:00.
    const early = week()
    early.week!.reviewOpenAt = at('2026-10-15T21:00Z')
    expect(bodies(plan(space, [early], at('2026-10-15T20:17Z'))).a).toBe('2 of 2 tasks still open | Reviews in Film Club start in 1 hour. Finish what you can before then.')
    expect(plan(space, [early], at('2026-10-15T21:17Z'))).toEqual({ send: [], skipped: everyone('open-tasks') })
  })

  it('skip everyone when nobody opened the week before it locked', () => {
    expect(plan(space, [makeWeek(W, null)], WED)).toEqual({ send: [], skipped: everyone('no-progress') })
  })

  it('reach only current members: someone who left after the lock still counts for the week, unnudged', () => {
    const data = makeWeek(W, { members: ['a', 'b'], plans: { a: 1, b: 1 } })
    const left = makeSpace({ memberIds: ['a'], leftAt: { b: at('2026-10-13T10:00Z') } })
    expect(plan(left, [data], WED)).toEqual({ send: [expect.objectContaining({ uid: 'a' })], skipped: [] })
    expect(plan(left, [data], THU).send.map((r) => r.uid)).toEqual(['a'])
  })

  it('never repeat a nudge already in the sent log', () => {
    const result = plan(space, [week()], WED, [key('no-progress', 'a'), key('no-progress', 'e')])
    expect(result.send.map((r) => r.uid)).toEqual(['b', 'd'])
    expect(result.skipped).toEqual([])
  })

  it('read a member whose plan was not loaded as undecided, never final', () => {
    // The job loads plans only for members still waiting with a device.
    const partial = week()
    delete partial.plans.d
    const result = plan(space, [partial], WED)
    expect(result.send.map((r) => r.uid)).toEqual(['a', 'b'])
    expect(result.skipped).toEqual([key('no-progress', 'e')])
  })

  it('follow the space clock across DST changes', () => {
    // Berlin is UTC+1 from Sun 2026-10-25: Wednesday 18:00 moves from 16:00Z to 17:00Z.
    expect(kinds(makeSpace(), '2026-10-21T16:00Z')).toEqual(['no-progress'])
    expect(kinds(makeSpace(), '2026-10-28T16:59Z')).toEqual([])
    expect(kinds(makeSpace(), '2026-10-28T17:00Z')).toEqual(['no-progress'])
    // Cairo turns its clocks back at the end of Thursday 2026-10-29 (24:00 UTC+3 becomes 23:00 UTC+2),
    // so that Thursday evening runs from 18:00 UTC+3 (15:00Z) to Friday 00:00 UTC+2 (22:00Z): 7 hours.
    const cairo = makeSpace({ id: 's3', name: 'Nile Crew', timezone: 'Africa/Cairo', memberIds: ['a'] })
    const bounds: Bounds = { startAt: at('2026-10-25T21:00Z'), lockAt: at('2026-10-26T21:00Z'), reviewOpenAt: at('2026-10-29T22:00Z'), deadlineAt: at('2026-10-30T22:00Z') }
    expect(kinds(cairo, '2026-10-29T14:59Z')).toEqual([])
    expect(dueWindows(cairo, at('2026-10-29T15:00Z'))).toEqual([
      { kind: 'open-tasks', period: '2026-10-26', weekIds: ['2026-10-26'], opensAt: at('2026-10-29T15:00Z'), closesAt: bounds.reviewOpenAt, expiresAt: bounds.reviewOpenAt },
    ])
    // 23:30, the second time round.
    expect(kinds(cairo, '2026-10-29T21:30Z')).toEqual(['open-tasks'])
    const data = makeWeek('2026-10-26', { members: ['a'], plans: { a: 1 } }, 's3', bounds)
    expect(bodies(plan(cairo, [data], at('2026-10-29T15:17Z')))).toEqual({
      a: '1 of 1 task still open | Reviews in Nile Crew start in 7 hours. Finish what you can before then.',
    })
  })

  it('work for spaces at the far ends of the clock', () => {
    // 05:17Z on Thursday is Thursday 19:17 on Kiritimati (UTC+14), Wednesday 18:17 in Pago Pago
    // (UTC−11) and Thursday 07:17 in Berlin.
    const now = '2026-10-15T05:17Z'
    const kiritimati = makeSpace({ id: 'k', name: 'Line Islands', timezone: 'Pacific/Kiritimati', memberIds: ['a'] })
    const pago = makeSpace({ id: 'p', name: 'Tutuila', timezone: 'Pacific/Pago_Pago', memberIds: ['b'] })
    expect(kinds(kiritimati, now)).toEqual(['open-tasks'])
    expect(kinds(pago, now)).toEqual(['no-progress'])
    expect(kinds(makeSpace(), now)).toEqual([])
    const kBounds: Bounds = { startAt: at('2026-10-11T10:00Z'), lockAt: at('2026-10-12T10:00Z'), reviewOpenAt: at('2026-10-15T10:00Z'), deadlineAt: at('2026-10-16T10:00Z') }
    const pBounds: Bounds = { startAt: at('2026-10-12T11:00Z'), lockAt: at('2026-10-13T11:00Z'), reviewOpenAt: at('2026-10-16T11:00Z'), deadlineAt: at('2026-10-17T11:00Z') }
    const result = planReminders({
      nowMs: at(now),
      spaces: [
        { space: kiritimati, weeks: { [W]: makeWeek(W, { members: ['a'], plans: { a: 3 }, done: { a: ['a1'] } }, 'k', kBounds) } },
        { space: pago, weeks: { [W]: makeWeek(W, { members: ['b'], plans: { b: 1 } }, 'p', pBounds) } },
      ],
      profiles: PROFILES,
      sent: new Set(),
    })
    expect(result.send.map((r) => `${r.key} | ${r.title} | ${r.body}`)).toEqual([
      'k_2026-10-12_open-tasks_a | 2 of 3 tasks still open | Reviews in Line Islands start in 5 hours. Finish what you can before then.',
      'p_2026-10-12_no-progress_b | Nothing ticked yet | Halfway through the week in Tutuila. 1 task to go before Friday.',
    ])
    // Each expires at its own space's midnight.
    expect(result.send.map((r) => r.expiresAt)).toEqual([kBounds.reviewOpenAt, at('2026-10-15T11:00Z')])
  })
})

describe('review reminders', () => {
  // Anna and Ben have tasks, Chris planned nothing, Ben already submitted, Dana joined after lock.
  const week = makeWeek(W, { members: ['a', 'b', 'c'], submittedBy: ['b'], plans: { a: 2, b: 1, c: 0 } })

  it('asks each participant who has not submitted to rate the friends with tasks', () => {
    const result = plan(makeSpace(), [week], at('2026-10-16T08:17Z'))
    expect(bodies(result)).toEqual({
      a: 'Review day | Rate Ben in Film Club. Due in 14 hours.',
      c: 'Review day | Rate Anna and Ben in Film Club. Due in 14 hours.',
    })
    expect(result.send[0]).toMatchObject({ key: key('review', 'a'), tag: 'review-s1', expiresAt: BOUNDS[W].deadlineAt })
    // Ben submitted, Dana isn't in this week: both are final.
    expect(result.skipped).toEqual([key('review', 'b'), key('review', 'd')])
  })

  it('skips a participant with nobody to review', () => {
    const solo = makeWeek(W, { members: ['a', 'b'], plans: { a: 3, b: 0 } })
    const result = plan(makeSpace({ memberIds: ['a', 'b'] }), [solo], at('2026-10-16T08:17Z'))
    expect(bodies(result)).toEqual({ b: 'Review day | Rate Anna in Film Club. Due in 14 hours.' })
    expect(result.skipped).toEqual([key('review', 'a')])
  })

  it('never sends "due in" after the stored deadline, or before the stored window opens', () => {
    const skewed = makeWeek(W, { members: ['a', 'b', 'c'], plans: { a: 1, b: 1, c: 1 } })
    // Someone created the week with the deadline 23h early: it already closed at Friday 01:00.
    skewed.week!.deadlineAt = at('2026-10-15T23:00Z')
    const result = plan(makeSpace(), [skewed], at('2026-10-16T08:17Z'))
    expect(result.send).toEqual([])
    expect(result.skipped).toEqual(['a', 'b', 'c', 'd'].map((u) => key('review', u)))
    const late = makeWeek(W, { members: ['a', 'b'], plans: { a: 1, b: 1 } })
    late.week!.reviewOpenAt = at('2026-10-16T12:00Z')
    expect(plan(makeSpace(), [late], at('2026-10-16T08:17Z')).send).toEqual([])
  })

  it('still asks everyone to review a participant who left after the week locked', () => {
    // Chris left on Wednesday: the lock is a commitment, so his week still counts.
    const data = makeWeek(W, { members: ['a', 'b', 'c'], plans: { a: 1, b: 1, c: 1 } })
    const space = makeSpace({ memberIds: ['a', 'b'], leftAt: { c: at('2026-10-14T10:00Z') } })
    const result = plan(space, [data], at('2026-10-16T08:17Z'))
    expect(bodies(result)).toEqual({
      a: 'Review day | Rate Ben and Chris in Film Club. Due in 14 hours.',
      b: 'Review day | Rate Anna and Chris in Film Club. Due in 14 hours.',
    })
    // Chris can't submit any more, so he isn't asked; the last call counts him in the points at stake.
    expect(bodies(plan(space, [data], at('2026-10-16T18:17Z'))).a).toBe('4 hours left | Miss the Film Club deadline and you lose 10 points.')
    // A deleted account has no profile left: named as a former member.
    const gone = planSpace({ space, weeks: { [W]: data } }, { a: { name: 'Anna' }, b: { name: 'Ben' } }, new Set(), at('2026-10-16T08:17Z'))
    expect(gone.send.find((r) => r.uid === 'a')?.body).toBe('Rate Ben and a former member in Film Club. Due in 14 hours.')
  })

  it('does not ask anyone to review a participant who left before the week locked', () => {
    // Normally leaving before lock takes them out of the week; here they are still listed.
    const data = makeWeek(W, { members: ['a', 'b', 'c'], plans: { a: 1, b: 1, c: 1 } })
    const space = makeSpace({ memberIds: ['a', 'b'], leftAt: { c: at('2026-10-12T10:00Z') } })
    const result = plan(space, [data], at('2026-10-16T08:17Z'))
    expect(bodies(result)).toEqual({ a: 'Review day | Rate Ben in Film Club. Due in 14 hours.', b: 'Review day | Rate Anna in Film Club. Due in 14 hours.' })
  })

  it('skips everyone when the week was never opened', () => {
    const result = plan(makeSpace(), [makeWeek(W, null)], at('2026-10-16T08:17Z'))
    expect(result.send).toEqual([])
    expect(result.skipped).toHaveLength(4)
  })

  it('sends the last call with the hours left and the points at stake', () => {
    const result = plan(makeSpace(), [week], at('2026-10-16T18:17Z')) // 20:17
    expect(bodies(result)).toEqual({
      a: '4 hours left | Miss the Film Club deadline and you lose 5 points.',
      c: '4 hours left | Miss the Film Club deadline and you lose 10 points.',
    })
    expect(result.send[0]).toMatchObject({ key: key('last-call', 'a'), kind: 'last-call', tag: 'review-s1' })
    expect(plan(makeSpace(), [week], at('2026-10-16T20:40Z')).send[0].title).toBe('1 hour left')
    expect(plan(makeSpace(), [week], at('2026-10-16T21:31Z')).send[0].title).toBe('Less than an hour left')
  })

  it('names many friends compactly', () => {
    const big = makeSpace({ memberIds: ['a', 'b', 'c', 'd', 'e'] })
    const data = makeWeek(W, { members: ['a', 'b', 'c', 'd', 'e'], plans: { a: 1, b: 1, c: 1, d: 1, e: 1 } })
    const result = plan(big, [data], at('2026-10-16T08:17Z'))
    expect(result.send[0].body).toBe('Rate Ben, Chris, and 2 others in Film Club. Due in 14 hours.')
  })
})

describe('results reminder', () => {
  it('tells each participant their score on Saturday', () => {
    const week = makeWeek(W, {
      members: ['a', 'b', 'c'],
      submittedBy: ['b'],
      plans: { a: 2, b: 1, c: 0 },
      done: { a: ['a1', 'a2'], b: ['b1'] },
      // Ben rated Anna's week; nobody rated Ben, so his own check-off counts.
      reviews: [['b', 'a', { a1: 1, a2: 0.5 }]],
    })
    const result = plan(makeSpace(), [week], at('2026-10-17T07:17Z'))
    expect(bodies(result)).toEqual({
      a: 'Results are in | You scored 75%. See how Film Club did this week.',
      b: 'Results are in | You scored 100%. See how Film Club did this week.',
      c: 'Results are in | You scored 0%. See how Film Club did this week.',
    })
    expect(result.send[0]).toMatchObject({ key: key('results', 'a'), tag: 'results-s1', expiresAt: at('2026-10-18T22:00Z') })
    expect(result.skipped).toEqual([key('results', 'd')])
  })
})

describe('verdict reminder', () => {
  const nov1 = at('2026-11-01T09:17Z') // Sunday 10:17 in Berlin
  // Oct 5: both score 100%. Oct 12: Anna rates Ben 0; Ben never rates Anna (−5 for Ben), so Anna's
  // own check-off counts. Anna: 100%. Ben: (100 + 0) / 2 − 5 = 45%.
  const weeks = OCTOBER_WEEKS.map((id) => {
    if (id === '2026-10-05') return makeWeek(id, { members: ['a', 'b'], plans: { a: 1, b: 1 }, reviews: [['a', 'b', { b1: 1 }], ['b', 'a', { a1: 1 }]] })
    if (id === '2026-10-12') return makeWeek(id, { members: ['a', 'b'], plans: { a: 1, b: 1 }, done: { a: ['a1'] }, reviews: [['a', 'b', { b1: 0 }]] })
    return makeWeek(id, null)
  })
  const space = makeSpace({ memberIds: ['a', 'b', 'c'] })

  it('announces who made it and who pays, with the stakes', () => {
    const result = plan(space, weeks, nov1)
    const verdicts = result.send.filter((r) => r.kind === 'verdict')
    expect(Object.fromEntries(verdicts.map((r) => [r.uid, `${r.title} | ${r.body}`]))).toEqual({
      a: 'You made it: 100% | October in Film Club is done. Collect: Dinner on me',
      b: 'You fell short: 45% | October in Film Club is done. Pay up: Coffee for a week',
    })
    expect(verdicts[0]).toMatchObject({ key: reminderKey('s1', '2026-10', 'verdict', 'a'), tag: 'verdict-s1' })
    // Chris never took part in October.
    expect(result.skipped).toContain(reminderKey('s1', '2026-10', 'verdict', 'c'))
  })

  it('uses the stakes frozen for that month, not the space\'s current text', () => {
    const result = planSpace(
      { space: makeSpace({ memberIds: ['a', 'b', 'c'], penalty: 'A high five' }), weeks: Object.fromEntries(weeks.map((w) => [w.weekId, w])), stakes: { '2026-10': { reward: 'Dinner on me', penalty: 'Coffee for a week' } } },
      PROFILES,
      new Set(),
      nov1,
    )
    expect(result.send.find((r) => r.uid === 'b')?.body).toBe('October in Film Club is done. Pay up: Coffee for a week')
  })

  it('tells nobody what they owe when nobody else played the month', () => {
    const solo = OCTOBER_WEEKS.map((id) => (id === '2026-10-05' ? makeWeek(id, { members: ['a'], plans: { a: 1 }, done: { a: ['a1'] } }) : makeWeek(id, null)))
    const result = plan(makeSpace({ memberIds: ['a'] }), solo, nov1)
    expect(result.send.filter((r) => r.kind === 'verdict')).toEqual([])
    expect(result.skipped).toContain(reminderKey('s1', '2026-10', 'verdict', 'a'))
  })

  it('waits until every week of the month is loaded', () => {
    const result = plan(space, weeks.slice(1), nov1)
    expect(result.send.filter((r) => r.kind === 'verdict')).toEqual([])
    expect(result.skipped.some((k) => k.includes('verdict'))).toBe(false)
  })
})

describe('dedupe and inputs', () => {
  const week = makeWeek(W, { members: ['a', 'b', 'c'], plans: { a: 1, b: 1, c: 1 } })

  it('builds keys from space, period, kind and uid', () => {
    expect(reminderKey('s1', '2026-10-12', 'last-call', 'u1')).toBe('s1_2026-10-12_last-call_u1')
  })

  it('never repeats a key that is already in the sent log', () => {
    const result = plan(makeSpace(), [week], at('2026-10-16T08:17Z'), [key('review', 'a'), key('review', 'd')])
    expect(result.send.map((r) => r.uid)).toEqual(['b', 'c'])
    expect(result.skipped).toEqual([])
  })

  it('ignores windows whose week data was not loaded', () => {
    expect(planSpace({ space: makeSpace(), weeks: {} }, PROFILES, new Set(), at('2026-10-16T08:17Z'))).toEqual({ send: [], skipped: [] })
  })

  it('plans several spaces, each on its own clock', () => {
    const la = makeSpace({ id: 's2', name: 'Night Shoots', timezone: 'America/Los_Angeles', memberIds: ['a', 'b'] })
    const laWeek = makeWeek(W, { members: ['a', 'b'], plans: { a: 1, b: 1 } }, 's2')
    // LA bounds differ from Berlin's, but the planner only reads members, plans and the deadline here.
    laWeek.week!.deadlineAt = at('2026-10-17T07:00Z')
    const result = planReminders({
      nowMs: at('2026-10-16T18:30Z'),
      spaces: [
        { space: makeSpace(), weeks: { [W]: week } },
        { space: la, weeks: { [W]: laWeek } },
      ],
      profiles: PROFILES,
      sent: new Set(),
    })
    expect(result.send.map((r) => `${r.spaceId}:${r.kind}:${r.uid}`)).toEqual([
      's1:last-call:a',
      's1:last-call:b',
      's1:last-call:c',
      's2:review:a',
      's2:review:b',
    ])
    expect(result.send[3].body).toBe('Rate Ben in Night Shoots. Due in 13 hours.')
  })

  it('falls back to a generic name when a profile is missing', () => {
    const result = planSpace({ space: makeSpace(), weeks: { [W]: week } }, { a: { name: 'Anna' } }, new Set(), at('2026-10-16T08:17Z'))
    expect(result.send[0].body).toBe('Rate a friend and a friend in Film Club. Due in 14 hours.')
  })
})

describe('copy helpers', () => {
  it('lists names the way iOS does', () => {
    expect(listNames(['Anna'])).toBe('Anna')
    expect(listNames(['Anna', 'Ben'])).toBe('Anna and Ben')
    expect(listNames(['Anna', 'Ben', 'Chris'])).toBe('Anna, Ben, and Chris')
    expect(listNames(['Anna', 'Ben', 'Chris', 'Dana', 'Eve'])).toBe('Anna, Ben, and 3 others')
  })

  it('words time left relative to now, right in every timezone', () => {
    expect(hoursFromNow(15 * 3_600_000)).toBe('15 hours')
    expect(hoursFromNow(5.6 * 3_600_000)).toBe('6 hours')
    expect(hoursFromNow(1.2 * 3_600_000)).toBe('1 hour')
    expect(hoursFromNow(20 * 60_000)).toBe('under an hour')
  })

  it('rounds percentages down so a miss never reads as 90%', () => {
    expect(formatPercent(89.6)).toBe('89%')
    expect(formatPercent(90 - 1e-12)).toBe('90%')
    expect(formatPercent(100)).toBe('100%')
    expect(formatPercent(0)).toBe('0%')
  })
})

describe('offsetToStore', () => {
  const october = at('2026-10-11T12:00Z') // Berlin is UTC+2
  it('backfills a missing offset and repairs one that does not fit the zone', () => {
    expect(offsetToStore({ timezone: 'Europe/Berlin' }, october)).toBe(120)
    expect(offsetToStore({ timezone: 'Europe/Berlin', utcOffsetMin: -600 }, october)).toBe(120)
    expect(offsetToStore({ timezone: 'Europe/Berlin', utcOffsetMin: 0 }, october)).toBe(120)
  })

  it('keeps an offset from either DST season', () => {
    expect(offsetToStore({ timezone: 'Europe/Berlin', utcOffsetMin: 120 }, october)).toBeNull()
    expect(offsetToStore({ timezone: 'Europe/Berlin', utcOffsetMin: 60 }, october)).toBeNull()
    expect(offsetToStore({ timezone: 'Europe/Berlin', utcOffsetMin: 120 }, at('2026-12-01T12:00Z'))).toBeNull()
  })
})
