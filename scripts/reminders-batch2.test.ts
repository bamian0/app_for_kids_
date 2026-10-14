// The batch-2 reminders (SPEC §9.11): windows on each week's own times with quiet hours, the send-time mute,
// judges, monthly parts with their own keys, paused weeks, the new kinds and the verdict per pair.
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SCHEDULE, monthlyBounds, weekBounds } from '../src/domain/time.ts'
import type {
  Agreement,
  Mark,
  MemberStakes,
  MonthId,
  MonthlyData,
  MonthResults,
  PairTerms,
  Space,
  TermsInForce,
  UID,
  WeekData,
  WeekId,
  WeekSchedule,
} from '../src/domain/types.ts'
import {
  dueWindows,
  earlierAwake,
  isMuted,
  laterAwake,
  laterAwakeAt,
  planSpace,
  planWindows,
  reminderKey,
  resultsTarget,
  stakesCandidates,
  windowKeys,
  windowsAround,
  type PlanResult,
  type SpaceInput,
} from './reminders-plan.ts'

const TZ = 'Europe/Berlin'
/** Wall-clock time in Berlin ('2026-10-30T09:17') → ms. Berlin is UTC+2 until Sun 2026-10-25, UTC+1 after. */
const local = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toMillis()
const PROFILES = { a: { name: 'Anna' }, b: { name: 'Ben' }, c: { name: 'Chris' }, d: { name: 'Dana' }, e: { name: 'Eve' } }
const OCTOBER_WEEKS = ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']

function makeSpace(overrides: Partial<Space> = {}): Space {
  return {
    id: 's1',
    name: 'Film Club',
    reward: 'Dinner on me',
    penalty: 'Coffee for a week',
    ownerId: 'a',
    memberIds: ['a', 'b', 'c', 'd'],
    joinedAt: {},
    timezone: TZ,
    utcOffsetMin: 120,
    inviteCode: 'ABCD2345',
    threshold: 90,
    latePenalty: 5,
    createdAt: local('2026-09-01T12:00'),
    ...overrides,
  }
}

interface PeriodSpec {
  members?: UID[]
  submittedBy?: UID[]
  /** Task count per member; task ids are `${uid}1`, `${uid}2`, … (`${uid}m1` … on a monthly list). */
  plans?: Record<UID, number>
  done?: Record<UID, string[]>
  reviews?: [reviewer: UID, reviewee: UID, marks: Record<string, Mark>][]
  judges?: UID[]
  /** Stored on the week doc (its bounds follow it). */
  schedule?: WeekSchedule
}

function fill<T extends WeekData | MonthlyData>(data: T, spec: PeriodSpec, prefix: string, reviewAt: number): T {
  for (const [uid, n] of Object.entries(spec.plans ?? {})) {
    data.plans[uid] = { uid, updatedAt: 0, tasks: Array.from({ length: n }, (_, i) => ({ id: `${uid}${prefix}${i + 1}`, title: `Task ${i + 1}` })) }
  }
  for (const [uid, ids] of Object.entries(spec.done ?? {})) data.progress[uid] = { uid, updatedAt: 0, done: Object.fromEntries(ids.map((id) => [id, true])) }
  data.reviews = (spec.reviews ?? []).map(([reviewerId, revieweeId, marks]) => ({ id: `${reviewerId}_${revieweeId}`, reviewerId, revieweeId, marks, submittedAt: reviewAt }))
  return data
}

function week(weekId: WeekId, spec: PeriodSpec | null, bounds?: Partial<ReturnType<typeof weekBounds>>): WeekData {
  const data: WeekData = { spaceId: 's1', weekId, week: null, plans: {}, progress: {}, reviews: [] }
  if (!spec) return data
  const b = { ...weekBounds(weekId, TZ, spec.schedule ?? DEFAULT_SCHEDULE), ...bounds }
  data.week = { id: weekId, spaceId: 's1', ...b, members: spec.members ?? [], submittedBy: spec.submittedBy ?? [] }
  if (spec.schedule) data.week.schedule = spec.schedule
  if (spec.judges) data.week.judges = spec.judges
  return fill(data, spec, '', b.reviewOpenAt)
}

function list(monthId: MonthId, spec: PeriodSpec | null, bounds?: Partial<ReturnType<typeof weekBounds>>): MonthlyData {
  const data: MonthlyData = { spaceId: 's1', monthId, monthly: null, plans: {}, progress: {}, reviews: [] }
  if (!spec) return data
  const b = { ...monthlyBounds(monthId, (w) => weekBounds(w, TZ)), ...bounds }
  data.monthly = { id: monthId, spaceId: 's1', ...b, members: spec.members ?? [], submittedBy: spec.submittedBy ?? [], judges: spec.judges ?? [] }
  return fill(data, spec, 'm', b.reviewOpenAt)
}

function run(space: Space, nowMs: number, data: Partial<Omit<SpaceInput, 'space' | 'weeks' | 'monthly'>> & { weeks?: WeekData[]; lists?: MonthlyData[] } = {}, sent: string[] = []): PlanResult {
  const { weeks = [], lists = [], ...rest } = data
  const input: SpaceInput = {
    space,
    weeks: Object.fromEntries(weeks.map((w) => [w.weekId, w])),
    monthly: Object.fromEntries(lists.map((l) => [l.monthId, l])),
    ...rest,
  }
  return planSpace(input, PROFILES, new Set(sent), nowMs)
}

const lines = (result: PlanResult) => result.send.map((r) => `${r.uid} | ${r.title} | ${r.body}`)
const kinds = (space: Space, nowMs: number) => dueWindows(space, nowMs).map((w) => `${w.kind}:${w.period}`)
const only = (space: Space, nowMs: number, kind: string) => kinds(space, nowMs).filter((k) => k.startsWith(`${kind}:`))

