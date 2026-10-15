import { describe, expect, it } from 'vitest'
import { computeMonthly } from '../../domain/scoring.ts'
import { monthlyBounds, weekBounds } from '../../domain/time.ts'
import type { MonthlyData, MonthlyList, Plan, Progress, Review, Space, UID, Week, WeekData } from '../../domain/types.ts'
import { judgeDetail, monthlyCardView, monthlyPill, noListNote, planningFooter } from './copy.ts'
import { reviewParts } from './review.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const BERLIN = 'Europe/Berlin'
const MONTH = '2026-10'
/** October 2026's last week: Mon Oct 26 – Sun Nov 1 (Friday Oct 30). Its review window also reviews the lists. */
const LAST = '2026-10-26'
const SEP1 = Date.UTC(2026, 8, 1)

const lastBounds = weekBounds(LAST, BERLIN)
const listBounds = monthlyBounds(MONTH, (w) => weekBounds(w, BERLIN))
/** Friday Oct 30, noon in Berlin: inside both review windows. */
const REVIEW = lastBounds.reviewOpenAt + 12 * HOUR

function space(over: Partial<Space> = {}): Space {
  const members = over.memberIds ?? ['a', 'b', 'c']
  return {
    id: 's',
    name: 'Film Club',
    reward: 'Dinner',
    penalty: 'Coffee',
    ownerId: 'a',
    memberIds: members,
    joinedAt: Object.fromEntries(members.map((uid) => [uid, SEP1])),
    timezone: BERLIN,
    utcOffsetMin: 120,
    inviteCode: 'ABCDEFGH',
    threshold: 90,
    latePenalty: 5,
    createdAt: SEP1,
    ...over,
  }
}

function plans(tasks: Record<UID, number>): Record<UID, Plan> {
  return Object.fromEntries(
    Object.entries(tasks).map(([uid, n]) => [uid, { uid, updatedAt: SEP1, tasks: Array.from({ length: n }, (_, i) => ({ id: `${uid}${i}`, title: `Task ${i + 1}` })) }]),
  )
}

function week(over: Partial<Week> = {}): Week {
  return { id: LAST, spaceId: 's', ...lastBounds, members: ['a', 'b', 'c'], submittedBy: [], ...over }
}

function list(over: Partial<MonthlyList> = {}): MonthlyList {
  return { id: MONTH, spaceId: 's', ...listBounds, members: ['a', 'b', 'c'], judges: [], submittedBy: [], ...over }
}

function weekData(doc: Week | null, tasks: Record<UID, number> = {}): WeekData {
  return { spaceId: 's', weekId: LAST, week: doc, plans: plans(tasks), progress: {}, reviews: [] }
}

function monthlyData(doc: MonthlyList | null, tasks: Record<UID, number> = {}, progress: Record<UID, Progress> = {}, reviews: Review[] = []): MonthlyData {
  return { spaceId: 's', monthId: MONTH, monthly: doc, plans: plans(tasks), progress, reviews }
}

