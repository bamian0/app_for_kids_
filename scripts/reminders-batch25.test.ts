// The batch-2.5 reminders (SPEC §10.8): the midweek nudges count only tasks that aren't crossed out, the results
// push says when friends said fair and a week or a monthly list doesn't count, and nothing changes without
// cross-outs.
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { monthlyBounds, weekBounds } from '../src/domain/time.ts'
import type { MonthId, MonthlyData, ReviewMark, Space, Task, TaskCancel, UID, WeekData, WeekId } from '../src/domain/types.ts'
import { planSpace, reminderKey, type PlanResult, type SpaceInput } from './reminders-plan.ts'

const TZ = 'Europe/Berlin'
/** Wall-clock time in Berlin ('2026-10-30T09:17') → ms. Berlin is UTC+2 until Sun 2026-10-25, UTC+1 after. */
const local = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toMillis()
const PROFILES = { a: { name: 'Anna' }, b: { name: 'Ben' }, c: { name: 'Chris' }, d: { name: 'Dana' } }
const OCTOBER_WEEKS = ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']

function makeSpace(overrides: Partial<Space> = {}): Space {
  return {
    id: 's1',
    name: 'Film Club',
    reward: 'Dinner on me',
    penalty: 'Coffee for a week',
    ownerId: 'a',
    memberIds: ['a', 'b', 'c'],
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
  /** Task ids crossed out now (1 change), or with the given number of changes (2 and 4 are restored). */
  cancels?: Record<string, number>
  done?: Record<UID, string[]>
  reviews?: [reviewer: UID, reviewee: UID, marks: Record<string, ReviewMark>][]
  judges?: UID[]
}

function cancelOf(changes: number, atMs: number): TaskCancel {
  return { cancelled: changes % 2 === 1, changes, at: atMs, why: 'The pool is closed all week' }
}

function fill<T extends WeekData | MonthlyData>(data: T, spec: PeriodSpec, prefix: string, lockAt: number, reviewAt: number): T {
  for (const [uid, n] of Object.entries(spec.plans ?? {})) {
    const tasks: Task[] = Array.from({ length: n }, (_, i) => ({ id: `${uid}${prefix}${i + 1}`, title: `Task ${i + 1}` }))
    for (const task of tasks) {
      const changes = spec.cancels?.[task.id]
      if (changes) task.cancel = cancelOf(changes, lockAt + 3_600_000)
    }
    data.plans[uid] = { uid, updatedAt: 0, tasks }
  }
  for (const [uid, ids] of Object.entries(spec.done ?? {})) data.progress[uid] = { uid, updatedAt: 0, done: Object.fromEntries(ids.map((id) => [id, true])) }
  data.reviews = (spec.reviews ?? []).map(([reviewerId, revieweeId, marks]) => ({ id: `${reviewerId}_${revieweeId}`, reviewerId, revieweeId, marks, submittedAt: reviewAt }))
  return data
}

function week(weekId: WeekId, spec: PeriodSpec | null): WeekData {
  const data: WeekData = { spaceId: 's1', weekId, week: null, plans: {}, progress: {}, reviews: [] }
  if (!spec) return data
  const b = weekBounds(weekId, TZ)
  data.week = { id: weekId, spaceId: 's1', ...b, members: spec.members ?? [], submittedBy: spec.submittedBy ?? [] }
  if (spec.judges) data.week.judges = spec.judges
  return fill(data, spec, '', b.lockAt, b.reviewOpenAt)
}

function list(monthId: MonthId, spec: PeriodSpec | null): MonthlyData {
  const data: MonthlyData = { spaceId: 's1', monthId, monthly: null, plans: {}, progress: {}, reviews: [] }
  if (!spec) return data
  const b = monthlyBounds(monthId, (w) => weekBounds(w, TZ))
  data.monthly = { id: monthId, spaceId: 's1', ...b, members: spec.members ?? [], submittedBy: spec.submittedBy ?? [], judges: spec.judges ?? [] }
  return fill(data, spec, 'm', b.lockAt, b.reviewOpenAt)
}

function run(space: Space, nowMs: number, data: { weeks?: WeekData[]; lists?: MonthlyData[] } = {}, sent: string[] = []): PlanResult {
  const { weeks = [], lists = [] } = data
  const input: SpaceInput = {
    space,
    weeks: Object.fromEntries(weeks.map((w) => [w.weekId, w])),
    monthly: Object.fromEntries(lists.map((l) => [l.monthId, l])),
  }
  return planSpace(input, PROFILES, new Set(sent), nowMs)
}

const lines = (result: PlanResult) => result.send.map((r) => `${r.uid} | ${r.title} | ${r.body}`)

describe('midweek nudges ignore crossed-out tasks', () => {
  const W = '2026-10-12'
  const space = makeSpace()

  it('no-progress: a tick on a crossed-out task isn’t progress, and only the tasks still on count', () => {
    // Anna ticked a1 and then crossed it out; a2 and a3 are untouched. Ben crossed out both of his. Chris ticked c2.
    const data = week(W, { members: ['a', 'b', 'c'], plans: { a: 3, b: 2, c: 2 }, cancels: { a1: 1, b1: 1, b2: 3, c1: 1 }, done: { a: ['a1'], c: ['c2'] } })
    const result = run(space, local('2026-10-14T18:17'), { weeks: [data] })
    expect(lines(result)).toEqual(['a | Nothing ticked yet | Halfway through the week in Film Club. 2 tasks to go before Friday.'])
    // Ben could still undo, so his answer isn't final; nothing is logged.
    expect(result.skipped).toEqual([])
  })

  it('open-tasks: “K of N” counts only the tasks still on; every task crossed out gets nothing (not final)', () => {
    const data = week(W, { members: ['a', 'b', 'c'], plans: { a: 3, b: 2, c: 2 }, cancels: { a1: 1, b1: 1, b2: 1, c1: 5 }, done: { a: ['a2'], c: ['c2'] } })
    const result = run(space, local('2026-10-15T18:17'), { weeks: [data] })
    expect(lines(result)).toEqual(['a | 1 of 2 tasks still open | Reviews in Film Club start in 6 hours. Finish what you can before then.'])
    expect(result.skipped).toEqual([])
  })

  it('a restored task counts as usual', () => {
    const data = week(W, { members: ['a', 'b', 'c'], plans: { a: 2, b: 1, c: 1 }, cancels: { a1: 2, b1: 4 }, done: { c: ['c1'] } })
    expect(lines(run(space, local('2026-10-15T18:17'), { weeks: [data] }))).toEqual([
      'a | 2 of 2 tasks still open | Reviews in Film Club start in 6 hours. Finish what you can before then.',
      'b | 1 of 1 task still open | Reviews in Film Club start in 6 hours. Finish what you can before then.',
    ])
  })
})

describe('results when friends said fair', () => {
  it('a week where every task was excused: due, saying it doesn’t count', () => {
    const W = '2026-10-12'
    // Anna's only task is crossed out: Ben and Chris both said fair. Ben's was crossed out too, but only Chris said
    // fair (a tie): it counts as not done.
    const reviews: PeriodSpec['reviews'] = [
      ['b', 'a', { a1: 'fair' }],
      ['c', 'a', { a1: 'fair' }],
      ['a', 'b', { b1: 0, b2: 1 }],
      ['c', 'b', { b1: 'fair', b2: 1 }],
      ['a', 'c', { c1: 1 }],
      ['b', 'c', { c1: 0.5 }],
    ]
    const data = week(W, { members: ['a', 'b', 'c'], plans: { a: 1, b: 2, c: 1 }, cancels: { a1: 1, b1: 1 }, submittedBy: ['a', 'b', 'c'], reviews })
    const result = run(makeSpace(), local('2026-10-17T09:17'), { weeks: [data] })
    expect(lines(result)).toEqual([
      'a | Results are in | Your friends said fair, so this week doesn’t count for you. See how Film Club did this week.',
      'b | Results are in | You scored 50%. See how Film Club did this week.',
      'c | Results are in | You scored 75%. See how Film Club did this week.',
    ])
    expect(result.send[0].key).toBe(reminderKey('s1', W, 'results', 'a'))
    // Once it's logged, it isn't sent again.
    expect(lines(run(makeSpace(), local('2026-10-17T10:17'), { weeks: [data] }, [reminderKey('s1', W, 'results', 'a')]))).toHaveLength(2)
  })

  describe('in a month’s last week, with the list', () => {
    const W = '2026-10-26'
    const space = makeSpace()
    const at = local('2026-10-31T09:17')
    // Week: Anna's a1 crossed out; Ben's b1 crossed out. List: Ben's bm1 crossed out; Chris's cm1 crossed out.
    const weekReviews = (fairA: boolean, fairB: boolean): PeriodSpec['reviews'] => [
      ['b', 'a', { a1: fairA ? 'fair' : 0 }],
      ['c', 'a', { a1: fairA ? 'fair' : 0 }],
      ['a', 'b', { b1: fairB ? 'fair' : 0 }],
      ['c', 'b', { b1: fairB ? 'fair' : 0 }],
      ['a', 'c', { c1: 1 }],
      ['b', 'c', { c1: 0.5 }],
    ]
    const thisWeek = (fairA: boolean, fairB: boolean) =>
      week(W, { members: ['a', 'b', 'c'], plans: { a: 1, b: 1, c: 1 }, cancels: { a1: 1, b1: 1 }, submittedBy: ['a', 'b', 'c'], reviews: weekReviews(fairA, fairB) })
    const october = (fair: boolean) =>
      list('2026-10', {
        members: ['a', 'b', 'c'],
        plans: { a: 1, b: 1, c: 1 },
        cancels: { bm1: 1, cm1: 1 },
        submittedBy: ['a', 'b', 'c'],
        reviews: [
          ['b', 'a', { am1: 1 }],
          ['c', 'a', { am1: 0.5 }],
          ['a', 'b', { bm1: fair ? 'fair' : 1 }],
          ['c', 'b', { bm1: fair ? 'fair' : 0 }],
          ['a', 'c', { cm1: 'fair' }],
          ['b', 'c', { cm1: 'fair' }],
        ],
      })

    it('week skipped with the list scored; week scored with the list skipped; both skipped', () => {
      const result = run(space, at, { weeks: [thisWeek(true, true)], lists: [october(true)] })
      expect(lines(result)).toEqual([
        'a | Results are in | Your friends said fair, so this week doesn’t count for you. You scored 75% on your October list. See how Film Club did this week.',
        'b | Results are in | Your friends said fair, so this week and your October list don’t count for you. See how Film Club did this week.',
        'c | Results are in | You scored 75%. Your October list doesn’t count: your friends said fair. See how Film Club did this week.',
      ])
      // Each push carries both parts.
      expect(result.send.map((r) => r.parts)).toEqual(['a', 'b', 'c'].map((u) => [reminderKey('s1', W, 'results', u), reminderKey('s1', '2026-10', 'results', u)]))
    })

    it('not excused: the crossed-out task counts as not done', () => {
      const result = run(space, at, { weeks: [thisWeek(false, false)], lists: [october(false)] })
      expect(lines(result)).toEqual([
        'a | Results are in | You scored 0%, and 75% on your October list. See how Film Club did this week.',
        'b | Results are in | You scored 0%, and 0% on your October list. See how Film Club did this week.',
        'c | Results are in | You scored 75%. Your October list doesn’t count: your friends said fair. See how Film Club did this week.',
      ])
    })

    it('judging the week, playing the list: only the list’s part, which doesn’t count', () => {
      const judged = week(W, { members: ['a', 'b', 'c'], judges: ['c'], plans: { a: 1, b: 1 }, submittedBy: ['a', 'b', 'c'], reviews: [['b', 'a', { a1: 1 }], ['a', 'b', { b1: 1 }], ['c', 'a', { a1: 1 }], ['c', 'b', { b1: 1 }]] })
      expect(lines(run(space, at, { weeks: [judged], lists: [october(true)] }))[2]).toBe(
        'c | Results are in | Your October list doesn’t count: your friends said fair. See how Film Club did this week.',
      )
    })

    it('a paused last week: the list alone', () => {
      const paused = makeSpace({ paused: { '2026-10': W } })
      expect(lines(run(paused, at, { lists: [october(true)] }))).toEqual([
        'a | Results are in | You scored 75% on your October list. See how Film Club did this month.',
        'b | Results are in | Your October list doesn’t count: your friends said fair. See how Film Club did this month.',
        'c | Results are in | Your October list doesn’t count: your friends said fair. See how Film Club did this month.',
      ])
    })
  })

  it('a skipped month: no verdict for them, and the others don’t count them as a player', () => {
    const W = '2026-10-12'
    const reviews: PeriodSpec['reviews'] = [
      ['b', 'a', { a1: 'fair' }],
      ['c', 'a', { a1: 'fair' }],
      ['a', 'b', { b1: 1 }],
      ['c', 'b', { b1: 1 }],
      ['a', 'c', { c1: 0 }],
      ['b', 'c', { c1: 0 }],
    ]
    const closed = week(W, { members: ['a', 'b', 'c'], plans: { a: 1, b: 1, c: 1 }, cancels: { a1: 1 }, submittedBy: ['a', 'b', 'c'], reviews })
    const weeks = OCTOBER_WEEKS.map((id) => (id === W ? closed : week(id, null)))
    const result = run(makeSpace(), local('2026-11-01T10:17'), { weeks, lists: [list('2026-10', null)] })
    expect(result.send.filter((r) => r.kind === 'verdict').map((r) => `${r.uid} | ${r.title} | ${r.body}`)).toEqual([
      'b | You made it: 100% | October in Film Club is done. Collect: Dinner on me',
      'c | You fell short: 0% | October in Film Club is done. Pay up: Coffee for a week',
    ])
    expect(result.skipped).toContain(reminderKey('s1', '2026-10', 'verdict', 'a'))
  })
})

describe('without cross-outs nothing changes', () => {
  it('restored tasks and fair votes on tasks that aren’t crossed out send exactly what plain data sends, every hour of a week', () => {
    const space = makeSpace()
    const W = '2026-10-26'
    const spec = (restored: boolean): PeriodSpec => ({
      members: ['a', 'b', 'c'],
      plans: { a: 2, b: 1, c: 2 },
      cancels: restored ? { a1: 2, c2: 4 } : {},
      done: { a: ['a2'], c: ['c1'] },
      submittedBy: ['a', 'b'],
      reviews: [
        ['a', 'b', { b1: 1 }],
        ['b', 'a', { a1: 0.5, a2: 1 }],
        ['b', 'c', { c1: 1, c2: 0 }],
        ['a', 'c', { c1: 1, c2: 0 }],
      ],
    })
    const listSpec = (restored: boolean): PeriodSpec => ({ ...spec(restored), plans: { a: 1, b: 2 }, cancels: restored ? { bm2: 2 } : {}, reviews: [['a', 'b', { bm1: 1, bm2: 0.5 }]] })
    // A fair vote on a task that isn't crossed out counts 0, exactly like Not done.
    const withFair = (data: WeekData): WeekData => ({ ...data, reviews: data.reviews.map((r) => (r.reviewerId === 'a' && r.revieweeId === 'c' ? { ...r, marks: { c1: 1, c2: 'fair' } } : r)) })
    for (let t = local('2026-10-26T00:17'); t < local('2026-11-02T10:17'); t += 3_600_000) {
      const plain = run(space, t, { weeks: [week(W, spec(false))], lists: [list('2026-10', listSpec(false))] })
      const changed = run(space, t, { weeks: [withFair(week(W, spec(true)))], lists: [list('2026-10', listSpec(true))] })
      expect(changed).toEqual(plain)
    }
  })
})