describe('quiet hours', () => {
  it('moves a warning that would land at night back to 20:00 the evening before', () => {
    expect(earlierAwake(1080)).toBe(1080) // Monday 18:00 stays
    expect(earlierAwake(480)).toBe(480) // 08:00 is awake
    expect(earlierAwake(479)).toBe(-240) // 07:59 → Sunday 20:00
    expect(earlierAwake(180)).toBe(-240) // Monday 03:00 → Sunday 20:00
    expect(earlierAwake(1319)).toBe(1319) // 21:59
    expect(earlierAwake(1320)).toBe(1200) // 22:00 → 20:00 the same evening
    expect(earlierAwake(1350)).toBe(1200)
    expect(earlierAwake(5760 - 360)).toBe(5400) // the usual open-tasks, Thursday 18:00
  })

  it('makes news that would land at night wait for the morning', () => {
    expect(laterAwake(5760)).toBe(5760 + 540) // Friday 00:00 → 09:00
    expect(laterAwake(5760 + 600)).toBe(5760 + 600) // 10:00 stays
    expect(laterAwake(5760 + 1259)).toBe(5760 + 1259) // 20:59 stays
    expect(laterAwake(5760 + 1260)).toBe(7200 + 540) // 21:00 → Saturday 09:00
    expect(laterAwake(7200)).toBe(7740) // the usual results, Saturday 09:00
    expect(laterAwake(1440, 10)).toBe(1440 + 600)
    // For an instant, in the space's clock.
    expect(laterAwakeAt(local('2026-10-14T21:30'), TZ)).toBe(local('2026-10-15T09:00'))
    expect(laterAwakeAt(local('2026-10-15T03:00'), TZ)).toBe(local('2026-10-15T09:00'))
    expect(laterAwakeAt(local('2026-10-15T12:34'), TZ)).toBe(local('2026-10-15T12:34'))
    expect(laterAwakeAt(local('2026-11-01T00:00'), TZ, 10)).toBe(local('2026-11-01T10:00'))
  })

  it('mutes every push between 00:00 and 08:00 local; the window stays open and finals are still logged', () => {
    expect(isMuted(makeSpace(), local('2026-10-18T07:59'))).toBe(true)
    expect(isMuted(makeSpace(), local('2026-10-18T08:00'))).toBe(false)
    expect(isMuted(makeSpace(), local('2026-10-17T23:59'))).toBe(false)
    // Sunday 03:17: the results window (Saturday 09:00 → Monday 00:00) is open, but nobody is woken.
    const data = week('2026-10-12', { members: ['a', 'b'], submittedBy: ['a', 'b'], plans: { a: 1, b: 1 }, reviews: [['a', 'b', { b1: 1 }], ['b', 'a', { a1: 1 }]] })
    const night = run(makeSpace(), local('2026-10-18T03:17'), { weeks: [data] })
    expect(kinds(makeSpace(), local('2026-10-18T03:17'))).toEqual(['results:2026-10-12'])
    expect(night.send).toEqual([])
    expect(night.skipped).toEqual(['c', 'd'].map((u) => reminderKey('s1', '2026-10-12', 'results', u)))
    // At 08:00 the same window sends.
    expect(lines(run(makeSpace(), local('2026-10-18T08:17'), { weeks: [data] }))).toEqual([
      'a | Results are in | You scored 100%. See how Film Club did this week.',
      'b | Results are in | You scored 100%. See how Film Club did this week.',
    ])
  })
})