describe('reviewParts', () => {
  it('opens both parts in the month’s last review window, with one page per person', () => {
    const parts = reviewParts(weekData(week(), { b: 2, c: 1 }), monthlyData(list(), { a: 1, c: 3 }), 'a', space(), REVIEW)
    expect(parts.weekly).toEqual({ open: true, targets: ['b', 'c'] })
    expect(parts.monthly).toEqual({ open: true, targets: ['c'] })
    expect(parts.people).toEqual(['b', 'c'])
    expect(parts.confirm).toBe(false)
  })

  it('is the weekly part alone in an ordinary week', () => {
    const parts = reviewParts(weekData(week(), { b: 2 }), undefined, 'a', space(), REVIEW)
    expect(parts.weekly.targets).toEqual(['b'])
    expect(parts.monthly).toEqual({ open: false, targets: [] })
    expect(parts.people).toEqual(['b'])
  })

  it('keeps both closed outside the window', () => {
    for (const at of [lastBounds.reviewOpenAt - 1, lastBounds.deadlineAt]) {
      const parts = reviewParts(weekData(week(), { b: 2 }), monthlyData(list(), { b: 1 }), 'a', space(), at)
      expect(parts.weekly.open || parts.monthly.open).toBe(false)
      expect(parts.people).toEqual([])
      expect(parts.confirm).toBe(false)
    }
  })

  it('has no weekly part in a paused week, but the monthly lists are still reviewed', () => {
    const paused = space({ paused: { [MONTH]: LAST } })
    const parts = reviewParts(weekData(week(), { b: 2 }), monthlyData(list(), { c: 1 }), 'a', paused, REVIEW)
    expect(parts.weekly.open).toBe(false)
    expect(parts.monthly).toEqual({ open: true, targets: ['c'] })
    expect(parts.people).toEqual(['c'])
  })

  it('has no weekly part without a week doc', () => {
    const parts = reviewParts(weekData(null), monthlyData(list(), { b: 1 }), 'a', space(), REVIEW)
    expect(parts.weekly.open).toBe(false)
    expect(parts.people).toEqual(['b'])
  })

  it('closes a part once you submitted it, leaving the other', () => {
    const parts = reviewParts(weekData(week({ submittedBy: ['a'] }), { b: 2 }), monthlyData(list(), { b: 1 }), 'a', space(), REVIEW)
    expect(parts.weekly.open).toBe(false)
    expect(parts.monthly).toEqual({ open: true, targets: ['b'] })
  })

  it('reviews a friend who left after the lock (membersAt the lock, not the deadline)', () => {
    // Ben left on Wednesday, after Monday’s lock: his week still counts, so he is still reviewed.
    const left = space({ memberIds: ['a', 'c'], leftAt: { b: lastBounds.lockAt + DAY } })
    const parts = reviewParts(weekData(week(), { b: 2, c: 1 }), monthlyData(list(), { b: 1 }), 'a', left, REVIEW)
    expect(parts.weekly.targets).toEqual(['b', 'c'])
    expect(parts.monthly.targets).toEqual(['b'])
  })

  it('never makes a judge a target, and lets a judge review everyone', () => {
    const doc = week({ judges: ['c'] })
    const tasks = { b: 2, c: 4 } // Cat's plan is left over from before she judged.
    expect(reviewParts(weekData(doc, tasks), undefined, 'a', space({ judges: ['c'] }), REVIEW).weekly.targets).toEqual(['b'])
    expect(reviewParts(weekData(doc, { a: 1, b: 2, c: 4 }), undefined, 'c', space({ judges: ['c'] }), REVIEW).weekly.targets).toEqual(['a', 'b'])
    const monthlyJudge = monthlyData(list({ judges: ['c'] }), { a: 1, c: 2 })
    expect(reviewParts(undefined, monthlyJudge, 'b', space(), REVIEW).monthly.targets).toEqual(['a'])
  })

  it('asks for a confirm when an open part has nobody to review but friends wait on it', () => {
    const parts = reviewParts(weekData(week()), monthlyData(list()), 'a', space(), REVIEW)
    expect(parts.weekly).toEqual({ open: true, targets: [] })
    expect(parts.confirm).toBe(true)
    // Alone in the week: nobody waits.
    const alone = reviewParts(weekData(week({ members: ['a'] })), undefined, 'a', space({ memberIds: ['a'] }), REVIEW)
    expect(alone.weekly.open).toBe(true)
    expect(alone.confirm).toBe(false)
    // Only someone who left is left in it: they can’t review, so there is nobody to unlock it for.
    const leaver = space({ memberIds: ['a'], leftAt: { b: lastBounds.lockAt + DAY, c: lastBounds.lockAt + DAY } })
    expect(reviewParts(weekData(week()), undefined, 'a', leaver, REVIEW).confirm).toBe(false)
  })

  it('opens nothing for someone outside the period or no longer in the space', () => {
    expect(reviewParts(weekData(week({ members: ['b', 'c'] }), { b: 1 }), undefined, 'a', space(), REVIEW).weekly.open).toBe(false)
    const gone = space({ memberIds: ['b', 'c'], leftAt: { a: lastBounds.lockAt + DAY } })
    expect(reviewParts(weekData(week(), { b: 1 }), monthlyData(list(), { b: 1 }), 'a', gone, REVIEW).people).toEqual([])
  })
})

describe('monthlyCardView', () => {
  const names: Record<UID, string> = { a: 'Ann', b: 'Lena', c: 'Sam', d: 'Kim', e: 'Ana' }
  const card = (data: MonthlyData | undefined, nowMs: number, me = 'a', s: Space = space()) =>
    monthlyCardView({
      space: s,
      me,
      nowMs,
      data,
      result: data ? computeMonthly(data, s, nowMs) : null,
      name: (uid) => names[uid],
      when: (ms) => (ms === listBounds.lockAt ? 'Monday at midnight' : ms === listBounds.deadlineAt ? 'tonight at midnight' : 'then'),
    })
  const planning = listBounds.startAt + 2 * DAY
  const active = listBounds.lockAt + 3 * DAY

  it('invites you to plan before the lock', () => {
    expect(card(monthlyData(list()), planning)).toEqual({
      title: 'Your October list',
      subtitle: 'Optional: a few bigger things for October. Locks Monday at midnight.',
      lead: { kind: 'icon', icon: 'calendar' },
    })
    expect(card(monthlyData(list(), { a: 3 }), planning)).toMatchObject({ title: 'Your October list', subtitle: '3 tasks · locks Monday at midnight', lead: { kind: 'ring', done: 0, total: 3 } })
    expect(card(monthlyData(list(), { a: 1 }), planning)?.subtitle).toBe('1 task · locks Monday at midnight')
  })

  it('shows before the list exists, from 8 days before the month’s first week, and not earlier', () => {
    expect(card(monthlyData(null), listBounds.startAt - 7 * DAY)?.title).toBe('Your October list')
    expect(card(monthlyData(null), listBounds.startAt - 9 * DAY)).toBeNull()
    // A space without utcOffsetMin can’t have monthly lists.
    expect(card(monthlyData(null), planning, 'a', space({ utcOffsetMin: undefined }))).toBeNull()
    // No list was made before the lock: nothing to show after it.
    expect(card(monthlyData(null), active)).toBeNull()
  })

  it('tells a judge they rate the lists', () => {
    const judgeSpace = space({ judges: ['a'] })
    expect(card(monthlyData(list({ judges: ['a'] })), planning, 'a', judgeSpace)).toEqual({
      title: 'October lists',
      subtitle: 'You rate them in October’s last week.',
      lead: { kind: 'icon', icon: 'person2' },
    })
    expect(card(monthlyData(list({ judges: ['a'] }), { b: 1 }), active, 'a', judgeSpace)?.subtitle).toBe('You rate them in October’s last week.')
    expect(card(monthlyData(list({ judges: ['a'] }), { b: 1 }), REVIEW, 'a', judgeSpace)?.subtitle).toBe('In review · due tonight at midnight')
  })

  it('tracks your list after the lock: done so far, in review, then the score', () => {
    const progress: Record<UID, Progress> = { a: { uid: 'a', updatedAt: SEP1, done: { a0: true, a1: true } } }
    const after = card(monthlyData(list(), { a: 3, b: 1 }, progress), active)
    expect(after).toMatchObject({ title: 'Your October list', subtitle: '2 of 3 done', lead: { kind: 'ring', done: 2, total: 3 }, score: { provisional: true } })
    expect(after?.score?.value).toBeCloseTo(66.667, 2)
    expect(card(monthlyData(list(), { a: 3, b: 1 }, progress), REVIEW)?.subtitle).toBe('In review · due tonight at midnight')
    const marks = { a0: 1, a1: 1, a2: 0.5 } as const
    const reviews: Review[] = [{ id: 'b_a', reviewerId: 'b', revieweeId: 'a', marks, submittedAt: REVIEW }]
    const revealed = card(monthlyData(list({ submittedBy: ['a', 'b', 'c'] }), { a: 3, b: 1 }, progress, reviews), REVIEW)
    expect(revealed).toMatchObject({ subtitle: 'Score 83%', score: { value: 250 / 3, provisional: false } })
  })

  it('names the friends with a list when you have none, and hides when nobody has one', () => {
    expect(card(monthlyData(list(), { b: 2, c: 1 }), active)).toEqual({
      title: 'October lists',
      subtitle: 'Lena and Sam have one. Yours is optional; you’ll review theirs in October’s last week.',
      lead: { kind: 'icon', icon: 'calendar' },
    })
    expect(card(monthlyData(list(), { b: 2 }), active)?.subtitle).toBe('Lena has one. Yours is optional; you’ll review theirs in October’s last week.')
    expect(card(monthlyData(list(), { b: 2 }), REVIEW)?.subtitle).toBe('In review · due tonight at midnight')
    expect(card(monthlyData(list()), active)).toBeNull()
  })

  it('hides for someone outside a locked list, and while loading', () => {
    expect(card(monthlyData(list({ members: ['b', 'c'] }), { b: 2 }), active)).toBeNull()
    expect(card(undefined, active)).toBeNull()
  })
})