describe('windows on custom times (design-time §3.2)', () => {
  it('lock Monday 09:00: next week’s plan push opens Sunday 20:00 (03:00 is quiet) and counts 13 hours', () => {
    const schedule = { lock: 540, reviewOpen: 5760, deadline: 7200 }
    const space = makeSpace({ schedule })
    const W = '2026-10-12'
    expect(only(space, local('2026-10-11T19:59'), 'plan')).toEqual([])
    expect(dueWindows(space, local('2026-10-11T20:00')).filter((w) => w.kind === 'plan')).toEqual([
      { kind: 'plan', period: W, weekIds: [W], opensAt: local('2026-10-11T20:00'), closesAt: local('2026-10-12T09:00'), expiresAt: local('2026-10-12T09:00') },
    ])
    const result = run(space, local('2026-10-11T20:17'), { weeks: [week(W, { members: ['a', 'b', 'c', 'd'], plans: { b: 1 }, schedule })] })
    expect(lines(result)[0]).toBe('a | Lock in your week | Your list for Film Club locks in 13 hours. Nothing planned = 0%.')
    expect(result.send[0]).toMatchObject({ key: reminderKey('s1', W, 'plan', 'a'), tag: 'plan-s1', url: './' })
  })

  it('reviews open Saturday 09:00: the open-tasks nudge opens Friday 20:00', () => {
    const space = makeSpace({ schedule: { lock: 1440, reviewOpen: 7740, deadline: 10080 } })
    expect(dueWindows(space, local('2026-10-16T20:00'))).toMatchObject([{ kind: 'open-tasks', opensAt: local('2026-10-16T20:00'), closesAt: local('2026-10-17T09:00') }])
    expect(kinds(space, local('2026-10-16T19:59'))).toEqual([])
  })

  it('reviews due Saturday 02:00: the last call opens Friday 20:00, never before reviews open', () => {
    const space = makeSpace({ schedule: { lock: 1440, reviewOpen: 5760, deadline: 7320 } })
    expect(dueWindows(space, local('2026-10-16T20:00'))).toMatchObject([{ kind: 'last-call', opensAt: local('2026-10-16T20:00'), closesAt: local('2026-10-17T02:00') }])
    // Reviews opening Friday 21:00: the last call waits for them, and there's no morning review push.
    const late = makeSpace({ schedule: { lock: 1440, reviewOpen: 7020, deadline: 7320 } })
    expect(only(late, local('2026-10-16T20:59'), 'last-call')).toEqual([])
    expect(dueWindows(late, local('2026-10-16T21:00'))).toMatchObject([{ kind: 'last-call', opensAt: local('2026-10-16T21:00') }])
    expect(windowsAround(late, local('2026-10-16T21:00')).filter((w) => w.period === '2026-10-12').map((w) => w.kind)).not.toContain('review')
  })

  it('reviews 18:00–21:00 Friday: no separate review push, the last call says 3 hours', () => {
    const schedule = { lock: 1440, reviewOpen: 6840, deadline: 7020 }
    const space = makeSpace({ schedule })
    const W = '2026-10-12'
    expect(windowsAround(space, local('2026-10-16T18:00')).filter((w) => w.period === W).map((w) => w.kind)).toEqual(['plan', 'no-progress', 'open-tasks', 'last-call', 'results'])
    expect(kinds(space, local('2026-10-16T17:59'))).toEqual(['open-tasks:2026-10-12'])
    expect(kinds(space, local('2026-10-16T18:00'))).toEqual(['last-call:2026-10-12'])
    const data = week(W, { members: ['a', 'b'], plans: { a: 1, b: 1 }, schedule })
    expect(lines(run(makeSpace({ schedule, memberIds: ['a', 'b'] }), local('2026-10-16T18:17'), { weeks: [data] }))).toEqual([
      'a | 3 hours left | Miss the Film Club deadline and you lose 5 points.',
      'b | 3 hours left | Miss the Film Club deadline and you lose 5 points.',
    ])
  })

  it('reviews due Sunday at midnight: results go out Monday 09:00 until Wednesday, under the old week', () => {
    const schedule = { lock: 1440, reviewOpen: 5760, deadline: 10080 }
    const space = makeSpace({ schedule })
    expect(kinds(space, local('2026-10-19T08:59'))).toEqual([])
    expect(dueWindows(space, local('2026-10-19T09:00'))).toMatchObject([
      { kind: 'results', period: '2026-10-12', weekIds: ['2026-10-12'], opensAt: local('2026-10-19T09:00'), closesAt: local('2026-10-21T00:00') },
    ])
    expect(kinds(space, local('2026-10-20T23:59'))).toEqual(['results:2026-10-12'])
    expect(kinds(space, local('2026-10-21T00:00'))).toEqual([])
  })

  it('lists locking at Sunday midnight (m = 0): next week’s plan push opens Sunday 18:00', () => {
    const space = makeSpace({ schedule: { lock: 0, reviewOpen: 5760, deadline: 7200 } })
    expect(only(space, local('2026-10-18T17:59'), 'plan')).toEqual([])
    expect(dueWindows(space, local('2026-10-18T18:00')).find((w) => w.kind === 'plan')).toMatchObject({ period: '2026-10-19', closesAt: local('2026-10-19T00:00') })
  })

  it('no no-progress nudge when the active part is short (lists lock Thursday noon)', () => {
    const space = makeSpace({ schedule: { lock: 3 * 1440 + 720, reviewOpen: 5760, deadline: 7200 } })
    const own = windowsAround(space, local('2026-10-14T12:00')).filter((w) => w.period === '2026-10-12')
    expect(own.map((w) => w.kind)).toEqual(['plan', 'open-tasks', 'review', 'last-call', 'results'])
    // The usual times have it: Wednesday 18:00 until midnight.
    expect(windowsAround(makeSpace(), local('2026-10-14T12:00')).find((w) => w.kind === 'no-progress' && w.period === '2026-10-12')).toMatchObject({
      opensAt: local('2026-10-14T18:00'),
      closesAt: local('2026-10-15T00:00'),
    })
  })

  it('closes every window at the week’s stored bounds, on the week’s own schedule', () => {
    // The week was created on the usual times and the space changed since: the week keeps its times.
    const space = makeSpace({ schedule: { lock: 1200, reviewOpen: 5760, deadline: 7920 } })
    const stored = week('2026-10-12', { members: ['a'] }).week!
    const around = windowsAround(space, local('2026-10-12T12:00'), { weeks: { '2026-10-12': stored } }).filter((w) => w.period === '2026-10-12')
    expect(around.find((w) => w.kind === 'plan')).toMatchObject({ opensAt: local('2026-10-12T18:00'), closesAt: stored.lockAt })
    expect(around.find((w) => w.kind === 'last-call')).toMatchObject({ closesAt: stored.deadlineAt })
    // Without the doc, the space's times: lists lock Monday 20:00, so the plan push opens at 14:00.
    expect(windowsAround(space, local('2026-10-12T12:00')).find((w) => w.kind === 'plan' && w.period === '2026-10-12')).toMatchObject({
      opensAt: local('2026-10-12T14:00'),
      closesAt: local('2026-10-12T20:00'),
    })
  })
})

describe('paused weeks', () => {
  it('have no weekly windows', () => {
    const space = makeSpace({ paused: { '2026-10': '2026-10-12' } })
    expect(windowsAround(space, local('2026-10-14T12:00')).filter((w) => w.weekIds.includes('2026-10-12') || w.period === '2026-10-12')).toEqual([])
    expect(kinds(space, local('2026-10-12T19:00'))).toEqual([])
    expect(kinds(space, local('2026-10-16T10:00'))).toEqual([])
  })

  it('in a month’s last week, still carry the month’s list: review, last-call and results with its key only', () => {
    const space = makeSpace({ paused: { '2026-10': '2026-10-26' } })
    const own = windowsAround(space, local('2026-10-28T12:00')).filter((w) => w.monthIds?.includes('2026-10') && w.kind !== 'verdict')
    expect(own.map((w) => `${w.kind}:${w.period}:${w.weekIds.length}`)).toEqual(['review:null:0', 'last-call:null:0', 'results:null:0'])
    expect(windowKeys('s1', own[0], 'a')).toEqual(['s1_2026-10_review_a'])
  })
})

describe('results target', () => {
  it('is this week’s month once its last week is complete, else the last complete candidate', () => {
    // Friday Oct 30: October's last week, reviews still due.
    expect(resultsTarget(makeSpace(), local('2026-10-30T12:00'))).toBe('2026-09')
    // Saturday Oct 31: October is complete, so its results needn't wait for Monday.
    expect(resultsTarget(makeSpace(), local('2026-10-31T00:00'))).toBe('2026-10')
    expect(resultsTarget(makeSpace(), local('2026-11-01T10:00'))).toBe('2026-10')
    // A stored deadline later than the computed one decides.
    const late = week('2026-10-26', { members: ['a'] }, { deadlineAt: local('2026-11-01T12:00') }).week!
    expect(resultsTarget(makeSpace(), local('2026-11-01T10:00'), { weeks: { '2026-10-26': late } })).toBe('2026-09')
    expect(resultsTarget(makeSpace(), local('2026-11-02T10:00'))).toBe('2026-10')
    expect(resultsTarget(makeSpace(), local('2026-11-12T10:00'))).toBe('2026-10')
  })
})

describe('judges', () => {
  const W = '2026-10-12'
  const space = makeSpace({ judges: ['c'] })

  it('get no plan push (they can still switch back before the lock)', () => {
    const data = week(W, { members: ['a', 'b', 'c', 'd'], judges: ['c'], plans: { a: 1 } })
    const result = run(space, local('2026-10-12T19:17'), { weeks: [data] })
    expect(result.send.map((r) => r.uid)).toEqual(['b', 'd'])
    expect(result.skipped).toEqual([])
    // Without a week doc, the space's judges.
    expect(run(space, local('2026-10-12T19:17'), { weeks: [week(W, null)] }).send.map((r) => r.uid)).toEqual(['a', 'b', 'd'])
  })

  it('never get the midweek nudges', () => {
    const data = week(W, { members: ['a', 'b', 'c'], judges: ['c'], plans: { a: 1, c: 2 } })
    const result = run(space, local('2026-10-14T18:17'), { weeks: [data] })
    expect(result.send.map((r) => r.uid)).toEqual(['a'])
    expect(result.skipped).toEqual(['c', 'd'].map((u) => reminderKey('s1', W, 'no-progress', u)))
  })

  it('review everyone with tasks and are never reviewed; their last call names who waits, with no points', () => {
    // Chris judges and kept a plan from before: nobody is asked to rate him.
    const data = week(W, { members: ['a', 'b', 'c'], judges: ['c'], plans: { a: 1, b: 1, c: 1 } })
    expect(lines(run(space, local('2026-10-16T09:17'), { weeks: [data] }))).toEqual([
      'a | Review day | Rate Ben in Film Club. Due in 15 hours.',
      'b | Review day | Rate Anna in Film Club. Due in 15 hours.',
      'c | Review day | Rate Anna and Ben in Film Club. Due in 15 hours.',
    ])
    expect(lines(run(space, local('2026-10-16T20:17'), { weeks: [data] }))).toEqual([
      'a | 4 hours left | Miss the Film Club deadline and you lose 5 points.',
      'b | 4 hours left | Miss the Film Club deadline and you lose 5 points.',
      'c | 4 hours left | Anna and Ben are waiting for your marks in Film Club.',
    ])
  })

  it('hear that results are in once revealed', () => {
    const data = week(W, { members: ['a', 'b', 'c'], judges: ['c'], plans: { a: 1, b: 1 }, submittedBy: ['a', 'b'], reviews: [['a', 'b', { b1: 1 }], ['b', 'a', { a1: 0.5 }]] })
    // Before the deadline the reveal waits for Chris.
    const early = { ...data, week: { ...data.week!, deadlineAt: local('2026-10-17T12:00') } }
    // (He still gets his last call until then.)
    expect(lines(run(space, local('2026-10-17T09:17'), { weeks: [early] }))).toEqual(['c | 3 hours left | Anna and Ben are waiting for your marks in Film Club.'])
    expect(lines(run(space, local('2026-10-17T09:17'), { weeks: [data] }))).toEqual([
      'a | Results are in | You scored 50%. See how Film Club did this week.',
      'b | Results are in | You scored 100%. See how Film Club did this week.',
      'c | Results are in | See how Film Club did this week.',
    ])
  })
})