describe('monthly screen copy', () => {
  it('counts down to the lock, the reviews and the results', () => {
    expect(monthlyPill('planning', listBounds, listBounds.lockAt - (2 * DAY + 4 * HOUR), false, false)).toEqual({ text: 'Locks in 2d 4h', icon: 'lock', urgent: false })
    expect(monthlyPill('active', listBounds, listBounds.reviewOpenAt - 18 * DAY, false, false).text).toBe('Reviews open in 18d')
    expect(monthlyPill('review', listBounds, listBounds.deadlineAt - 5 * HOUR, false, true)).toEqual({ text: 'Reviews due in 5h', icon: 'clock', urgent: true })
    expect(monthlyPill('review', listBounds, listBounds.deadlineAt - 5 * HOUR, true, false).text).toBe('Results are in')
    expect(monthlyPill('closed', listBounds, listBounds.deadlineAt + DAY, true, false).text).toBe('Results are in')
  })

  it('words the planning footer and the no-list note', () => {
    expect(planningFooter(0, 'Monday at midnight')).toBe('Optional. Bigger things that take the month. Locks Monday at midnight.')
    expect(planningFooter(2, 'Monday at midnight')).toBe('Saves as you type. Locks Monday at midnight. After that you tick it off, but can’t add to it.')
    expect(noListNote('October', ['Kim', 'Ana'])).toBe('Kim and Ana have no October list.')
    expect(noListNote('October', ['Kim'])).toBe('Kim has no October list.')
    expect(noListNote('October', [])).toBeNull()
  })

  it('says how each judge did', () => {
    const judge = { uid: 'c', participating: true, taskCount: 0, tasks: [], provisionalScore: null, score: null, reviewedBy: [], missedReviewsOf: [], hasSubmitted: false, judge: true }
    expect(judgeDetail(judge, 'active', false)).toBe('Judge')
    expect(judgeDetail(judge, 'review', false)).toBe('Still reviewing')
    expect(judgeDetail({ ...judge, hasSubmitted: true }, 'review', false)).toBe('Reviews in')
    expect(judgeDetail({ ...judge, hasSubmitted: true }, 'closed', false)).toBe('Reviewed')
    expect(judgeDetail({ ...judge, missedReviewsOf: ['a'] }, 'closed', false)).toBe('Didn’t review')
    expect(judgeDetail(judge, 'closed', false)).toBe('Nothing to review')
    expect(judgeDetail(judge, 'closed', true)).toBe('Left · Nothing to review')
  })
})