describe('monthly parts in a month’s last week', () => {
  // October's last week; its list is reviewed in the same window (Fri Oct 30 00:00 → Sat Oct 31 00:00, UTC+1).
  const W = '2026-10-26'
  const space = makeSpace({ memberIds: ['a', 'b', 'c'] })
  const thisWeek = (spec: Partial<PeriodSpec> = {}) => week(W, { members: ['a', 'b', 'c'], plans: { a: 1, b: 1, c: 1 }, ...spec })
  const october = (spec: Partial<PeriodSpec> = {}, bounds?: Partial<ReturnType<typeof weekBounds>>) =>
    list('2026-10', { members: ['a', 'b', 'c'], plans: { a: 1, b: 2 }, ...spec }, bounds)
  const keys = (kind: 'review' | 'last-call' | 'results', uid: UID) => [reminderKey('s1', W, kind, uid), reminderKey('s1', '2026-10', kind, uid)]

  it('carry the list with its own key: one push names everyone owed, and logs both parts', () => {
    const result = run(space, local('2026-10-30T09:17'), { weeks: [thisWeek()], lists: [october()] })
    expect(lines(result)).toEqual([
      'a | Review day | Rate Ben and Chris in Film Club, October lists too. Due in 15 hours.',
      'b | Review day | Rate Anna and Chris in Film Club, October lists too. Due in 15 hours.',
      // Chris has no October list but still reviews the others'.
      'c | Review day | Rate Anna and Ben in Film Club, October lists too. Due in 15 hours.',
    ])
    expect(result.send[0]).toMatchObject({ key: keys('review', 'a')[0], parts: keys('review', 'a'), tag: 'review-s1', url: './' })
    // The last call counts both parts: Anna owes 2 weekly reviews and 1 monthly one.
    expect(lines(run(space, local('2026-10-30T20:17'), { weeks: [thisWeek()], lists: [october()] }))).toEqual([
      'a | 4 hours left | Miss the Film Club deadline and you lose 15 points.',
      'b | 4 hours left | Miss the Film Club deadline and you lose 15 points.',
      'c | 4 hours left | Miss the Film Club deadline and you lose 20 points.',
    ])
  })

  it('send the week alone while the list’s window isn’t healed, then the list alone under its own key', () => {
    const unhealed = october({}, { reviewOpenAt: local('2026-10-30T01:00') })
    const first = run(space, local('2026-10-30T09:17'), { weeks: [thisWeek()], lists: [unhealed] })
    expect(lines(first)[0]).toBe('a | Review day | Rate Ben and Chris in Film Club. Due in 15 hours.')
    expect(first.send[0]).toMatchObject({ key: keys('review', 'a')[0] })
    expect(first.send[0].parts).toBeUndefined()
    // Healed by the next run; the weekly part is logged.
    const second = run(space, local('2026-10-30T10:17'), { weeks: [thisWeek()], lists: [october()] }, ['a', 'b', 'c'].map((u) => keys('review', u)[0]))
    expect(lines(second)[0]).toBe('a | Review day | Rate the October lists of Ben in Film Club. Due in 14 hours.')
    expect(second.send[0]).toMatchObject({ key: keys('review', 'a')[1] })
  })

  it('a submitted week with an unsubmitted list still gets the monthly push', () => {
    const result = run(space, local('2026-10-30T09:17'), { weeks: [thisWeek({ submittedBy: ['a'] })], lists: [october()] })
    expect(lines(result)[0]).toBe('a | Review day | Rate the October lists of Ben in Film Club. Due in 15 hours.')
    expect(result.send[0].key).toBe(keys('review', 'a')[1])
    expect(result.skipped).toContain(keys('review', 'a')[0])
  })

  it('a paused last week: only the list, with no points at stake (no last call unless you judge it)', () => {
    const paused = makeSpace({ memberIds: ['a', 'b', 'c'], paused: { '2026-10': W } })
    const lists = [october({ judges: ['c'], plans: { a: 1, b: 1 } })]
    expect(lines(run(paused, local('2026-10-30T09:17'), { lists }))).toEqual([
      'a | Review day | Rate the October lists of Ben in Film Club. Due in 15 hours.',
      'b | Review day | Rate the October lists of Anna in Film Club. Due in 15 hours.',
      'c | Review day | Rate the October lists of Anna and Ben in Film Club. Due in 15 hours.',
    ])
    const last = run(paused, local('2026-10-30T20:17'), { lists })
    expect(lines(last)).toEqual(['c | 4 hours left | Anna and Ben are waiting for your marks in Film Club.'])
    expect(last.skipped).toEqual([reminderKey('s1', '2026-10', 'last-call', 'a'), reminderKey('s1', '2026-10', 'last-call', 'b')])
  })

  it('a missing week doc: the list’s part alone, still with its points', () => {
    expect(lines(run(space, local('2026-10-30T20:17'), { weeks: [week(W, null)], lists: [october()] }))).toEqual([
      'a | 4 hours left | Miss the Film Club deadline and you lose 5 points.',
      'b | 4 hours left | Miss the Film Club deadline and you lose 5 points.',
      'c | 4 hours left | Miss the Film Club deadline and you lose 10 points.',
    ])
  })

  it('results name the list’s score too', () => {
    const reviews: PeriodSpec['reviews'] = [['b', 'a', { a1: 1 }], ['a', 'b', { b1: 1 }], ['c', 'a', { a1: 1 }], ['a', 'c', { c1: 1 }], ['b', 'c', { c1: 1 }], ['c', 'b', { b1: 1 }]]
    const done = thisWeek({ submittedBy: ['a', 'b', 'c'], reviews })
    const listDone = october({ submittedBy: ['a', 'b', 'c'], reviews: [['b', 'a', { am1: 1 }], ['a', 'b', { bm1: 1, bm2: 0 }], ['c', 'a', { am1: 1 }], ['c', 'b', { bm1: 0, bm2: 0 }]] })
    const result = run(space, local('2026-10-31T09:17'), { weeks: [done], lists: [listDone] })
    expect(lines(result)).toEqual([
      'a | Results are in | You scored 100%, and 100% on your October list. See how Film Club did this week.',
      'b | Results are in | You scored 100%, and 25% on your October list. See how Film Club did this week.',
      'c | Results are in | You scored 100%. See how Film Club did this week.',
    ])
    expect(result.send[0].parts).toEqual(keys('results', 'a'))
    // Chris had no list: its part is final for him.
    expect(result.skipped).toEqual([keys('results', 'c')[1]])
  })

  it('wait for the list to be loaded', () => {
    expect(run(space, local('2026-10-30T09:17'), { weeks: [thisWeek()] }).send).toEqual([])
  })
})

describe('the verdict', () => {
  const nov1 = local('2026-11-01T10:17')
  // Week of Oct 5: Anna and Chris 100%, Ben 0%; everyone reviewed everyone.
  const reviews: PeriodSpec['reviews'] = [['a', 'b', { b1: 0 }], ['b', 'a', { a1: 1 }], ['c', 'a', { a1: 1 }], ['a', 'c', { c1: 1 }], ['b', 'c', { c1: 1 }], ['c', 'b', { b1: 0 }]]
  const weeks = OCTOBER_WEEKS.map((id) => (id === '2026-10-05' ? week(id, { members: ['a', 'b', 'c'], plans: { a: 1, b: 1, c: 1 }, submittedBy: ['a', 'b', 'c'], reviews }) : week(id, null)))
  const space = makeSpace({ memberIds: ['a', 'b', 'c'] })
  const verdictLines = (result: PlanResult) => result.send.filter((r) => r.kind === 'verdict').map((r) => `${r.uid} | ${r.title} | ${r.body}`)
  const line = (text: string, source: 'agreed' | 'house' = 'agreed', together = true) => ({ text, together, source })
  const pair = (reward: string, penalty: string, tiers: TermsInForce['tiers'] = []): TermsInForce => ({ reward: line(reward), penalty: line(penalty), tiers })
  const resultsDoc = (terms: MonthResults['terms'], members: MonthResults['members'] = {}): MonthResults => ({
    monthId: '2026-10',
    completeAt: local('2026-10-31T00:00'),
    members: { a: { score: 100, passed: true, streak: 1 }, b: { score: 0, passed: false, streak: 0 }, c: { score: 100, passed: true, streak: 1 }, ...members },
    terms,
    createdAt: local('2026-11-01T09:00'),
  })
  const verdict = (extra: Partial<Omit<SpaceInput, 'weeks' | 'monthly'>> = {}, at = nov1) => verdictLines(run(space, at, { weeks, lists: [list('2026-10', null)], ...extra }))

  it('quotes the house stakes when nobody agreed on their own', () => {
    expect(verdict()).toEqual([
      'a | You made it: 100% | October in Film Club is done. Collect: Dinner on me',
      'b | You fell short: 0% | October in Film Club is done. Pay up: Coffee for a week',
      'c | You made it: 100% | October in Film Club is done. Collect: Dinner on me',
    ])
  })

  it('quotes the terms that counted per pair: one text, or who to collect from or pay', () => {
    const terms = {
      a: { b: pair('Lunch', 'A coffee'), c: pair('Movie night', 'A beer') },
      b: { a: pair('Pizza', 'Coffee for a week'), c: pair('Pizza', 'Coffee for a week') },
      c: { a: pair('Dinner', 'x'), b: pair('Dinner', 'y') },
    }
    expect(verdict({ results: { '2026-10': resultsDoc(terms) } })).toEqual([
      'a | You made it: 100% | October in Film Club is done. Collect from Ben and Chris.',
      'b | You fell short: 0% | October in Film Club is done. Pay up: Coffee for a week',
      'c | You made it: 100% | October in Film Club is done. Collect: Dinner',
    ])
    const mixed = { ...terms, b: { a: pair('Pizza', 'A coffee'), c: pair('Pizza', 'A beer') } }
    expect(verdict({ results: { '2026-10': resultsDoc(mixed) } })[1]).toBe('b | You fell short: 0% | October in Film Club is done. Pay up to Anna and Chris.')
  })

  it('adds a streak reward reached this month, with the streak in the title', () => {
    const weekend = [{ months: 4, reward: 'Weekend away' }]
    const terms = { a: { b: pair('Dinner', 'p', weekend), c: pair('Dinner', 'p', weekend) }, c: { a: pair('Dinner', 'p'), b: pair('Lunch', 'p') } }
    const members = { a: { score: 100, passed: true, streak: 4, tierRuns: { '4': 4 } }, c: { score: 100, passed: true, streak: 6, tierRuns: { '4': 5 } } }
    expect(verdict({ results: { '2026-10': resultsDoc(terms, members) } })).toEqual([
      'a | 4 months in a row: 100% | October in Film Club is done. Collect: Dinner, plus Weekend away.',
      'b | You fell short: 0% | October in Film Club is done. Pay up: Coffee for a week',
      // Chris's run was reached last month: nothing extra now.
      'c | You made it: 100% | October in Film Club is done. Collect from Anna and Ben.',
    ])
    const mixed = { ...terms, a: { b: pair('Lunch', 'p', weekend), c: pair('Dinner', 'p', weekend) } }
    expect(verdict({ results: { '2026-10': resultsDoc(mixed, members) } })[0]).toBe(
      'a | 4 months in a row: 100% | October in Film Club is done. Collect from Ben and Chris, plus your streak reward.',
    )
  })

  it('without a results doc, takes the agreements made before the month was complete and never a streak reward', () => {
    const terms: PairTerms = { rewardMode: 'group', penaltyMode: 'group', reward: 'Dinner, on you', penalty: 'Coffee', tiers: [{ months: 2, reward: 'Spa day' }] }
    const agreed = (at: number): Agreement => ({ at, terms, past: [] })
    const stakes = (at: number): Record<UID, MemberStakes> => ({
      a: { uid: 'a', ...terms, per: {}, agreed: { b: agreed(local('2026-10-10T12:00')), c: agreed(at) }, updatedAt: local('2026-10-10T11:00') },
    })
    // Both agreed in October: the new stakes counted for October.
    expect(verdict({ memberStakes: stakes(local('2026-10-20T12:00')) })[0]).toBe('a | You made it: 100% | October in Film Club is done. Collect: Dinner, on you')
    // Chris agreed on November 1st: October keeps the house stakes.
    expect(verdict({ memberStakes: stakes(local('2026-11-01T09:00')) })[0]).toBe('a | You made it: 100% | October in Film Club is done. Collect: Dinner on me')
  })

  it('quotes the month’s freeze only when it binds', () => {
    const early = { reward: 'Old dinner', penalty: 'Old coffee', createdAt: local('2026-10-06T08:00') }
    // The previous app froze October at its first lock: October's house stakes are the space's.
    expect(verdict({ stakes: { '2026-10': early } })[1]).toBe('b | You fell short: 0% | October in Film Club is done. Pay up: Coffee for a week')
    expect(verdict({ stakes: { '2026-10': { ...early, createdAt: local('2026-10-31T09:00') } } })[1]).toBe('b | You fell short: 0% | October in Film Club is done. Pay up: Old coffee')
  })

  it('opens on the 3rd when the month’s last deadline spills into it', () => {
    // July 2026's last Friday is the 31st; with reviews due Sunday at midnight it completes Monday Aug 3.
    const late = makeSpace({ schedule: { lock: 1440, reviewOpen: 5760, deadline: 10080 } })
    expect(kinds(late, local('2026-08-01T10:17'))).not.toContain('verdict:2026-07')
    expect(kinds(late, local('2026-08-03T09:59'))).not.toContain('verdict:2026-07')
    expect(dueWindows(late, local('2026-08-03T10:00')).find((w) => w.kind === 'verdict')).toMatchObject({
      period: '2026-07',
      opensAt: local('2026-08-03T10:00'),
      closesAt: local('2026-08-05T00:00'),
    })
  })

  it('is not yet while the month isn’t complete by its stored deadlines', () => {
    // October's list is due later than its last week (not healed): the month ends at 12:00.
    const lateList = list('2026-10', { members: ['a', 'b', 'c'] }, { deadlineAt: local('2026-11-01T12:00') })
    const early = run(space, nov1, { weeks, lists: [lateList] })
    expect(early.send.filter((r) => r.kind === 'verdict')).toEqual([])
    expect(early.skipped.filter((k) => k.includes('verdict'))).toEqual([])
    const later = run(space, local('2026-11-01T12:17'), { weeks, lists: [lateList] })
    expect(later.send.filter((r) => r.kind === 'verdict').map((r) => r.uid)).toEqual(['a', 'b', 'c'])
  })

  it('skips judges-only members: no score', () => {
    const judged = OCTOBER_WEEKS.map((id) =>
      id === '2026-10-05' ? week(id, { members: ['a', 'b', 'c'], judges: ['c'], plans: { a: 1, b: 1 }, submittedBy: ['a', 'b', 'c'], reviews: reviews.filter(([, r]) => r !== 'c') }) : week(id, null),
    )
    const result = run(makeSpace({ memberIds: ['a', 'b', 'c'], judges: ['c'] }), nov1, { weeks: judged, lists: [list('2026-10', null)] })
    expect(result.send.filter((r) => r.kind === 'verdict').map((r) => r.uid)).toEqual(['a', 'b'])
    expect(result.skipped).toContain(reminderKey('s1', '2026-10', 'verdict', 'c'))
  })
})

describe('event pushes', () => {
  const at = local('2026-10-14T21:30')

  describe('pause-ask', () => {
    const pause = { weekId: '2026-10-19', by: 'a', at, oks: ['a', 'b'] }
    // Eve isn't in next week's doc (she joined after it locked), so nobody waits for her.
    const space = makeSpace({ memberIds: ['a', 'b', 'c', 'd', 'e'], pause })
    const next = week('2026-10-19', { members: ['a', 'b', 'c', 'd'] })
    const period = `2026-10-19@${at}`

    it('goes to whoever still has to say OK, once, only in the daytime, until reviews open', () => {
      expect(only(space, at + 60_000, 'pause-ask')).toEqual([])
      expect(only(space, local('2026-10-15T08:59'), 'pause-ask')).toEqual([])
      expect(dueWindows(space, local('2026-10-15T09:00'))).toEqual([
        { kind: 'pause-ask', period, weekIds: ['2026-10-19'], opensAt: local('2026-10-15T09:00'), closesAt: next.week!.reviewOpenAt, expiresAt: next.week!.reviewOpenAt },
      ])
      const result = run(space, local('2026-10-15T09:17'), { weeks: [next], loads: { '2026-10-19': 'doc' } })
      expect(lines(result)).toEqual([
        'c | Pause a week? | Anna wants to pause Film Club for the week of Oct 19. It only happens if everyone says OK.',
        'd | Pause a week? | Anna wants to pause Film Club for the week of Oct 19. It only happens if everyone says OK.',
      ])
      expect(result.send[0]).toMatchObject({ key: `s1_${period}_pause-ask_c`, tag: 'pause-s1', url: './?space=s1', expiresAt: next.week!.reviewOpenAt })
      expect(result.skipped).toEqual(['a', 'b', 'e'].map((u) => `s1_${period}_pause-ask_${u}`))
      expect(only(space, local('2026-10-15T21:00'), 'pause-ask')).toEqual([])
      expect(only(space, local('2026-10-22T20:59'), 'pause-ask')).toEqual([`pause-ask:${period}`])
      // Lapsed when that week's reviews open.
      expect(only(space, local('2026-10-23T10:00'), 'pause-ask')).toEqual([])
    })

    it('stops once answered: declined or withdrawn requests have no window', () => {
      expect(kinds(makeSpace({ pause: { ...pause, declinedBy: 'c' } }), local('2026-10-15T09:17'))).toEqual([])
      expect(kinds(makeSpace({ pause: { ...pause, declinedBy: 'a' } }), local('2026-10-15T09:17'))).toEqual([])
    })

    it('a week read just for the request never decides that week’s other pushes', () => {
      // Monday evening of the paused-to-be week: its plan push needs the whole week, not just its doc.
      const space2 = makeSpace({ pause: { ...pause, at: local('2026-10-19T09:00') } })
      const result = run(space2, local('2026-10-19T19:17'), { weeks: [next], loads: { '2026-10-19': 'doc' } })
      expect(result.send.map((r) => r.kind)).toEqual(['pause-ask', 'pause-ask'])
    })
  })

  it('paused: everyone but whoever completed it hears, until that week’s reviews open', () => {
    const space = makeSpace({ pause: { weekId: '2026-10-19', by: 'a', at, oks: ['a', 'b', 'c', 'd'] }, paused: { '2026-10': '2026-10-19' } })
    const result = run(space, local('2026-10-15T09:17'))
    expect(lines(result)).toEqual(['a', 'b', 'c'].map((u) => `${u} | Week paused | Everyone said OK: Film Club is paused the week of Oct 19. Nothing counts that week.`))
    expect(result.send[0]).toMatchObject({ key: `s1_2026-10-19@${at}_paused_a`, tag: 'pause-s1', url: './?space=s1' })
    expect(result.skipped).toEqual([`s1_2026-10-19@${at}_paused_d`])
    expect(kinds(space, local('2026-10-23T10:00'))).toEqual([])
  })

  it('schedule: members who joined before the change, not the owner, for 3 days', () => {
    const noteAt = local('2026-10-14T10:00')
    const space = makeSpace({
      schedule: { lock: 1200, reviewOpen: 5760, deadline: 7920 },
      scheduleNote: { by: 'a', at: noteAt, fromWeek: '2026-10-19', before: DEFAULT_SCHEDULE },
      joinedAt: { d: noteAt + 1000 },
    })
    const result = run(space, local('2026-10-14T10:17'))
    expect(lines(result)).toEqual(
      ['b', 'c'].map((u) => `${u} | New times in Film Club | Anna changed them. From next week, lists lock Monday at 8:00 PM and reviews are due Saturday at noon, Berlin time.`),
    )
    expect(result.send[0]).toMatchObject({ key: `s1_2026-10-19@${noteAt}_schedule_b`, tag: 'schedule-s1', url: './?space=s1', expiresAt: noteAt + 3 * 86_400_000 })
    expect(result.skipped).toEqual(['a', 'd'].map((u) => `s1_2026-10-19@${noteAt}_schedule_${u}`))
    expect(only(space, noteAt + 3 * 86_400_000 - 1, 'schedule')).toEqual([`schedule:2026-10-19@${noteAt}`])
    expect(only(space, noteAt + 3 * 86_400_000, 'schedule')).toEqual([])
  })

  it('house: everyone who joined before the change, quoting the new stakes and when they count', () => {
    const noteAt = local('2026-10-14T10:00')
    const space = makeSpace({ stakesNote: { by: 'a', at: noteAt } })
    const result = run(space, local('2026-10-14T10:17'))
    expect(lines(result)).toEqual(
      ['b', 'c', 'd'].map(
        (u) => `${u} | New house stakes in Film Club | Anna changed them: “Dinner on me” if you hit 90%, “Coffee for a week” if you miss. They count now, where friends haven’t agreed on their own.`,
      ),
    )
    expect(result.send[0]).toMatchObject({ key: `s1_house@${noteAt}_house_b`, tag: 'stakes-s1', url: './?space=s1' })
    // Changed on the Saturday after October's last Friday: October is complete, so they count from November.
    const saturday = local('2026-10-31T10:00')
    const late = run(makeSpace({ stakesNote: { by: 'a', at: saturday } }), local('2026-10-31T10:17'))
    expect(late.send.find((r) => r.kind === 'house')?.body).toBe(
      'Anna changed them: “Dinner on me” if you hit 90%, “Coffee for a week” if you miss. They count from November, where friends haven’t agreed on their own.',
    )
  })

  describe('stakes', () => {
    const terms: PairTerms = { rewardMode: 'group', penaltyMode: 'group', reward: 'Lunch', penalty: 'Coffee', tiers: [] }
    const updatedAt = local('2026-10-13T12:00')
    const ben: MemberStakes = { uid: 'b', ...terms, per: {}, agreed: { c: { at: updatedAt + 1000, terms, past: [] } }, updatedAt }
    const space = makeSpace({ judges: ['d'] })

    it('asks each current friend who hasn’t agreed, not judges, for a week after the change', () => {
      expect(stakesCandidates(space, { b: ben }, local('2026-10-14T12:00'))).toEqual([
        { owner: 'b', friend: 'a', key: `s1_b@${updatedAt}_stakes_a`, expiresAt: updatedAt + 7 * 86_400_000 },
      ])
      const result = run(space, local('2026-10-14T12:00'), { memberStakes: { b: ben } })
      expect(lines(result)).toEqual(['a | New stakes from Ben | Ben has new stakes in Film Club. Take a look, and tap Agree if you’re in.'])
      expect(result.send[0]).toMatchObject({ kind: 'stakes', tag: 'stakes-s1', url: './?space=s1', expiresAt: updatedAt + 7 * 86_400_000 })
      // Once sent, or answered, nothing more.
      expect(run(space, local('2026-10-14T13:00'), { memberStakes: { b: ben } }, [`s1_b@${updatedAt}_stakes_a`]).send).toEqual([])
      const agreed = { ...ben, agreed: { ...ben.agreed, a: { at: updatedAt + 2000, terms, past: [] } } }
      expect(run(space, local('2026-10-14T13:00'), { memberStakes: { b: agreed } }).send).toEqual([])
    })

    it('only in the daytime, and not for changes older than a week', () => {
      expect(run(space, local('2026-10-14T21:17'), { memberStakes: { b: ben } }).send).toEqual([])
      expect(run(space, local('2026-10-14T08:30'), { memberStakes: { b: ben } }).send).toEqual([])
      expect(stakesCandidates(space, { b: ben }, updatedAt + 7 * 86_400_000)).toEqual([])
      // Without the stakes docs loaded, nothing is decided.
      expect(planWindows({ space, weeks: {} }, local('2026-10-14T12:00')).map((w) => w.kind)).toEqual([])
    })
  })
})

describe('golden: usual times, no judges, no lists, no pause (every kind exactly as before batch 2)', () => {
  it('sends the same keys, copy, tags and links through a whole week and the verdict', () => {
    const space = makeSpace({ memberIds: ['a', 'b'] })
    const W = '2026-10-12'
    const planning = week(W, { members: ['a', 'b'], plans: { a: 2 } })
    const active = week(W, { members: ['a', 'b'], plans: { a: 2, b: 1 }, done: { b: ['b1'] } })
    const reviewing = week(W, { members: ['a', 'b'], plans: { a: 2, b: 1 }, done: { b: ['b1'] } })
    const closed = week(W, { members: ['a', 'b'], plans: { a: 2, b: 1 }, submittedBy: ['a', 'b'], reviews: [['a', 'b', { b1: 1 }], ['b', 'a', { a1: 1, a2: 0.5 }]] })
    const all = (r: PlanResult) => r.send.map((s) => `${s.key} | ${s.title} | ${s.body} | ${s.tag} | ${s.url} | ${s.parts ?? '-'}`)
    expect(all(run(space, local('2026-10-12T19:17'), { weeks: [planning] }))).toEqual([
      's1_2026-10-12_plan_b | Lock in your week | Your list for Film Club locks in 5 hours. Nothing planned = 0%. | plan-s1 | ./ | -',
    ])
    expect(all(run(space, local('2026-10-14T18:17'), { weeks: [active] }))).toEqual([
      's1_2026-10-12_no-progress_a | Nothing ticked yet | Halfway through the week in Film Club. 2 tasks to go before Friday. | no-progress-s1 | ./ | -',
    ])
    expect(all(run(space, local('2026-10-15T18:17'), { weeks: [active] }))).toEqual([
      's1_2026-10-12_open-tasks_a | 2 of 2 tasks still open | Reviews in Film Club start in 6 hours. Finish what you can before then. | open-tasks-s1 | ./ | -',
    ])
    expect(all(run(space, local('2026-10-16T09:17'), { weeks: [reviewing] }))).toEqual([
      's1_2026-10-12_review_a | Review day | Rate Ben in Film Club. Due in 15 hours. | review-s1 | ./ | -',
      's1_2026-10-12_review_b | Review day | Rate Anna in Film Club. Due in 15 hours. | review-s1 | ./ | -',
    ])
    expect(all(run(space, local('2026-10-16T20:17'), { weeks: [reviewing] }))).toEqual([
      's1_2026-10-12_last-call_a | 4 hours left | Miss the Film Club deadline and you lose 5 points. | review-s1 | ./ | -',
      's1_2026-10-12_last-call_b | 4 hours left | Miss the Film Club deadline and you lose 5 points. | review-s1 | ./ | -',
    ])
    expect(all(run(space, local('2026-10-17T09:17'), { weeks: [closed] }))).toEqual([
      's1_2026-10-12_results_a | Results are in | You scored 75%. See how Film Club did this week. | results-s1 | ./ | -',
      's1_2026-10-12_results_b | Results are in | You scored 100%. See how Film Club did this week. | results-s1 | ./ | -',
    ])
    const october = OCTOBER_WEEKS.map((id) => (id === W ? closed : week(id, null)))
    expect(all(run(space, local('2026-11-01T10:17'), { weeks: october, lists: [list('2026-10', null)] })).filter((l) => l.includes('verdict'))).toEqual([
      's1_2026-10_verdict_a | You fell short: 75% | October in Film Club is done. Pay up: Coffee for a week | verdict-s1 | ./ | -',
      's1_2026-10_verdict_b | You made it: 100% | October in Film Club is done. Collect: Dinner on me | verdict-s1 | ./ | -',
    ])
  })
})
