import { describe, expect, it } from 'vitest'
import {
  addedAfterLock,
  computeMonth,
  computeMonthly,
  computeWeek,
  isMonthPlayer,
  isRevealed,
  isTaskDone,
  joinedAfterLock,
  judgesOf,
  membersAt,
  monthEndsAt,
  reviewTargets,
  spaceJudges,
  taskSelfFraction,
  type MonthWeekEntry,
  type MonthlyEntry,
} from './scoring.ts'
import { computeMonth as oracleMonth, computeMonthly as oracleMonthly, computeWeek as oracleWeek } from './scoring-legacy-oracle.ts'
import { monthCompleteAt, monthlyBounds, weekBounds, weekIdsInMonth } from './time.ts'
import type { Mark, MonthlyData, Review, ReviewMark, Space, Task, TaskCancel, UID, WeekData, WeekId, WeekSchedule } from './types.ts'

const TZ = 'Europe/Paris'
const H = 3_600_000

function space(memberIds: UID[]): Space {
  return {
    id: 's1',
    name: 'Studio',
    reward: 'Dinner on me',
    penalty: 'Coffee for a week',
    ownerId: memberIds[0],
    memberIds,
    joinedAt: Object.fromEntries(memberIds.map((uid) => [uid, 0])),
    timezone: TZ,
    inviteCode: 'ABCD2345',
    threshold: 90,
    latePenalty: 5,
    createdAt: 0,
  }
}

const taskId = (uid: UID, i: number) => `${uid}${i + 1}`

interface WeekSetup {
  members: UID[]
  /** Task count per member. */
  tasks?: Record<UID, number>
  /** Number of each member's tasks self-checked as done (the first k). */
  done?: Record<UID, number>
  /** [reviewer, reviewee, marks by task index]; a shorter array leaves later tasks unmarked. */
  reviews?: [UID, UID, Mark[]][]
  submittedBy?: UID[]
}

function weekData(weekId: WeekId, setup: WeekSetup): WeekData {
  const tasks = setup.tasks ?? {}
  const reviews: Review[] = (setup.reviews ?? []).map(([reviewerId, revieweeId, marks]) => ({
    id: `${reviewerId}_${revieweeId}`,
    reviewerId,
    revieweeId,
    marks: Object.fromEntries(marks.map((m, i) => [taskId(revieweeId, i), m])),
    submittedAt: 0,
  }))
  return {
    spaceId: 's1',
    weekId,
    week: { id: weekId, spaceId: 's1', ...weekBounds(weekId, TZ), members: setup.members, submittedBy: setup.submittedBy ?? [] },
    plans: Object.fromEntries(
      Object.entries(tasks).map(([uid, n]) => [uid, { uid, tasks: Array.from({ length: n }, (_, i) => ({ id: taskId(uid, i), title: `Task ${i + 1}` })), updatedAt: 0 }]),
    ),
    progress: Object.fromEntries(
      Object.entries(setup.done ?? {}).map(([uid, k]) => [uid, { uid, done: Object.fromEntries(Array.from({ length: k }, (_, i) => [taskId(uid, i), true])), updatedAt: 0 }]),
    ),
    reviews,
  }
}

const W = '2026-10-12'
const b = weekBounds(W, TZ)
const duringWeek = b.lockAt + H
const duringReview = b.reviewOpenAt + H
const afterDeadline = b.deadlineAt + H

describe('isRevealed', () => {
  const week = { members: ['a', 'b'], submittedBy: ['a'], deadlineAt: b.deadlineAt }
  it('waits for every member or the deadline', () => {
    expect(isRevealed(week, b.deadlineAt - 1)).toBe(false)
    expect(isRevealed(week, b.deadlineAt)).toBe(true)
    expect(isRevealed({ ...week, submittedBy: ['b', 'a'] }, duringReview)).toBe(true)
    expect(isRevealed({ ...week, submittedBy: ['a', 'x'] }, duringReview)).toBe(false)
  })
  it('every week member counts, including someone who left after lock: only the deadline reveals then', () => {
    // c left the space on Wednesday and can't submit any more. Leaving can't reveal the week early.
    const three = { members: ['a', 'b', 'c'], submittedBy: ['a', 'b'], deadlineAt: b.deadlineAt }
    expect(isRevealed(three, duringReview)).toBe(false)
    expect(isRevealed(three, b.deadlineAt - 1)).toBe(false)
    expect(isRevealed(three, b.deadlineAt)).toBe(true)
    // A leaver who had already submitted doesn't hold it.
    expect(isRevealed({ ...three, submittedBy: ['c', 'a', 'b'] }, duringReview)).toBe(true)
  })
})

describe('reviewTargets', () => {
  const data = weekData(W, { members: ['a', 'b', 'c', 'd'], tasks: { a: 2, b: 1, c: 0, x: 3 } })
  it('lists other participants with at least one task', () => {
    expect(reviewTargets(data, 'a')).toEqual(['b'])
    expect(reviewTargets(data, 'c')).toEqual(['a', 'b'])
    expect(reviewTargets(data, 'd')).toEqual(['a', 'b'])
  })
  it('is empty for non-members and missing weeks', () => {
    expect(reviewTargets(data, 'x')).toEqual([])
    expect(reviewTargets({ ...data, week: null }, 'a')).toEqual([])
  })
  it('given the members who count, skips anyone else', () => {
    expect(reviewTargets(data, 'c', ['a', 'c', 'd'])).toEqual(['a'])
    expect(reviewTargets(data, 'd', ['c', 'd'])).toEqual([])
  })
  it('keeps someone who left after lock (membersAt the lock)', () => {
    const sp = { memberIds: ['a', 'c', 'd'], leftAt: { b: b.lockAt + 2 * H } }
    expect(reviewTargets(data, 'c', membersAt(sp, b.lockAt))).toEqual(['a', 'b'])
    // Gone before lock: not a target (the data layer normally takes them out of the week as well).
    expect(reviewTargets(data, 'c', membersAt({ ...sp, leftAt: { b: b.lockAt - H } }, b.lockAt))).toEqual(['a'])
  })
})

describe('computeWeek', () => {
  it('pair: reviews decide once both have submitted (early reveal)', () => {
    const data = weekData(W, {
      members: ['a', 'b'],
      tasks: { a: 4, b: 2 },
      done: { a: 3, b: 2 },
      reviews: [
        ['a', 'b', [1, 0.5]],
        ['b', 'a', [1, 1, 0.5, 0]],
      ],
      submittedBy: ['a', 'b'],
    })
    const r = computeWeek(data, space(['a', 'b']), duringReview)
    expect(r.phase).toBe('review')
    expect(r.revealed).toBe(true)
    expect(r.members.a).toMatchObject({ participating: true, taskCount: 4, provisionalScore: 75, score: 62.5, reviewedBy: ['b'], missedReviewsOf: [], hasSubmitted: true })
    expect(r.members.b).toMatchObject({ provisionalScore: 100, score: 75, reviewedBy: ['a'] })
    expect(r.members.a.tasks.map((t) => [t.taskId, t.mark, t.source, t.selfDone])).toEqual([
      ['a1', 1, 'reviews', true],
      ['a2', 1, 'reviews', true],
      ['a3', 0.5, 'reviews', true],
      ['a4', 0, 'reviews', false],
    ])
    expect(r.members.a.tasks[2]).toMatchObject({ title: 'Task 3', reviewerMarks: { b: 0.5 } })
  })

  it('before reveal: scores are hidden, provisional scores come from self check-offs', () => {
    // Current user a has submitted and sees only their own review.
    const data = weekData(W, {
      members: ['a', 'b'],
      tasks: { a: 2, b: 2 },
      done: { a: 1, b: 2 },
      reviews: [['a', 'b', [1, 0]]],
      submittedBy: ['a'],
    })
    const r = computeWeek(data, space(['a', 'b']), duringReview)
    expect(r.revealed).toBe(false)
    expect(r.members.a).toMatchObject({ score: null, provisionalScore: 50, hasSubmitted: true, missedReviewsOf: [] })
    expect(r.members.b).toMatchObject({ score: null, provisionalScore: 100, hasSubmitted: false, missedReviewsOf: [] })
    expect(r.members.b.reviewedBy).toEqual(['a'])
    expect(r.members.a.tasks.every((t) => t.source === 'self')).toBe(true)
  })

  it('before the review window: planning and active phases', () => {
    const data = weekData(W, { members: ['a', 'b'], tasks: { a: 2, b: 2 }, done: { a: 2 } })
    expect(computeWeek(data, space(['a', 'b']), b.startAt).phase).toBe('planning')
    const r = computeWeek(data, space(['a', 'b']), duringWeek)
    expect(r.phase).toBe('active')
    expect(r.revealed).toBe(false)
    expect(r.members.a.provisionalScore).toBe(100)
    expect(r.members.b.provisionalScore).toBe(0)
  })

  it('group of 3 with partial reviews: averages the reviewers who submitted, unmarked tasks count 0', () => {
    const data = weekData(W, {
      members: ['a', 'b', 'c'],
      tasks: { a: 2, b: 2, c: 2 },
      done: { a: 2, b: 2, c: 2 },
      reviews: [
        ['a', 'b', [1, 1]],
        ['a', 'c', [0.5, 0]],
        ['b', 'a', [1, 0.5]],
        ['b', 'c', [1]], // c2 left unmarked
      ],
      submittedBy: ['a', 'b'],
    })
    const sp = space(['a', 'b', 'c'])

    const before = computeWeek(data, sp, b.deadlineAt - 1)
    expect(before.revealed).toBe(false)
    expect(before.members.c.missedReviewsOf).toEqual([])

    const r = computeWeek(data, sp, afterDeadline)
    expect(r.phase).toBe('closed')
    expect(r.revealed).toBe(true)
    // a: only b reviewed (c missed); c's absence is not a zero.
    expect(r.members.a.score).toBe(75)
    expect(r.members.a.reviewedBy).toEqual(['b'])
    expect(r.members.b.score).toBe(100)
    // c: c1 = (0.5 + 1) / 2, c2 = (0 + 0) / 2.
    expect(r.members.c.score).toBe(37.5)
    expect(r.members.c.tasks[0]).toMatchObject({ mark: 0.75, reviewerMarks: { a: 0.5, b: 1 }, source: 'reviews' })
    expect(r.members.c.tasks[1]).toMatchObject({ mark: 0, reviewerMarks: { a: 0, b: 0 } })
    expect(r.members.a.missedReviewsOf).toEqual([])
    expect(r.members.b.missedReviewsOf).toEqual([])
    expect(r.members.c.missedReviewsOf).toEqual(['a', 'b'])
    expect(r.members.c.hasSubmitted).toBe(false)
  })

  it('reviewer missed: nobody reviewed M → self check-offs; someone did → only their marks', () => {
    const data = weekData(W, {
      members: ['a', 'b', 'c'],
      tasks: { a: 4, b: 4, c: 4 },
      done: { a: 3, b: 4, c: 1 },
      // Only b submitted, and b's batch skipped a.
      reviews: [['b', 'c', [1, 1, 1, 1]]],
      submittedBy: ['b'],
    })
    const r = computeWeek(data, space(['a', 'b', 'c']), afterDeadline)
    expect(r.members.a).toMatchObject({ score: 75, reviewedBy: [] })
    expect(r.members.a.tasks.every((t) => t.source === 'self')).toBe(true)
    expect(r.members.b).toMatchObject({ score: 100, reviewedBy: [] })
    expect(r.members.c).toMatchObject({ score: 100, provisionalScore: 25, reviewedBy: ['b'] })
    expect(r.members.a.missedReviewsOf).toEqual(['b', 'c'])
    expect(r.members.b.missedReviewsOf).toEqual(['a'])
    expect(r.members.c.missedReviewsOf).toEqual(['a', 'b'])
  })

  it('solo member: scored on self check-offs, revealed at the deadline', () => {
    const data = weekData(W, { members: ['a'], tasks: { a: 3 }, done: { a: 2 } })
    const sp = space(['a'])
    expect(reviewTargets(data, 'a')).toEqual([])
    const during = computeWeek(data, sp, duringReview)
    expect(during.revealed).toBe(false)
    expect(during.members.a.score).toBeNull()
    const after = computeWeek(data, sp, b.deadlineAt)
    expect(after.revealed).toBe(true)
    expect(after.members.a.score).toBeCloseTo(200 / 3, 10)
    expect(after.members.a.missedReviewsOf).toEqual([])
  })

  it('empty plan scores 0 and is not a review target', () => {
    const data = weekData(W, {
      members: ['a', 'b'],
      tasks: { a: 1, b: 0 },
      done: { a: 1 },
      reviews: [['b', 'a', [1]]],
      submittedBy: ['a', 'b'],
    })
    const r = computeWeek(data, space(['a', 'b']), afterDeadline)
    expect(r.members.b).toMatchObject({ participating: true, taskCount: 0, tasks: [], provisionalScore: 0, score: 0 })
    expect(r.members.a.score).toBe(100)
    expect(r.members.a.missedReviewsOf).toEqual([])

    const noPlanDoc = weekData(W, { members: ['a', 'b'], tasks: { a: 1 } })
    expect(computeWeek(noPlanDoc, space(['a', 'b']), duringWeek).members.b).toMatchObject({ provisionalScore: 0, score: null })
  })

  it('ignores non-members, self reviews, unknown task ids and invalid marks', () => {
    const data = weekData(W, {
      members: ['a', 'b', 'a'],
      tasks: { a: 2, b: 2, x: 2 },
      done: { a: 2, x: 2 },
      reviews: [
        ['b', 'a', [1, 0.5]],
        ['x', 'a', [0, 0]],
        ['a', 'a', [0, 0]],
        ['a', 'x', [1, 1]],
        ['a', 'b', [1, 1]],
      ],
      submittedBy: ['a', 'b'],
    })
    data.reviews[0].marks.zz = 1
    data.reviews[4].marks.b2 = 7 as unknown as Mark
    const r = computeWeek(data, space(['a', 'b', 'x']), afterDeadline)
    expect(Object.keys(r.members).sort()).toEqual(['a', 'b', 'x'])
    expect(r.members.x).toMatchObject({ participating: false, taskCount: 0, tasks: [], score: null, provisionalScore: null })
    expect(r.members.a).toMatchObject({ score: 75, reviewedBy: ['b'], missedReviewsOf: [] })
    expect(r.members.b.score).toBe(50)
  })

  it('a participant who leaves after lock still counts: reviewed, scored, and waited for until the deadline', () => {
    // c planned, ticked everything, then left the space on Wednesday; a and b reviewed each other only.
    const data = weekData(W, {
      members: ['a', 'b', 'c'],
      tasks: { a: 1, b: 1, c: 2 },
      done: { c: 2 },
      reviews: [
        ['a', 'b', [1]],
        ['b', 'a', [1]],
      ],
      submittedBy: ['a', 'b'],
    })
    const sp = { ...space(['a', 'b']), leftAt: { c: b.lockAt + 24 * H } }
    expect(reviewTargets(data, 'a', membersAt(sp, b.lockAt))).toEqual(['b', 'c'])
    // c can't submit any more, so only the deadline reveals the week.
    expect(computeWeek(data, sp, duringReview).revealed).toBe(false)
    const r = computeWeek(data, sp, afterDeadline)
    expect(r.revealed).toBe(true)
    expect(r.members.a.missedReviewsOf).toEqual(['c'])
    expect(r.members.b.missedReviewsOf).toEqual(['c'])
    // Nobody reviewed c: c's own check-offs count, as for anyone; and c is charged for the reviews
    // c no longer can write.
    expect(r.members.c).toMatchObject({ participating: true, score: 100, reviewedBy: [], missedReviewsOf: ['a', 'b'] })

    // Reviewed as usual, c's score comes from the reviews.
    const reviewed = { ...data, reviews: [...data.reviews, ...weekData(W, { members: [], reviews: [['a', 'c', [0, 0]], ['b', 'c', [1, 0]]] }).reviews] }
    const r2 = computeWeek(reviewed, sp, afterDeadline)
    expect(r2.members.c).toMatchObject({ score: 25, reviewedBy: ['a', 'b'] })
    expect(r2.members.a.missedReviewsOf).toEqual([])
  })

  it('a participant still listed who left before lock is nobody\'s target (the reveal still waits for them, as in the rules)', () => {
    // Normally leaving before lock takes them out of the week; this is a week where that didn't happen.
    const data = weekData(W, { members: ['a', 'b', 'c'], tasks: { a: 1, b: 1, c: 1 }, reviews: [['a', 'b', [1]], ['b', 'a', [1]]], submittedBy: ['a', 'b'] })
    const sp = { ...space(['a', 'b']), leftAt: { c: b.lockAt - H } }
    expect(computeWeek(data, sp, duringReview).revealed).toBe(false)
    const r = computeWeek(data, sp, afterDeadline)
    expect(r.members.a.missedReviewsOf).toEqual([])
    expect(r.members.b.missedReviewsOf).toEqual([])
  })

  it('leaving at any time after lock never rewrites the week', () => {
    const data = weekData(W, { members: ['a', 'b', 'c'], tasks: { a: 1, b: 1, c: 1 }, reviews: [['a', 'b', [1]], ['b', 'a', [1]]], submittedBy: ['a', 'b'] })
    const leftAt = (at: number) => ({ ...space(['a', 'b']), leftAt: { c: at } })
    for (const at of [b.lockAt, b.reviewOpenAt + H, b.deadlineAt - 2 * H, b.deadlineAt + 2 * H]) {
      expect(computeWeek(data, leftAt(at), afterDeadline + 3 * H).members.a.missedReviewsOf).toEqual(['c'])
    }
    expect(computeWeek(data, leftAt(b.lockAt - 1), afterDeadline).members.a.missedReviewsOf).toEqual([])
    // Leaving during the review window doesn't reveal the week early either.
    expect(computeWeek(data, leftAt(b.reviewOpenAt + H), duringReview).revealed).toBe(false)
  })

  it('rejoining never rewrites a week that has locked', () => {
    // c submitted on Friday, left, then came back; a and b never reviewed c.
    const data = weekData(W, {
      members: ['a', 'b', 'c'], tasks: { a: 1, b: 1, c: 1 }, done: { c: 1 },
      reviews: [['a', 'b', [1]], ['b', 'a', [1]], ['c', 'a', [0]], ['c', 'b', [0]]], submittedBy: ['a', 'b', 'c'],
    })
    const rejoined = (leftAt: number, joinedAt: number) => ({ ...space(['a', 'b', 'c']), joinedAt: { a: 0, b: 0, c: joinedAt }, leftAt: { c: leftAt } })
    // Left after lock: c counted all along (a and b owed c a review), before and after coming back.
    for (const sp of [rejoined(b.reviewOpenAt + H, b.deadlineAt - H), rejoined(b.deadlineAt - 2 * H, b.deadlineAt + 2 * H), rejoined(b.deadlineAt + H, b.deadlineAt + 2 * H)]) {
      const r = computeWeek(data, sp, afterDeadline + 2 * H)
      expect(r.members.a.missedReviewsOf).toEqual(['c'])
      expect(r.members.b.missedReviewsOf).toEqual(['c'])
    }
    // Left before lock and back only after it: c wasn't in the space when the week locked, so coming
    // back doesn't make c a target (here c is still listed in the week, which normally can't happen).
    const r = computeWeek(data, rejoined(b.lockAt - H, b.lockAt + H), afterDeadline)
    expect(r.members.a.missedReviewsOf).toEqual([])
    expect(r.members.b.missedReviewsOf).toEqual([])
  })

  it('submitting harsh marks, ticking everything and leaving does not score the leaver on their own check-offs', () => {
    // c rates a and b 0 early on Friday, ticks both tasks done, then leaves. a and b still review c.
    const data = weekData(W, {
      members: ['a', 'b', 'c'], tasks: { a: 1, b: 1, c: 2 }, done: { c: 2 },
      reviews: [['c', 'a', [0]], ['c', 'b', [0]], ['a', 'b', [1]], ['a', 'c', [0, 0]], ['b', 'a', [1]], ['b', 'c', [0.5, 0]]],
      submittedBy: ['c', 'a', 'b'],
    })
    const sp = { ...space(['a', 'b']), leftAt: { c: b.reviewOpenAt + H } }
    expect(reviewTargets(data, 'a', membersAt(sp, b.lockAt))).toEqual(['b', 'c'])
    // Everyone in the week submitted (c before leaving): revealed early, scored from reviews.
    const r = computeWeek(data, sp, duringReview + H)
    expect(r.revealed).toBe(true)
    expect(r.members.c).toMatchObject({ score: 12.5, provisionalScore: 100, reviewedBy: ['a', 'b'] })
    expect(r.members.c.tasks.every((t) => t.source === 'reviews')).toBe(true)
  })

  it('a week nobody opened has no participants', () => {
    const r = computeWeek({ spaceId: 's1', weekId: W, week: null, plans: {}, progress: {}, reviews: [] }, space(['a', 'b']), duringReview)
    expect(r.phase).toBe('review')
    expect(r.revealed).toBe(false)
    expect(r.members.a.participating).toBe(false)
    expect(r.members.b.participating).toBe(false)
  })

  it('keeps raw scores', () => {
    const data = weekData(W, {
      members: ['a', 'b', 'c', 'd'],
      tasks: { a: 3, b: 1, c: 1, d: 1 },
      reviews: [
        ['b', 'a', [1, 1, 0.5]],
        ['c', 'a', [1, 0, 0]],
        ['d', 'a', [0.5, 0, 0]],
      ],
    })
    const r = computeWeek(data, space(['a', 'b', 'c', 'd']), afterDeadline)
    expect(r.members.a.score).toBeCloseTo((100 * 4) / 9, 12)
    expect(r.members.a.tasks.map((t) => t.mark)).toEqual([2.5 / 3, 1 / 3, 0.5 / 3])
  })
})

describe('computeMonth', () => {
  const M = '2026-10'
  // October 2026: 09-28, 10-05, 10-12, 10-19, 10-26.
  const pairWeeks = (): WeekData[] => [
    weekData('2026-09-28', {
      members: ['a', 'b'],
      tasks: { a: 4, b: 4 },
      reviews: [
        ['a', 'b', [1, 1, 1, 0.5]],
        ['b', 'a', [1, 1, 1, 1]],
      ],
      submittedBy: ['a', 'b'],
    }),
    weekData('2026-10-05', {
      members: ['a', 'b'],
      tasks: { a: 4, b: 4 },
      reviews: [
        ['a', 'b', [1, 1, 1, 1]],
        ['b', 'a', [1, 1, 1, 0.5]],
      ],
      submittedBy: ['a', 'b'],
    }),
    // a missed the review of b: b falls back to self check-offs (2 of 4), a loses 5 points.
    weekData('2026-10-12', { members: ['a', 'b'], tasks: { a: 4, b: 4 }, done: { b: 2 }, reviews: [['b', 'a', [1, 1, 1, 1]]], submittedBy: ['b'] }),
    // 2026-10-19: nobody opened the week.
    { spaceId: 's1', weekId: '2026-10-19', week: null, plans: {}, progress: {}, reviews: [] },
    weekData('2026-10-26', {
      members: ['a', 'b'],
      tasks: { a: 4, b: 4 },
      reviews: [
        ['a', 'b', [1, 1, 0.5, 0.5]],
        ['b', 'a', [1, 1, 1, 1]],
      ],
      submittedBy: ['a', 'b'],
    }),
  ]
  const complete = monthCompleteAt(M, TZ)

  it('complete month with a late penalty', () => {
    const res = computeMonth(space(['a', 'b']), M, pairWeeks(), complete)
    expect(res.a.weeks).toEqual([
      { weekId: '2026-09-28', score: 100, closed: true },
      { weekId: '2026-10-05', score: 87.5, closed: true },
      { weekId: '2026-10-12', score: 100, closed: true },
      { weekId: '2026-10-26', score: 100, closed: true },
    ])
    expect(res.a).toMatchObject({ uid: 'a', monthId: M, average: 96.875, missedReviews: 1, penaltyPoints: 5, finalScore: 91.875, complete: true, passed: true })
    expect(res.b).toMatchObject({ average: 78.125, missedReviews: 0, penaltyPoints: 0, finalScore: 78.125, complete: true, passed: false })
  })

  it('the month completes exactly at the last deadline', () => {
    const res = computeMonth(space(['a', 'b']), M, pairWeeks(), complete - 1)
    expect(res.a.complete).toBe(false)
    expect(res.a.passed).toBeNull()
    // The last week is still open, so it does not count yet.
    // Month scores are rounded to 1e-9.
    expect(res.a.average).toBeCloseTo((100 + 87.5 + 100) / 3, 8)
    expect(res.a.weeks[3]).toEqual({ weekId: '2026-10-26', score: 100, closed: false })
  })

  it('incomplete month: only closed weeks count, open weeks are listed', () => {
    const now = weekBounds('2026-10-12', TZ).reviewOpenAt + H
    const res = computeMonth(space(['a', 'b']), M, pairWeeks().slice(0, 3), now)
    expect(res.a.weeks).toEqual([
      { weekId: '2026-09-28', score: 100, closed: true },
      { weekId: '2026-10-05', score: 87.5, closed: true },
      { weekId: '2026-10-12', score: null, closed: false },
    ])
    expect(res.a).toMatchObject({ average: 93.75, missedReviews: 0, penaltyPoints: 0, finalScore: 93.75, complete: false, passed: null })
  })

  it('an early-revealed open week shows its score but does not count yet', () => {
    const weeks = [
      weekData('2026-10-05', { members: ['a', 'b'], tasks: { a: 1, b: 1 }, reviews: [['b', 'a', [1]], ['a', 'b', [1]]], submittedBy: ['a', 'b'] }),
      weekData('2026-10-12', { members: ['a', 'b'], tasks: { a: 2, b: 1 }, reviews: [['b', 'a', [1, 0]], ['a', 'b', [1]]], submittedBy: ['a', 'b'] }),
    ]
    const res = computeMonth(space(['a', 'b']), M, weeks, duringReview)
    expect(res.a.weeks[1]).toEqual({ weekId: '2026-10-12', score: 50, closed: false })
    expect(res.a.average).toBe(100)
  })

  it('penalties clamp the final score at 0', () => {
    const sp = space(['a', 'b', 'c'])
    const weeks = [
      // c scores 12.5 and misses both reviews.
      weekData('2026-10-05', {
        members: ['a', 'b', 'c'],
        tasks: { a: 1, b: 1, c: 4 },
        reviews: [
          ['a', 'c', [0, 0, 0.5, 0]],
          ['b', 'c', [0, 0, 0.5, 0]],
          ['a', 'b', [1]],
          ['b', 'a', [1]],
        ],
        submittedBy: ['a', 'b'],
      }),
      // c commits to nothing (0%) and misses a again.
      weekData('2026-10-12', { members: ['a', 'b', 'c'], tasks: { a: 1, b: 0 }, done: { a: 1 } }),
    ]
    const res = computeMonth(sp, M, weeks, complete)
    expect(res.c).toMatchObject({ average: 6.25, missedReviews: 3, penaltyPoints: 15, finalScore: 0, passed: false })
    expect(res.b).toMatchObject({ missedReviews: 1, average: 50, finalScore: 45 })
  })

  it('a member who joined mid-month only counts the weeks they took part in', () => {
    const sp = space(['a', 'b', 'c'])
    const early = (weekId: WeekId) =>
      weekData(weekId, {
        members: ['a', 'b'],
        tasks: { a: 2, b: 2, c: 2 },
        done: { c: 2 },
        reviews: [
          ['a', 'b', [1, 1]],
          ['b', 'a', [1, 1]],
        ],
        submittedBy: ['a', 'b'],
      })
    const late = (weekId: WeekId) =>
      weekData(weekId, {
        members: ['a', 'b', 'c'],
        tasks: { a: 2, b: 2, c: 2 },
        reviews: [
          ['a', 'b', [1, 1]],
          ['a', 'c', [1, 0]],
          ['b', 'a', [1, 1]],
          ['b', 'c', [1, 0.5]],
          ['c', 'a', [1, 1]],
          ['c', 'b', [1, 1]],
        ],
        submittedBy: ['a', 'b', 'c'],
      })
    const weeks = [early('2026-09-28'), early('2026-10-05'), early('2026-10-12'), late('2026-10-19'), late('2026-10-26')]
    const res = computeMonth(sp, M, weeks, complete)
    expect(res.c.weeks.map((w) => w.weekId)).toEqual(['2026-10-19', '2026-10-26'])
    expect(res.c).toMatchObject({ average: 62.5, missedReviews: 0, finalScore: 62.5, passed: false })
    expect(res.a).toMatchObject({ average: 100, missedReviews: 0, passed: true })
    expect(res.a.weeks).toHaveLength(5)
  })

  it('members without a closed participating week have no score', () => {
    const res = computeMonth(space(['a', 'b', 'd']), M, pairWeeks(), complete)
    expect(res.d).toEqual({
      uid: 'd',
      monthId: M,
      former: false,
      others: ['a', 'b'],
      weeks: [],
      average: null,
      missedReviews: 0,
      penaltyPoints: 0,
      finalScore: null,
      complete: true,
      passed: null,
      judged: [],
      monthly: null,
      monthlyJudge: false,
      skippedAsJudge: 0,
    })
  })

  it('reports current members plus everyone who played the month, and ignores weeks from other months', () => {
    const weeks = [
      weekData('2026-11-02', { members: ['a', 'b'], tasks: { a: 1, b: 1 } }),
      weekData('2026-10-05', { members: ['a', 'z'], tasks: { a: 2, z: 1 }, done: { a: 1, z: 1 }, reviews: [['z', 'a', [1, 1]]], submittedBy: ['z'] }),
    ]
    // z left during that week, after it locked: z still counts in it.
    const res = computeMonth({ ...space(['a', 'n']), leftAt: { z: weekBounds('2026-10-05', TZ).lockAt + 2 * 24 * H } }, M, weeks, complete)
    expect(Object.keys(res).sort()).toEqual(['a', 'n', 'z'])
    expect(res.a.weeks).toEqual([{ weekId: '2026-10-05', score: 100, closed: true }])
    // a still owed z a review.
    expect(res.a).toMatchObject({ former: false, others: ['z'], missedReviews: 1, finalScore: 95, passed: true })
    expect(res.z).toMatchObject({ former: true, others: ['a'], weeks: [{ weekId: '2026-10-05', score: 100, closed: true }], finalScore: 100 })
    // n is a member who played no week of October: listed, but nobody owes n or is owed by n.
    expect(res.n).toMatchObject({ former: false, others: ['a', 'z'], weeks: [], finalScore: null, passed: null })
  })

  it('slacking in the last week and leaving on Thursday doesn\'t erase that week', () => {
    // b scored 100% for three weeks, planned 2 tasks for Oct 19 and did neither, then left on
    // Thursday Oct 22 (after the lock) without submitting. The month is 75% for b, not 100%.
    const good = (weekId: WeekId) =>
      weekData(weekId, { members: ['a', 'b'], tasks: { a: 1, b: 1 }, reviews: [['a', 'b', [1]], ['b', 'a', [1]]], submittedBy: ['a', 'b'] })
    const weeks = [
      good('2026-09-28'),
      good('2026-10-05'),
      good('2026-10-12'),
      weekData('2026-10-19', { members: ['a', 'b'], tasks: { a: 1, b: 2 }, done: { a: 1 }, reviews: [['a', 'b', [0, 0]]], submittedBy: ['a'] }),
      // Next week hadn't locked when b left, so b isn't in it.
      weekData('2026-10-26', { members: ['a'], tasks: { a: 1 }, done: { a: 1 } }),
    ]
    const left = weekBounds('2026-10-19', TZ).lockAt + 2 * 24 * H
    const res = computeMonth({ ...space(['a']), leftAt: { b: left } }, M, weeks, complete)
    expect(res.b.weeks.map((w) => [w.weekId, w.score])).toEqual([['2026-09-28', 100], ['2026-10-05', 100], ['2026-10-12', 100], ['2026-10-19', 0]])
    // −5 for the review of a that b never wrote.
    expect(res.b).toMatchObject({ former: true, others: ['a'], average: 75, missedReviews: 1, finalScore: 70, passed: false })
    expect(res.a).toMatchObject({ others: ['b'], average: 100, missedReviews: 0, passed: true })
  })

  it('being removed in the review window keeps a strong week: still reviewed and scored', () => {
    // The owner a removes c on Friday, hoping to erase c's 100% week. b and a still review c.
    const weeks = [
      weekData('2026-10-05', { members: ['a', 'b', 'c'], tasks: { a: 1, b: 1, c: 1 }, done: { c: 1 }, reviews: [['a', 'c', [1]], ['b', 'c', [1]], ['c', 'a', [1]], ['c', 'b', [1]]], submittedBy: ['c'] }),
      weekData('2026-10-12', {
        members: ['a', 'b', 'c'], tasks: { a: 1, b: 1, c: 2 }, done: { c: 2 },
        reviews: [['a', 'b', [1]], ['a', 'c', [1, 1]], ['b', 'a', [1]], ['b', 'c', [1, 1]]], submittedBy: ['a', 'b'],
      }),
    ]
    const removed = weekBounds('2026-10-12', TZ).reviewOpenAt + H
    const sp = { ...space(['a', 'b']), leftAt: { c: removed } }
    expect(computeWeek(weeks[1], sp, removed + H).revealed).toBe(false)
    const res = computeMonth(sp, M, weeks, complete)
    expect(res.c).toMatchObject({ former: true, average: 100, weeks: [{ weekId: '2026-10-05', score: 100, closed: true }, { weekId: '2026-10-12', score: 100, closed: true }] })
    // c can't submit after being removed, so c misses a and b in that week.
    expect(res.c.missedReviews).toBe(2)
    expect(res.a.others).toEqual(['b', 'c'])
  })

  it('a member who left after a month keeps their verdict and stays in the others list', () => {
    // b failed October and left on Nov 1; c joined in November.
    const weeks = pairWeeks()
    const res = computeMonth(space(['a', 'c']), M, weeks, complete)
    expect(res.b).toMatchObject({ former: true, others: ['a'], passed: false })
    expect(res.a.others).toEqual(['b'])
    expect(res.c).toMatchObject({ former: false, others: ['a', 'b'], weeks: [] })
  })

  it('leaving after the month keeps everyone\'s missed-review points for it', () => {
    // a missed the review of b on Oct 12 (−5). b leaving on Nov 1 must not erase that.
    const nov1 = monthCompleteAt(M, TZ) + 24 * H
    const res = computeMonth({ ...space(['a']), leftAt: { b: nov1 } }, M, pairWeeks(), complete)
    expect(res.a).toMatchObject({ missedReviews: 1, finalScore: 91.875, passed: true })
    expect(res.b).toMatchObject({ former: true, finalScore: 78.125, passed: false })
  })

  it('normalises float error so a 90% average is exactly 90', () => {
    // Weekly scores 100, 5/6, 14/15, 5/6 average to 90, which floats compute as 89.99999999999999.
    const one = (weekId: WeekId, n: number, done: number) => weekData(weekId, { members: ['a'], tasks: { a: n }, done: { a: done } })
    const weeks = [one('2026-09-28', 1, 1), one('2026-10-05', 6, 5), one('2026-10-12', 15, 14), one('2026-10-19', 6, 5)]
    expect((100 + 500 / 6 + 1400 / 15 + 500 / 6) / 4).not.toBe(90)
    const res = computeMonth(space(['a']), M, weeks, complete)
    expect(res.a.average).toBe(90)
    expect(res.a.finalScore).toBe(90)
    expect(res.a.passed).toBe(true)
  })

  it('passes at exactly the threshold and sorts weeks', () => {
    const weeks = [
      weekData('2026-10-12', { members: ['a'], tasks: { a: 5 }, done: { a: 4 } }),
      weekData('2026-10-05', { members: ['a'], tasks: { a: 1 }, done: { a: 1 } }),
    ]
    const res = computeMonth(space(['a']), M, weeks, complete)
    expect(res.a.weeks.map((w) => w.weekId)).toEqual(['2026-10-05', '2026-10-12'])
    expect(res.a).toMatchObject({ average: 90, finalScore: 90, passed: true })
  })
})

describe('membersAt and joinedAfterLock', () => {
  it('counts current members plus anyone who left at or after the lock', () => {
    const sp = { memberIds: ['a', 'b'], leftAt: { c: 100, d: 50, b: 10 } }
    expect(membersAt(sp, 100)).toEqual(['a', 'b', 'c'])
    expect(membersAt(sp, 101)).toEqual(['a', 'b'])
    expect(membersAt({ memberIds: ['a'] }, 0)).toEqual(['a'])
  })

  it('leaves out only a current member who left before the lock and came back after it', () => {
    // b left at 50 and rejoined at 200.
    const sp = { memberIds: ['a', 'b'], joinedAt: { a: 0, b: 200 }, leftAt: { b: 50 } }
    expect(membersAt(sp, 100)).toEqual(['a'])
    expect(membersAt(sp, 300)).toEqual(['a', 'b'])
    // Left after the lock (150) and back at 200: in the space when it locked, so b counts.
    expect(membersAt({ ...sp, leftAt: { b: 150 } }, 100)).toEqual(['a', 'b'])
    // Never left: counts whatever joinedAt says (being in the week means being in when it locked).
    expect(membersAt({ memberIds: ['a', 'b'], joinedAt: { a: 0, b: 200 } }, 100)).toEqual(['a', 'b'])
  })

  it('tells a late joiner from a member without tasks', () => {
    const sp = { joinedAt: { early: b.lockAt - 1, late: b.lockAt } }
    expect(joinedAfterLock(sp, 'early', b.lockAt)).toBe(false)
    expect(joinedAfterLock(sp, 'late', b.lockAt)).toBe(true)
    expect(joinedAfterLock(sp, 'gone', b.lockAt)).toBe(false)
  })
})

describe('tasks with steps', () => {
  /** A task with `n` steps, ids `${id}s1`… */
  const stepped = (id: string, n: number, extra: Partial<Task> = {}): Task => ({
    id,
    title: id,
    subtasks: Array.from({ length: n }, (_, i) => ({ id: `${id}s${i + 1}`, title: `Step ${i + 1}` })),
    ...extra,
  })
  const plain = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: id, ...extra })
  /** Ticks the given keys (task or step ids). */
  const ticks = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, true]))

  function weekWith(plans: Record<UID, Task[]>, done: Record<UID, Record<string, boolean>>, extra: Partial<WeekSetup> = {}): WeekData {
    const members = extra.members ?? Object.keys(plans)
    const data = weekData(W, { ...extra, members })
    return {
      ...data,
      plans: Object.fromEntries(Object.entries(plans).map(([uid, tasks]) => [uid, { uid, tasks, updatedAt: 0 }])),
      progress: Object.fromEntries(Object.entries(done).map(([uid, d]) => [uid, { uid, done: d, updatedAt: 0 }])),
    }
  }

  it('taskSelfFraction: the share of steps ticked; without steps, the task\'s own check-off', () => {
    expect(taskSelfFraction(plain('t'), ticks('t'))).toBe(1)
    expect(taskSelfFraction(plain('t'), {})).toBe(0)
    expect(taskSelfFraction(plain('t'), { t: false })).toBe(0)
    expect(taskSelfFraction(stepped('t', 4), ticks('ts1', 'ts3'))).toBe(0.5)
    expect(taskSelfFraction(stepped('t', 3), ticks('ts2'))).toBe(1 / 3)
    expect(taskSelfFraction(stepped('t', 2), ticks('ts1', 'ts2'))).toBe(1)
    // An empty list of steps is a task without steps.
    expect(taskSelfFraction({ ...plain('t'), subtasks: [] }, ticks('t'))).toBe(1)
  })

  it('a task with steps ignores its own check-off', () => {
    expect(taskSelfFraction(stepped('t', 3), ticks('t'))).toBe(0)
    expect(taskSelfFraction(stepped('t', 2), ticks('t', 'ts1'))).toBe(0.5)
    expect(isTaskDone(stepped('t', 2), ticks('t', 'ts1'))).toBe(false)
    expect(isTaskDone(stepped('t', 2), ticks('ts1', 'ts2'))).toBe(true)
    expect(isTaskDone(plain('t'), ticks('t'))).toBe(true)
    expect(isTaskDone(plain('t'), ticks('ts1'))).toBe(false)
  })

  it('provisional score counts the share of steps ticked', () => {
    const data = weekWith({ a: [stepped('a1', 4), plain('a2'), stepped('a3', 2)] }, { a: ticks('a1s1', 'a1s4', 'a2', 'a3', 'a3s2') })
    const r = computeWeek(data, space(['a']), duringWeek)
    // 0.5 + 1 + 0.5 of 3.
    expect(r.members.a.provisionalScore).toBeCloseTo(200 / 3, 12)
    expect(r.members.a.tasks.map((t) => [t.taskId, t.selfFraction, t.selfDone, t.mark, t.source])).toEqual([
      ['a1', 0.5, false, 0.5, 'self'],
      ['a2', 1, true, 1, 'self'],
      ['a3', 0.5, false, 0.5, 'self'],
    ])
    expect(r.members.a.tasks[0].subtasks).toEqual([
      { id: 'a1s1', title: 'Step 1', done: true },
      { id: 'a1s2', title: 'Step 2', done: false },
      { id: 'a1s3', title: 'Step 3', done: false },
      { id: 'a1s4', title: 'Step 4', done: true },
    ])
    expect(r.members.a.tasks[1].subtasks).toEqual([])
  })

  it('every step ticked makes the task done', () => {
    const data = weekWith({ a: [stepped('a1', 3)] }, { a: ticks('a1s1', 'a1s2', 'a1s3') })
    const task = computeWeek(data, space(['a']), duringWeek).members.a.tasks[0]
    expect(task).toMatchObject({ selfDone: true, selfFraction: 1, mark: 1 })
    expect(task.subtasks.every((s) => s.done)).toBe(true)
  })

  it('nobody reviewed: the fallback score uses the step fractions', () => {
    const data = weekWith(
      { a: [stepped('a1', 4), plain('a2')], b: [plain('b1')] },
      { a: ticks('a1s1', 'a1s2', 'a1s3', 'a2') },
      { reviews: [['a', 'b', [1]]], submittedBy: ['a'] },
    )
    const r = computeWeek(data, space(['a', 'b']), afterDeadline)
    // b missed a's review: a falls back to 0.75 + 1 of 2.
    expect(r.members.a).toMatchObject({ score: 87.5, provisionalScore: 87.5, reviewedBy: [] })
    expect(r.members.a.tasks.map((t) => [t.mark, t.source])).toEqual([
      [0.75, 'self'],
      [1, 'self'],
    ])
    expect(r.members.b.missedReviewsOf).toEqual(['a'])
  })

  it('reviews mark the task, not its steps: steps change only the provisional score', () => {
    const data = weekWith(
      { a: [stepped('a1', 4), plain('a2')], b: [plain('b1')] },
      { a: ticks('a1s1', 'a2') },
      { reviews: [['b', 'a', [1, 0.5]], ['a', 'b', [1]]], submittedBy: ['a', 'b'] },
    )
    const r = computeWeek(data, space(['a', 'b']), duringReview)
    expect(r.revealed).toBe(true)
    expect(r.members.a).toMatchObject({ score: 75, provisionalScore: 62.5 })
    expect(r.members.a.tasks[0]).toMatchObject({ mark: 1, source: 'reviews', reviewerMarks: { b: 1 }, selfFraction: 0.25, selfDone: false })

    // Marks keyed by step ids are not marks for the task.
    const unmarked = weekWith({ a: [stepped('a1', 2)], b: [plain('b1')] }, { a: ticks('a1s1', 'a1s2') }, { submittedBy: ['a', 'b'] })
    unmarked.reviews.push({ id: 'b_a', reviewerId: 'b', revieweeId: 'a', marks: { a1s1: 1, a1s2: 1 }, submittedAt: 0 })
    expect(computeWeek(unmarked, space(['a', 'b']), afterDeadline).members.a).toMatchObject({ score: 0, provisionalScore: 100 })
  })

  it('step fractions add up exactly, so 90% is exactly 90', () => {
    // 1 + 1 + 0.8 + 0.8 of 4 = 90%, which a plain float sum puts at 89.99999999999999.
    expect(1 + 1 + 0.8 + 0.8).not.toBe(3.6)
    const data = weekWith(
      { a: [plain('a1'), stepped('a2', 1), stepped('a3', 5), stepped('a4', 5)] },
      { a: ticks('a1', 'a2s1', 'a3s1', 'a3s2', 'a3s3', 'a3s4', 'a4s2', 'a4s3', 'a4s4', 'a4s5') },
    )
    const r = computeWeek(data, space(['a']), afterDeadline)
    expect(r.members.a.score).toBe(90)
    expect(r.members.a.provisionalScore).toBe(90)
    const thirds = weekWith({ a: [stepped('a1', 3), stepped('a2', 3), stepped('a3', 3)] }, { a: ticks('a1s1', 'a2s1', 'a2s2', 'a3s1', 'a3s2', 'a3s3') })
    expect(computeWeek(thirds, space(['a']), afterDeadline).members.a.score).toBe(200 / 3)
  })

  it('a month of weeks with steps passes at exactly 90', () => {
    const week = (weekId: WeekId) => ({
      ...weekWith({ a: [stepped('a1', 5), plain('a2')] }, { a: ticks('a1s1', 'a1s2', 'a1s3', 'a1s4', 'a2') }),
      weekId,
      week: { id: weekId, spaceId: 's1', ...weekBounds(weekId, TZ), members: ['a'], submittedBy: [] },
    })
    const M = '2026-10'
    const res = computeMonth(space(['a']), M, ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'].map(week), monthCompleteAt(M, TZ))
    expect(res.a).toMatchObject({ average: 90, finalScore: 90, passed: true })
  })
})

describe('tasks added after the lock', () => {
  const added = (id: string, addedAt?: number): Task => (addedAt === undefined ? { id, title: id } : { id, title: id, addedAt })

  it('addedAfterLock: only a task appended at or after the lock', () => {
    expect(addedAfterLock({}, b.lockAt)).toBe(false)
    expect(addedAfterLock({ addedAt: b.lockAt - 1 }, b.lockAt)).toBe(false)
    expect(addedAfterLock({ addedAt: b.lockAt }, b.lockAt)).toBe(true)
    expect(addedAfterLock({ addedAt: b.reviewOpenAt - 1 }, b.lockAt)).toBe(true)
    expect(addedAfterLock(added('t', 0), b.lockAt)).toBe(false)
  })

  it('score like any other task and carry addedAt into the result', () => {
    const data = weekData(W, { members: ['a', 'b'], tasks: { b: 1 }, reviews: [['a', 'b', [1]]], submittedBy: ['a', 'b'] })
    data.plans.a = { uid: 'a', tasks: [added('a1'), added('a2', b.lockAt + 30 * H)], updatedAt: 0 }
    data.progress.a = { uid: 'a', done: { a2: true }, updatedAt: 0 }
    data.reviews.push({ id: 'b_a', reviewerId: 'b', revieweeId: 'a', marks: { a1: 0, a2: 1 }, submittedAt: 0 })
    const r = computeWeek(data, space(['a', 'b']), afterDeadline)
    expect(r.members.a).toMatchObject({ taskCount: 2, provisionalScore: 50, score: 50 })
    expect(r.members.a.tasks[1]).toMatchObject({ taskId: 'a2', mark: 1, addedAt: b.lockAt + 30 * H })
    expect('addedAt' in r.members.a.tasks[0]).toBe(false)
  })

  it('a member with no tasks at the lock who adds one becomes a review target', () => {
    const data = weekData(W, { members: ['a', 'b'], tasks: { a: 1 }, done: {}, reviews: [['b', 'a', [1]]], submittedBy: ['b'] })
    expect(reviewTargets(data, 'a')).toEqual([])
    data.plans.b = { uid: 'b', tasks: [added('b1', b.lockAt + H)], updatedAt: 0 }
    data.progress.b = { uid: 'b', done: { b1: true }, updatedAt: 0 }
    expect(reviewTargets(data, 'a')).toEqual(['b'])
    const r = computeWeek(data, space(['a', 'b']), afterDeadline)
    // a never reviewed b: a misses the review and b falls back to the self check-off.
    expect(r.members.a.missedReviewsOf).toEqual(['b'])
    expect(r.members.b).toMatchObject({ score: 100, taskCount: 1 })
  })
})

// ---------- Batch 2 (SPEC §9.3–§9.6): judges, paused weeks, monthly lists ----------

function judged(data: WeekData, judges: UID[]): WeekData {
  return { ...data, week: data.week && { ...data.week, judges } }
}

/** Everyone in `members` with tasks reviews everyone else with tasks: Done on every task. */
function allDone(members: UID[], tasks: Record<UID, number>): [UID, UID, Mark[]][] {
  return members.flatMap((r) => members.filter((m) => m !== r && (tasks[m] ?? 0) > 0).map((m): [UID, UID, Mark[]] => [r, m, Array<Mark>(tasks[m]).fill(1)]))
}

function monthlyData(monthId: string, setup: WeekSetup & { judges?: UID[] }): MonthlyData {
  const d = weekData('2026-10-12', setup)
  const bounds = monthlyBounds(monthId, (w) => weekBounds(w, TZ))
  return {
    spaceId: 's1',
    monthId,
    monthly: { id: monthId, spaceId: 's1', ...bounds, members: setup.members, submittedBy: setup.submittedBy ?? [], judges: setup.judges ?? [] },
    plans: d.plans,
    progress: d.progress,
    reviews: d.reviews,
  }
}

describe('judges (§9.4, §9.6)', () => {
  // j judges; their plan is left from before they switched.
  const setup = {
    members: ['a', 'b', 'j'],
    tasks: { a: 2, b: 1, j: 3 },
    reviews: [
      ['j', 'a', [1, 1]],
      ['j', 'b', [1]],
      ['a', 'b', [0]],
      ['b', 'a', [1, 0]],
      ['a', 'j', [1, 1, 1]],
    ] as [UID, UID, Mark[]][],
    submittedBy: ['a', 'b', 'j'],
  }

  it('judgesOf: the snapshot within the members; spaceJudges: the space’s within its members', () => {
    expect(judgesOf({ members: ['a', 'j'], judges: ['j', 'x', 'j'] })).toEqual(['j'])
    expect(judgesOf({ members: ['a', 'j'] })).toEqual([])
    expect(spaceJudges({ memberIds: ['a', 'j'], judges: ['gone', 'j'] })).toEqual(['j'])
    expect(spaceJudges({ memberIds: ['a'] })).toEqual([])
  })

  it('a judge has no list and no score; reviews of a judge are dropped, reviews by a judge count', () => {
    const r = computeWeek(judged(weekData(W, setup), ['j']), space(['a', 'b', 'j']), afterDeadline)
    expect(r.judges).toEqual(['j'])
    expect(r.paused).toBe(false)
    expect(r.members.j).toEqual({
      uid: 'j',
      participating: true,
      judge: true,
      taskCount: 0,
      tasks: [],
      provisionalScore: null,
      score: null,
      reviewedBy: [],
      missedReviewsOf: [],
      hasSubmitted: true,
    })
    expect(r.members.a).toMatchObject({ judge: false, score: 75, reviewedBy: ['j', 'b'], missedReviewsOf: [] })
    expect(r.members.b).toMatchObject({ judge: false, score: 50, reviewedBy: ['j', 'a'] })
  })

  it('a judge is nobody’s review target, reviews everyone with tasks, and a skip only lists them', () => {
    const data = judged(weekData(W, { ...setup, reviews: setup.reviews.filter(([r]) => r !== 'j'), submittedBy: ['a', 'b'] }), ['j'])
    expect(reviewTargets(data, 'a')).toEqual(['b'])
    expect(reviewTargets(data, 'j')).toEqual(['a', 'b'])
    expect(computeWeek(data, space(['a', 'b', 'j']), duringReview).members.j.missedReviewsOf).toEqual([])
    const r = computeWeek(data, space(['a', 'b', 'j']), afterDeadline)
    expect(r.members.j).toMatchObject({ judge: true, missedReviewsOf: ['a', 'b'], hasSubmitted: false })
    expect(r.members.a.missedReviewsOf).toEqual([])
    expect(r.members.b.missedReviewsOf).toEqual([])
  })

  it('a week doc without judges (before batch 2) has none: the same results as before', () => {
    const r = computeWeek(weekData(W, setup), space(['a', 'b', 'j']), afterDeadline)
    expect(r.judges).toEqual([])
    expect(r.members.j).toMatchObject({ judge: false, taskCount: 3, score: 100 })
  })

  it('a judge with a leftover plan costs nobody points in the month', () => {
    const data = judged(weekData('2026-10-05', { ...setup, reviews: [['j', 'a', [1, 1]], ['j', 'b', [1]], ['a', 'b', [1]], ['b', 'a', [1, 1]]], submittedBy: ['a', 'b', 'j'] }), ['j'])
    const res = computeMonth(space(['a', 'b', 'j']), '2026-10', [data], monthCompleteAt('2026-10', TZ))
    expect(res.a).toMatchObject({ missedReviews: 0, average: 100, judged: [] })
    expect(res.j).toMatchObject({ judged: ['2026-10-05'], average: null, finalScore: null, passed: null, skippedAsJudge: 0, others: ['a', 'b'] })
    expect(res.a.others).toEqual(['b'])
  })
})

describe('judged weeks in a month (0% where you also play)', () => {
  // November 2026 has four weeks.
  const NOV = ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23']
  const sp = space(['a', 'b'])
  const end = monthCompleteAt('2026-11', TZ)
  /** a plays (1 task, done) in the weeks listed, else judges; b always plays (1 task). Everyone reviews. */
  const month = (aPlays: WeekId[]) =>
    NOV.map((w) => {
      const tasks: Record<UID, number> = aPlays.includes(w) ? { a: 1, b: 1 } : { b: 1 }
      return judged(weekData(w, { members: ['a', 'b'], tasks, reviews: allDone(['a', 'b'], tasks), submittedBy: ['a', 'b'] }), aPlays.includes(w) ? [] : ['a'])
    })

  it('100% in week 1, then judging weeks 2–4: 25%', () => {
    const res = computeMonth(sp, '2026-11', month([NOV[0]]), end)
    expect(res.a).toMatchObject({ average: 25, finalScore: 25, passed: false, judged: NOV.slice(1), skippedAsJudge: 0 })
    expect(res.a.weeks).toEqual([{ weekId: NOV[0], score: 100, closed: true }])
    expect(res.b).toMatchObject({ average: 100, passed: true, others: ['a'] })
  })

  it('judging weeks 1–3, then playing week 4 at 100%: 25%', () => {
    const res = computeMonth(sp, '2026-11', month([NOV[3]]), end)
    expect(res.a).toMatchObject({ average: 25, passed: false, judged: NOV.slice(0, 3) })
    // Before week 4 closes only the closed judged weeks count, at 0.
    const early = computeMonth(sp, '2026-11', month([NOV[3]]), weekBounds(NOV[3], TZ).reviewOpenAt)
    expect(early.a).toMatchObject({ average: 0, complete: false, passed: null })
  })

  it('a month someone only judged: no score, nothing owed, in nobody’s others', () => {
    const res = computeMonth(sp, '2026-11', month([]), end)
    expect(res.a).toMatchObject({ average: null, finalScore: null, passed: null, judged: NOV, weeks: [], others: ['b'] })
    expect(res.b.others).toEqual([])
  })

  it('a judge’s skipped reviews are counted apart, never subtracted', () => {
    const weeks = month([NOV[0]]).map((d, i) => (i === 0 ? d : { ...d, reviews: [], week: d.week && { ...d.week, submittedBy: [] } }))
    const res = computeMonth(sp, '2026-11', weeks, end)
    expect(res.a).toMatchObject({ skippedAsJudge: 3, missedReviews: 0, penaltyPoints: 0, average: 25 })
  })
})

describe('paused weeks (§9.3)', () => {
  const pausedSpace = (memberIds: UID[]) => ({ ...space(memberIds), paused: { '2026-10': W } })

  it('nothing counts: every score is null and nobody misses a review; tasks and provisional scores as usual', () => {
    const data = weekData(W, { members: ['a', 'b'], tasks: { a: 2, b: 1 }, done: { a: 1 } })
    const r = computeWeek(data, pausedSpace(['a', 'b']), afterDeadline)
    expect(r).toMatchObject({ paused: true, revealed: true, phase: 'closed' })
    expect(r.members.a).toMatchObject({ score: null, provisionalScore: 50, taskCount: 2, missedReviewsOf: [] })
    expect(r.members.b).toMatchObject({ score: null, missedReviewsOf: [] })
    // The same week unpaused: a missed b and scores 50.
    expect(computeWeek(data, space(['a', 'b']), afterDeadline).members.a).toMatchObject({ score: 50, missedReviewsOf: ['b'] })
    // Another month's pause doesn't touch it.
    expect(computeWeek(data, { ...space(['a', 'b']), paused: { '2026-11': W } }, afterDeadline).paused).toBe(false)
  })

  it('in the month: listed as paused, left out of the average (not 0%) and of `others`', () => {
    const weeks = [
      weekData('2026-10-05', { members: ['a', 'b'], tasks: { a: 1, b: 1 }, reviews: allDone(['a', 'b'], { a: 1, b: 1 }), submittedBy: ['a', 'b'] }),
      // c only took part in the paused week.
      weekData(W, { members: ['a', 'b', 'c'], tasks: { a: 4, b: 1, c: 2 } }),
    ]
    const res = computeMonth(pausedSpace(['a', 'b', 'c']), '2026-10', weeks, monthCompleteAt('2026-10', TZ))
    expect(res.a.weeks).toEqual([
      { weekId: '2026-10-05', score: 100, closed: true },
      { weekId: W, score: null, closed: true, paused: true },
    ])
    expect(res.a).toMatchObject({ average: 100, missedReviews: 0, passed: true, others: ['b'] })
    expect(res.c).toMatchObject({ average: null, finalScore: null, passed: null, others: ['a', 'b'] })
  })

  it('every week paused: no score', () => {
    const res = computeMonth(pausedSpace(['a', 'b']), '2026-10', [weekData(W, { members: ['a', 'b'], tasks: { a: 1, b: 1 } })], monthCompleteAt('2026-10', TZ))
    expect(res.a).toMatchObject({ finalScore: null, passed: null, others: [] })
  })
})

describe('monthly lists (§9.5)', () => {
  const M = '2026-10'
  const listEnd = monthlyBounds(M, (w) => weekBounds(w, TZ)).deadlineAt

  it('computeMonthly scores a list like a week; no tasks means no list (null, not 0%); judges as in weeks', () => {
    const data = monthlyData(M, {
      members: ['a', 'b', 'c'],
      judges: ['c'],
      tasks: { a: 2, b: 0, c: 2 },
      done: { a: 1 },
      reviews: [
        ['b', 'a', [1, 0.5]],
        ['c', 'a', [1, 1]],
      ],
      submittedBy: ['b', 'c'],
    })
    const sp = space(['a', 'b', 'c'])
    const r = computeMonthly(data, sp, listEnd)
    expect(r).toMatchObject({ weekId: M, phase: 'closed', revealed: true, paused: false, judges: ['c'] })
    expect(r.members.a).toMatchObject({ score: 87.5, provisionalScore: 50, taskCount: 2, missedReviewsOf: [] })
    expect(r.members.b).toMatchObject({ participating: true, taskCount: 0, score: null, provisionalScore: null, missedReviewsOf: [] })
    expect(r.members.c).toMatchObject({ judge: true, score: null, taskCount: 0 })
    expect(reviewTargets(data, 'b')).toEqual(['a'])
    expect(reviewTargets(data, 'a')).toEqual([])
    // Before its deadline (a hasn't submitted): no score yet, the provisional one shows.
    const before = computeMonthly(data, sp, listEnd - H)
    expect(before.phase).toBe('review')
    expect(before.members.a).toMatchObject({ score: null, provisionalScore: 50 })
    // Without a doc: nobody is in it, on the computed bounds.
    expect(computeMonthly({ ...data, monthly: null }, sp, listEnd - H)).toMatchObject({ phase: 'review', revealed: false, members: { a: { participating: false } } })
  })

  /** a: weeks of 100% and 80% (self check-offs, nobody reviews a) and a list at 90%; b plays with no tasks. */
  const setup = () => ({
    weeks: [
      weekData('2026-10-05', { members: ['a', 'b'], tasks: { a: 1, b: 0 }, done: { a: 1 } }),
      weekData('2026-10-12', { members: ['a', 'b'], tasks: { a: 5, b: 0 }, done: { a: 4 } }),
    ],
    list: monthlyData(M, { members: ['a', 'b'], tasks: { a: 10, b: 0 }, done: { a: 9 } }),
  })

  it('a closed list with tasks is one extra week: 100, 80 and 90 average to exactly 90', () => {
    const { weeks, list } = setup()
    const res = computeMonth(space(['a', 'b']), M, weeks, listEnd, list)
    expect(res.a).toMatchObject({ average: 90, finalScore: 90, passed: true, missedReviews: 0, monthly: { score: 90, closed: true, taskCount: 10 }, monthlyJudge: false })
    // b missed a's two weeks and a's list: 5 points each.
    expect(res.b).toMatchObject({ monthly: null, missedReviews: 3, penaltyPoints: 15, average: 0 })
    expect(res.a.others).toEqual(['b'])
  })

  it('an open list is listed but not averaged yet', () => {
    const { weeks, list } = setup()
    const res = computeMonth(space(['a', 'b']), M, weeks, listEnd - H, list)
    expect(res.a).toMatchObject({ monthly: { score: null, closed: false, taskCount: 10 }, average: 90, complete: false })
  })

  it('in a paused last week, missed monthly reviews cost nothing and the list still counts', () => {
    const { weeks, list } = setup()
    const res = computeMonth({ ...space(['a', 'b']), paused: { [M]: '2026-10-26' } }, M, weeks, listEnd, list)
    expect(res.b).toMatchObject({ missedReviews: 2 })
    expect(res.a).toMatchObject({ average: 90, monthly: { score: 90 } })
  })

  it('a monthly judge: no list, skips counted apart; a list player who judged weeks scores them 0%', () => {
    const { list } = setup()
    const judgeList: MonthlyData = { ...list, monthly: list.monthly && { ...list.monthly, judges: ['b'] } }
    const res = computeMonth(space(['a', 'b']), M, [], listEnd, judgeList)
    expect(res.b).toMatchObject({ monthlyJudge: true, monthly: null, skippedAsJudge: 1, missedReviews: 0, finalScore: null })
    expect(res.a).toMatchObject({ average: 90, others: [] })
    // a plays only the list and judged a week: that week counts as 0%.
    const week = judged(weekData('2026-10-05', { members: ['a', 'b'], tasks: { b: 1 }, reviews: [['a', 'b', [1]]], submittedBy: ['a', 'b'] }), ['a'])
    expect(computeMonth(space(['a', 'b']), M, [week], listEnd, list).a).toMatchObject({ judged: ['2026-10-05'], average: 45 })
  })

  it('a list of another month is ignored', () => {
    const { weeks, list } = setup()
    expect(computeMonth(space(['a', 'b']), '2026-11', weeks, listEnd, list).a.monthly).toBeNull()
  })
})

describe('monthEndsAt and completion by stored deadlines (§9.6)', () => {
  const M = '2026-10'
  const last = weekBounds('2026-10-26', TZ)

  it('the last week’s stored deadline, the list’s if later; computed without a doc', () => {
    const sp = space(['a'])
    expect(monthEndsAt(sp, M, [])).toBe(last.deadlineAt)
    const lastWeek = weekData('2026-10-26', { members: ['a'] })
    const stored = { ...lastWeek, week: lastWeek.week && { ...lastWeek.week, deadlineAt: last.deadlineAt + 3 * H } }
    expect(monthEndsAt(sp, M, [stored])).toBe(last.deadlineAt + 3 * H)
    const list = monthlyData(M, { members: ['a'] })
    const later = { ...list, monthly: list.monthly && { ...list.monthly, deadlineAt: last.deadlineAt + 5 * H } }
    expect(monthEndsAt(sp, M, [stored], later)).toBe(last.deadlineAt + 5 * H)
    expect(monthEndsAt(sp, M, [stored], list)).toBe(last.deadlineAt + 3 * H)
    // A space on its own times, no doc: computed on its schedule (reviews due Saturday at noon).
    const saturdayNoon: WeekSchedule = { lock: 1440, reviewOpen: 5760, deadline: 7920 }
    expect(monthEndsAt({ ...sp, schedule: saturdayNoon }, M, [])).toBe(weekBounds('2026-10-26', TZ, saturdayNoon).deadlineAt)
  })

  it('computeMonth is complete at the stored deadline, not the computed one', () => {
    const weeks = [weekData('2026-10-26', { members: ['a'], tasks: { a: 1 }, done: { a: 1 } })]
    weeks[0].week = weeks[0].week && { ...weeks[0].week, deadlineAt: last.deadlineAt + 2 * H }
    expect(computeMonth(space(['a']), M, weeks, last.deadlineAt + H).a.complete).toBe(false)
    expect(computeMonth(space(['a']), M, weeks, last.deadlineAt + 2 * H).a.complete).toBe(true)
  })

  it('computeWeek without a doc uses the space’s own times', () => {
    const tuesdayNoon: WeekSchedule = { lock: 2160, reviewOpen: 5760, deadline: 7200 }
    const empty: WeekData = { spaceId: 's1', weekId: W, week: null, plans: {}, progress: {}, reviews: [] }
    expect(computeWeek(empty, space(['a']), b.lockAt + H).phase).toBe('active')
    expect(computeWeek(empty, { ...space(['a']), schedule: tuesdayNoon }, b.lockAt + H).phase).toBe('planning')
  })
})

// ---------- Batch 2.5 (SPEC §10.4): crossed-out tasks and the fair vote ----------

const WHY = 'The pool is closed all week'

function cancelOf(changes: number): TaskCancel {
  return { cancelled: changes % 2 === 1, changes, at: b.lockAt + changes * H, why: WHY }
}

/** Crosses out the listed tasks of `uid` (an even `changes`: crossed out, then restored). */
function crossOut<T extends WeekData | MonthlyData>(data: T, uid: UID, ids: string[], changes = 1): T {
  const plan = data.plans[uid]
  const tasks = plan.tasks.map((t) => (ids.includes(t.id) ? { ...t, cancel: cancelOf(changes) } : t))
  return { ...data, plans: { ...data.plans, [uid]: { ...plan, tasks } } }
}

/** A submitted review with exactly these marks (a task left out: no mark). */
function withReview<T extends WeekData | MonthlyData>(data: T, reviewerId: UID, revieweeId: UID, marks: Record<string, ReviewMark>): T {
  return { ...data, reviews: [...data.reviews, { id: `${reviewerId}_${revieweeId}`, reviewerId, revieweeId, marks, submittedAt: 0 }] }
}

function withDone<T extends WeekData | MonthlyData>(data: T, uid: UID, ids: string[]): T {
  return { ...data, progress: { ...data.progress, [uid]: { uid, done: Object.fromEntries(ids.map((id) => [id, true])), updatedAt: 0 } } }
}

describe('crossed-out tasks: the vote (§10.4)', () => {
  /** a has 4 tasks and crossed out a2; everyone else only reviews. */
  const four = (members: UID[] = ['a', 'b', 'c', 'd']) => crossOut(weekData(W, { members, tasks: { a: 4 }, submittedBy: members }), 'a', ['a2'])

  it('3 reviewers, 2 say fair: excused, left out of the marks and the task count', () => {
    let data = four()
    data = withReview(data, 'b', 'a', { a1: 1, a2: 'fair', a3: 1, a4: 0.5 })
    data = withReview(data, 'c', 'a', { a1: 1, a2: 'fair', a3: 0.5, a4: 0 })
    data = withReview(data, 'd', 'a', { a1: 0.5, a2: 0, a3: 1, a4: 1 })
    const a = computeWeek(data, space(['a', 'b', 'c', 'd']), afterDeadline).members.a
    // 2.5 + 2.5 + 1.5 of 3 tasks × 3 reviewers.
    expect(a).toMatchObject({ taskCount: 4, score: 650 / 9, cancelledCount: 1, excusedCount: 1, skipped: false, reviewedBy: ['b', 'c', 'd'] })
    expect(a.tasks[1]).toMatchObject({ taskId: 'a2', mark: 0, source: 'reviews', reviewerMarks: { b: 0, c: 0, d: 0 }, fairBy: ['b', 'c'], excused: true, cancel: cancelOf(1) })
    // The other tasks are as always, without vote fields.
    expect(a.tasks[0]).toMatchObject({ mark: 2.5 / 3, reviewerMarks: { b: 1, c: 1, d: 0.5 } })
    for (const t of [a.tasks[0], a.tasks[2], a.tasks[3]]) expect(['cancel' in t, 'fairBy' in t, 'excused' in t]).toEqual([false, false, false])
  })

  it('3 reviewers: 1 says fair → counts 0 in all 4 tasks; all 3 say fair → excused', () => {
    let one = four()
    one = withReview(one, 'b', 'a', { a1: 1, a2: 'fair', a3: 1, a4: 0.5 })
    one = withReview(one, 'c', 'a', { a1: 1, a2: 0, a3: 0.5, a4: 0 })
    one = withReview(one, 'd', 'a', { a1: 0.5, a2: 0, a3: 1, a4: 1 })
    const a = computeWeek(one, space(['a', 'b', 'c', 'd']), afterDeadline).members.a
    expect(a).toMatchObject({ score: 650 / 12, excusedCount: 0, cancelledCount: 1, skipped: false })
    expect(a.tasks[1]).toMatchObject({ mark: 0, fairBy: ['b'], excused: false })

    let all = four()
    for (const r of ['b', 'c', 'd']) all = withReview(all, r, 'a', { a1: 1, a2: 'fair', a3: 1, a4: 1 })
    expect(computeWeek(all, space(['a', 'b', 'c', 'd']), afterDeadline).members.a).toMatchObject({ score: 100, excusedCount: 1 })
  })

  it('a tie is Not Done: 2 reviewers with 1 fair, 4 reviewers with 2 fair', () => {
    let two = four(['a', 'b', 'c'])
    two = withReview(two, 'b', 'a', { a1: 1, a2: 'fair', a3: 1, a4: 0.5 })
    two = withReview(two, 'c', 'a', { a1: 1, a2: 0, a3: 0.5, a4: 0 })
    const a = computeWeek(two, space(['a', 'b', 'c']), afterDeadline).members.a
    // 4 of 4 tasks × 2 reviewers: a2 counts 0.
    expect(a).toMatchObject({ score: 50, excusedCount: 0, skipped: false })
    expect(a.tasks[1]).toMatchObject({ mark: 0, fairBy: ['b'], excused: false, reviewerMarks: { b: 0, c: 0 } })

    let fourR = four(['a', 'b', 'c', 'd', 'e'])
    for (const [r, vote] of [['b', 'fair'], ['c', 'fair'], ['d', 0], ['e', 0]] as const) fourR = withReview(fourR, r, 'a', { a1: 1, a2: vote, a3: 1, a4: 1 })
    const tie = computeWeek(fourR, space(['a', 'b', 'c', 'd', 'e']), afterDeadline).members.a
    expect(tie).toMatchObject({ score: 75, excusedCount: 0 })
    expect(tie.tasks[1]).toMatchObject({ fairBy: ['b', 'c'], excused: false })
  })

  it('1 reviewer: fair excuses it, Not Done counts 0', () => {
    const fair = withReview(four(['a', 'b']), 'b', 'a', { a1: 1, a2: 'fair', a3: 1, a4: 0.5 })
    expect(computeWeek(fair, space(['a', 'b']), afterDeadline).members.a).toMatchObject({ score: 250 / 3, excusedCount: 1 })
    const notDone = withReview(four(['a', 'b']), 'b', 'a', { a1: 1, a2: 0, a3: 1, a4: 0.5 })
    expect(computeWeek(notDone, space(['a', 'b']), afterDeadline).members.a).toMatchObject({ score: 62.5, excusedCount: 0 })
  })

  it('a judge’s vote counts like anyone’s', () => {
    const base = judged(four(['a', 'b', 'j']), ['j'])
    const both = withReview(withReview(base, 'b', 'a', { a1: 1, a2: 'fair', a3: 1, a4: 1 }), 'j', 'a', { a1: 1, a2: 'fair', a3: 1, a4: 1 })
    const a = computeWeek(both, space(['a', 'b', 'j']), afterDeadline).members.a
    expect(a).toMatchObject({ score: 100, excusedCount: 1, reviewedBy: ['b', 'j'] })
    expect(a.tasks[1].fairBy).toEqual(['b', 'j'])
    // The judge says Not Done: a tie.
    const split = withReview(withReview(base, 'b', 'a', { a1: 1, a2: 'fair', a3: 1, a4: 1 }), 'j', 'a', { a1: 1, a2: 0, a3: 1, a4: 1 })
    expect(computeWeek(split, space(['a', 'b', 'j']), afterDeadline).members.a).toMatchObject({ score: 75, excusedCount: 0 })
    // A judge has no list, so nothing of theirs is crossed out.
    expect(computeWeek(split, space(['a', 'b', 'j']), afterDeadline).members.j).toMatchObject({ judge: true, taskCount: 0, score: null })
  })

  it('a reviewer who left after submitting counts; a member who didn’t submit doesn’t', () => {
    // c left the space on Wednesday after reviewing; e never submitted.
    const sp: Space = { ...space(['a', 'b', 'd', 'e']), leftAt: { c: b.lockAt + 2 * H } }
    let data = four(['a', 'b', 'c', 'd', 'e'])
    data = withReview(data, 'b', 'a', { a1: 1, a2: 0, a3: 1, a4: 1 })
    data = withReview(data, 'd', 'a', { a1: 1, a2: 'fair', a3: 1, a4: 1 })
    const withC = withReview(data, 'c', 'a', { a1: 1, a2: 'fair', a3: 1, a4: 1 })
    // 2 of the 3 reviews say fair (e's missing review isn't a vote).
    expect(computeWeek(withC, sp, afterDeadline).members.a).toMatchObject({ score: 100, excusedCount: 1, reviewedBy: ['b', 'd', 'c'] })
    // Without c's review: 1 of 2, a tie.
    expect(computeWeek(data, sp, afterDeadline).members.a).toMatchObject({ score: 75, excusedCount: 0, reviewedBy: ['b', 'd'] })
  })

  it('an old client’s Done or Half on a crossed-out task is Not Done', () => {
    let data = crossOut(weekData(W, { members: ['a', 'b', 'c'], tasks: { a: 2 }, submittedBy: ['a', 'b', 'c'] }), 'a', ['a2'])
    data = withReview(data, 'b', 'a', { a1: 1, a2: 1 })
    data = withReview(data, 'c', 'a', { a1: 1, a2: 0.5 })
    const a = computeWeek(data, space(['a', 'b', 'c']), afterDeadline).members.a
    expect(a).toMatchObject({ score: 50, excusedCount: 0 })
    expect(a.tasks[1]).toMatchObject({ mark: 0, reviewerMarks: { b: 0, c: 0 }, fairBy: [], excused: false })
  })

  it('a missing mark is not fair, and an empty review still counts as a review', () => {
    const base = crossOut(weekData(W, { members: ['a', 'b', 'c'], tasks: { a: 2 }, submittedBy: ['a', 'b', 'c'] }), 'a', ['a2'])
    const skipped = withReview(withReview(base, 'b', 'a', { a1: 1, a2: 'fair' }), 'c', 'a', { a1: 1 })
    expect(computeWeek(skipped, space(['a', 'b', 'c']), afterDeadline).members.a).toMatchObject({ score: 50, excusedCount: 0 })
    const empty = withReview(withReview(base, 'b', 'a', { a1: 1, a2: 'fair' }), 'c', 'a', {})
    expect(computeWeek(empty, space(['a', 'b', 'c']), afterDeadline).members.a).toMatchObject({ score: 25, excusedCount: 0, reviewedBy: ['b', 'c'] })
  })

  it('a fair vote on a task that isn’t crossed out counts 0', () => {
    const plain = withReview(weekData(W, { members: ['a', 'b'], tasks: { a: 2 }, submittedBy: ['a', 'b'] }), 'b', 'a', { a1: 'fair', a2: 1 })
    const a = computeWeek(plain, space(['a', 'b']), afterDeadline).members.a
    expect(a).toMatchObject({ score: 50, cancelledCount: 0, excusedCount: 0 })
    expect(a.tasks[0]).toMatchObject({ mark: 0, reviewerMarks: { b: 0 } })
    expect('fairBy' in a.tasks[0]).toBe(false)
    // a2 crossed out after b's Done (a lost race, §10.12): Not Done; a1's fair is still 0.
    expect(computeWeek(crossOut(plain, 'a', ['a2']), space(['a', 'b']), afterDeadline).members.a).toMatchObject({ score: 0, excusedCount: 0 })
    // Fair on both: a2 is excused, a1 still counts 0.
    const crossedA2 = withReview(weekData(W, { members: ['a', 'b'], tasks: { a: 2 }, submittedBy: ['a', 'b'] }), 'b', 'a', { a1: 'fair', a2: 'fair' })
    expect(computeWeek(crossOut(crossedA2, 'a', ['a2']), space(['a', 'b']), afterDeadline).members.a).toMatchObject({ score: 0, excusedCount: 1, skipped: false })
  })

  it('nobody reviewed: the self check-offs of every task count, crossed-out ones included; nothing is excused', () => {
    // a ticked a1 before crossing it out; b never reviewed a.
    const data = withDone(crossOut(weekData(W, { members: ['a', 'b'], tasks: { a: 2, b: 1 }, submittedBy: ['a'] }), 'a', ['a1']), 'a', ['a1'])
    const a = computeWeek(withReview(data, 'a', 'b', { b1: 1 }), space(['a', 'b']), afterDeadline).members.a
    expect(a).toMatchObject({ score: 50, provisionalScore: 0, reviewedBy: [], cancelledCount: 1, excusedCount: 0, skipped: false })
    expect(a.tasks[0]).toMatchObject({ mark: 1, source: 'self', fairBy: [], excused: false, selfDone: true })
    // Every task crossed out, nobody reviewed: still the self check-offs (not skipped), no provisional score.
    const all = withDone(crossOut(weekData(W, { members: ['a', 'b'], tasks: { a: 2 } }), 'a', ['a1', 'a2']), 'a', ['a1'])
    expect(computeWeek(all, space(['a', 'b']), afterDeadline).members.a).toMatchObject({ score: 50, provisionalScore: null, skipped: false, excusedCount: 0 })
  })

  it('every task excused: the period is skipped (score null, not 0%)', () => {
    let data = crossOut(weekData(W, { members: ['a', 'b', 'c'], tasks: { a: 2, b: 1 }, submittedBy: ['a', 'b', 'c'] }), 'a', ['a1', 'a2'])
    data = withReview(data, 'b', 'a', { a1: 'fair', a2: 'fair' })
    data = withReview(data, 'c', 'a', { a1: 'fair', a2: 'fair' })
    const r = computeWeek(data, space(['a', 'b', 'c']), afterDeadline)
    expect(r.members.a).toMatchObject({ participating: true, taskCount: 2, score: null, provisionalScore: null, skipped: true, cancelledCount: 2, excusedCount: 2 })
    expect(r.members.a.tasks.map((t) => t.excused)).toEqual([true, true])
    // Others are unaffected; a still had to review b (a didn't: a misses it).
    expect(r.members.a.missedReviewsOf).toEqual(['b'])
    expect(r.members.b).toMatchObject({ skipped: false, cancelledCount: 0, excusedCount: 0 })
    // One excused, one not: 0%, not skipped.
    const half = withReview(withReview(crossOut(weekData(W, { members: ['a', 'b', 'c'], tasks: { a: 2 }, submittedBy: ['a', 'b', 'c'] }), 'a', ['a1', 'a2']), 'b', 'a', { a1: 'fair', a2: 'fair' }), 'c', 'a', { a1: 'fair', a2: 0 })
    expect(computeWeek(half, space(['a', 'b', 'c']), afterDeadline).members.a).toMatchObject({ score: 0, skipped: false, excusedCount: 1 })
  })

  it('someone whose every task is crossed out is still a review target: skipping their vote costs as before', () => {
    const data = withReview(crossOut(weekData(W, { members: ['a', 'b', 'c'], tasks: { a: 1, b: 1 }, submittedBy: ['b', 'c'] }), 'a', ['a1']), 'c', 'a', { a1: 'fair' })
    expect(reviewTargets(data, 'b')).toEqual(['a'])
    const r = computeWeek(data, space(['a', 'b', 'c']), afterDeadline)
    expect(r.members.b.missedReviewsOf).toEqual(['a'])
    // c's vote is the only one: excused.
    expect(r.members.a).toMatchObject({ skipped: true, score: null, reviewedBy: ['c'] })
  })

  it('a restored task (2 or 4 changes) scores and ticks as normal; its log is still reported', () => {
    let data = weekData(W, { members: ['a', 'b'], tasks: { a: 2 }, done: { a: 1 }, submittedBy: ['a', 'b'] })
    data = crossOut(crossOut(data, 'a', ['a1'], 2), 'a', ['a2'], 4)
    const before = computeWeek(data, space(['a', 'b']), duringWeek).members.a
    expect(before).toMatchObject({ provisionalScore: 50, cancelledCount: 0 })
    data = withReview(data, 'b', 'a', { a1: 1, a2: 'fair' })
    const a = computeWeek(data, space(['a', 'b']), afterDeadline).members.a
    expect(a).toMatchObject({ score: 50, cancelledCount: 0, excusedCount: 0, skipped: false })
    expect(a.tasks[0]).toMatchObject({ mark: 1, cancel: cancelOf(2) })
    expect(a.tasks[1]).toMatchObject({ mark: 0, cancel: cancelOf(4) })
    for (const t of a.tasks) expect(['fairBy' in t, 'excused' in t]).toEqual([false, false])
  })

  it('the provisional score leaves crossed-out tasks out; null when every task is', () => {
    const data = weekData(W, { members: ['a', 'b'], tasks: { a: 3 }, done: { a: 2 } })
    expect(computeWeek(data, space(['a', 'b']), duringWeek).members.a.provisionalScore).toBeCloseTo(200 / 3, 12)
    // a1 (ticked) crossed out: a2 ticked, a3 not.
    expect(computeWeek(crossOut(data, 'a', ['a1']), space(['a', 'b']), duringWeek).members.a).toMatchObject({ provisionalScore: 50, cancelledCount: 1, taskCount: 3 })
    // a3 (not ticked) crossed out: both left are ticked.
    expect(computeWeek(crossOut(data, 'a', ['a3']), space(['a', 'b']), duringWeek).members.a.provisionalScore).toBe(100)
    expect(computeWeek(crossOut(data, 'a', ['a1', 'a2', 'a3']), space(['a', 'b']), duringWeek).members.a).toMatchObject({ provisionalScore: null, cancelledCount: 3 })
    // Steps: the share of steps ticked, as always, for the tasks left.
    const stepped = withDone(weekData(W, { members: ['a'], tasks: {} }), 'a', ['s1', 's3'])
    stepped.plans.a = { uid: 'a', tasks: [{ id: 'x', title: 'x', subtasks: [{ id: 's1', title: '1' }, { id: 's2', title: '2' }] }, { id: 'y', title: 'y', subtasks: [{ id: 's3', title: '3' }] }], updatedAt: 0 }
    expect(computeWeek(crossOut(stepped, 'a', ['y']), space(['a']), duringWeek).members.a.provisionalScore).toBe(50)
    // No tasks: 0 for a week, as before.
    expect(computeWeek(data, space(['a', 'b']), duringWeek).members.b.provisionalScore).toBe(0)
  })

  it('nothing is excused before the reveal: the caller sees the votes they can, the excusal comes with the results', () => {
    const data = withReview(crossOut(weekData(W, { members: ['a', 'b'], tasks: { a: 1, b: 1 }, submittedBy: ['b'] }), 'a', ['a1']), 'b', 'a', { a1: 'fair' })
    const before = computeWeek(data, space(['a', 'b']), duringReview)
    expect(before.revealed).toBe(false)
    expect(before.members.a).toMatchObject({ score: null, provisionalScore: null, cancelledCount: 1, excusedCount: 0, skipped: false })
    expect(before.members.a.tasks[0]).toMatchObject({ fairBy: ['b'], excused: false })
    // a submits: revealed, excused, the week is skipped for a.
    const after = computeWeek({ ...data, week: data.week && { ...data.week, submittedBy: ['b', 'a'] } }, space(['a', 'b']), duringReview)
    expect(after.revealed).toBe(true)
    expect(after.members.a).toMatchObject({ score: null, skipped: true, excusedCount: 1 })
    expect(after.members.a.tasks[0].excused).toBe(true)
  })

  it('a paused week stays all-null: never skipped, nobody misses a review', () => {
    const paused: Space = { ...space(['a', 'b']), paused: { '2026-10': W } }
    const data = withReview(crossOut(weekData(W, { members: ['a', 'b'], tasks: { a: 1, b: 1 }, submittedBy: ['b'] }), 'a', ['a1']), 'b', 'a', { a1: 'fair' })
    const r = computeWeek(data, paused, afterDeadline)
    expect(r.paused).toBe(true)
    expect(r.members.a).toMatchObject({ score: null, skipped: false, missedReviewsOf: [], cancelledCount: 1 })
    expect(r.members.b).toMatchObject({ score: null, skipped: false, missedReviewsOf: [] })
    // The vote itself is still reported once revealed.
    expect(r.members.a.tasks[0].excused).toBe(true)
  })

  it('every non-judge entry carries the new fields; a judge’s stays as in batch 2', () => {
    const r = computeWeek(judged(weekData(W, { members: ['a', 'j'], tasks: { a: 1 } }), ['j']), space(['a', 'j', 'late']), afterDeadline)
    expect(r.members.a).toMatchObject({ cancelledCount: 0, excusedCount: 0, skipped: false })
    expect(r.members.late).toMatchObject({ participating: false, cancelledCount: 0, excusedCount: 0, skipped: false })
    expect(['cancelledCount' in r.members.j, 'excusedCount' in r.members.j, 'skipped' in r.members.j]).toEqual([false, false, false])
  })
})

describe('crossed-out tasks on a monthly list (§10.4)', () => {
  const M = '2026-10'
  const listEnd = monthlyBounds(M, (w) => weekBounds(w, TZ)).deadlineAt
  const list = () => crossOut(monthlyData(M, { members: ['a', 'b', 'c'], tasks: { a: 3 }, submittedBy: ['a', 'b', 'c'] }), 'a', ['a1'])

  it('computeMonthly: the same vote, excusal and skipped list', () => {
    const excused = withReview(withReview(list(), 'b', 'a', { a1: 'fair', a2: 1, a3: 0.5 }), 'c', 'a', { a1: 'fair', a2: 1, a3: 1 })
    expect(computeMonthly(excused, space(['a', 'b', 'c']), listEnd).members.a).toMatchObject({ score: 87.5, excusedCount: 1, cancelledCount: 1, skipped: false })
    const tie = withReview(withReview(list(), 'b', 'a', { a1: 'fair', a2: 1, a3: 0.5 }), 'c', 'a', { a1: 0, a2: 1, a3: 1 })
    expect(computeMonthly(tie, space(['a', 'b', 'c']), listEnd).members.a).toMatchObject({ score: 3.5 / 6 * 100, excusedCount: 0 })
    const all = withReview(crossOut(list(), 'a', ['a1', 'a2', 'a3']), 'b', 'a', { a1: 'fair', a2: 'fair', a3: 'fair' })
    expect(computeMonthly(all, space(['a', 'b', 'c']), listEnd).members.a).toMatchObject({ taskCount: 3, score: null, skipped: true, excusedCount: 3, provisionalScore: null })
    // No tasks: still no list (null), never skipped.
    expect(computeMonthly(all, space(['a', 'b', 'c']), listEnd).members.b).toMatchObject({ taskCount: 0, score: null, provisionalScore: null, skipped: false })
    // Provisional before the reveal leaves a1 out.
    const ticked = withDone(crossOut(monthlyData(M, { members: ['a', 'b', 'c'], tasks: { a: 3 } }), 'a', ['a1']), 'a', ['a1', 'a2'])
    expect(computeMonthly(ticked, space(['a', 'b', 'c']), listEnd - 30 * H).members.a).toMatchObject({ score: null, provisionalScore: 50, cancelledCount: 1 })
  })
})

describe('computeMonth with crossed-out tasks (§10.4)', () => {
  const M = '2026-10'
  const complete = monthCompleteAt(M, TZ)
  const listEnd = monthlyBounds(M, (w) => weekBounds(w, TZ)).deadlineAt

  it('a skipped week is listed, never averaged, and its missed reviews still cost points', () => {
    const w1 = weekData('2026-10-05', { members: ['a', 'b'], tasks: { a: 1, b: 1 }, reviews: allDone(['a', 'b'], { a: 1, b: 1 }), submittedBy: ['a', 'b'] })
    // a crossed out their only task and b said fair; a never reviewed b.
    const w2 = withReview(crossOut(weekData(W, { members: ['a', 'b'], tasks: { a: 1, b: 1 }, done: { b: 1 }, submittedBy: ['b'] }), 'a', ['a1']), 'b', 'a', { a1: 'fair' })
    const res = computeMonth(space(['a', 'b']), M, [w1, w2], complete)
    expect(res.a.weeks).toEqual([
      { weekId: '2026-10-05', score: 100, closed: true },
      { weekId: W, score: null, closed: true, skipped: true },
    ])
    expect(res.a).toMatchObject({ average: 100, missedReviews: 1, penaltyPoints: 5, finalScore: 95, passed: true, others: ['b'] })
    // b: 100 and the self check-off fallback (nobody reviewed b), 100.
    expect(res.b).toMatchObject({ average: 100, missedReviews: 0, others: ['a'] })
    // Had a reviewed b, no points lost.
    const reviewed = withReview(w2, 'a', 'b', { b1: 1 })
    expect(computeMonth(space(['a', 'b']), M, [w1, reviewed], complete).a).toMatchObject({ average: 100, missedReviews: 0, finalScore: 100 })
  })

  it('every week skipped: no score, nothing owed; not a player, and judged weeks don’t count as 0%', () => {
    // c judged the first week and crossed out their only task in the second; a and b said fair.
    const w1 = judged(weekData('2026-10-05', { members: ['a', 'b', 'c'], tasks: { a: 1, b: 1 }, reviews: allDone(['a', 'b', 'c'], { a: 1, b: 1 }), submittedBy: ['a', 'b', 'c'] }), ['c'])
    const base = weekData(W, { members: ['a', 'b', 'c'], tasks: { a: 1, b: 1, c: 1 }, reviews: allDone(['a', 'b', 'c'], { a: 1, b: 1 }), submittedBy: ['a', 'b', 'c'] })
    const w2 = withReview(withReview(crossOut(base, 'c', ['c1']), 'a', 'c', { c1: 'fair' }), 'b', 'c', { c1: 'fair' })
    const res = computeMonth(space(['a', 'b', 'c']), M, [w1, w2], complete)
    expect(res.c).toMatchObject({
      weeks: [{ weekId: W, score: null, closed: true, skipped: true }],
      judged: ['2026-10-05'],
      average: null,
      finalScore: null,
      passed: null,
      complete: true,
      others: ['a', 'b'],
    })
    expect(res.a.others).toEqual(['b'])
    expect(res.b.others).toEqual(['a'])
    // Not excused (a tie): c plays, so the judged week counts as 0% next to the 0% week.
    const tie = withReview(withReview(crossOut(base, 'c', ['c1']), 'a', 'c', { c1: 'fair' }), 'b', 'c', { c1: 0 })
    const played = computeMonth(space(['a', 'b', 'c']), M, [w1, tie], complete)
    expect(played.c).toMatchObject({ average: 0, finalScore: 0, passed: false })
    expect(played.a.others).toEqual(['b', 'c'])
  })

  it('a skipped monthly list isn’t the extra week, but missed monthly reviews still count', () => {
    // a: weeks of 100% and 80% (self check-offs); a’s list was all excused; b has a list a didn't review.
    const weeks = [
      weekData('2026-10-05', { members: ['a', 'b'], tasks: { a: 1, b: 0 }, done: { a: 1 } }),
      weekData('2026-10-12', { members: ['a', 'b'], tasks: { a: 5, b: 0 }, done: { a: 4 } }),
    ]
    const base = monthlyData(M, { members: ['a', 'b'], tasks: { a: 2, b: 1 }, submittedBy: ['a', 'b'] })
    const skipped = withReview(crossOut(base, 'a', ['a1', 'a2']), 'b', 'a', { a1: 'fair', a2: 'fair' })
    const res = computeMonth(space(['a', 'b']), M, weeks, listEnd, skipped)
    expect(res.a).toMatchObject({ average: 90, missedReviews: 1, penaltyPoints: 5, finalScore: 85, monthly: { score: null, closed: true, taskCount: 2, skipped: true } })
    expect(res.b.monthly).toEqual({ score: 0, closed: true, taskCount: 1, skipped: false })
    // Not skipped: the extra week counts (a's list at 50%).
    const counted = withReview(crossOut(base, 'a', ['a1']), 'b', 'a', { a1: 0, a2: 1 })
    const res2 = computeMonth(space(['a', 'b']), M, weeks, listEnd, counted)
    expect(res2.a).toMatchObject({ monthly: { score: 50, skipped: false } })
    expect(res2.a.average).toBeCloseTo(230 / 3, 9)
  })

  it('a skipped list alone doesn’t make a player; the month has no score', () => {
    const base = monthlyData(M, { members: ['a', 'b'], tasks: { a: 1, b: 1 }, submittedBy: ['a', 'b'] })
    const list = withReview(withReview(crossOut(base, 'a', ['a1']), 'b', 'a', { a1: 'fair' }), 'a', 'b', { b1: 1 })
    const res = computeMonth(space(['a', 'b']), M, [], listEnd, list)
    expect(res.a).toMatchObject({ average: null, finalScore: null, passed: null, monthly: { skipped: true }, others: ['b'] })
    expect(res.b).toMatchObject({ average: 100, others: [] })
  })

  it('a partly excused week averages on the tasks left; late penalties as usual', () => {
    const w1 = weekData('2026-10-05', { members: ['a', 'b', 'c'], tasks: { a: 1, b: 1, c: 1 }, reviews: allDone(['a', 'b', 'c'], { a: 1, b: 1, c: 1 }), submittedBy: ['a', 'b', 'c'] })
    // a crossed out a2; a reviewed b but not c (one missed review).
    const base = crossOut(weekData(W, { members: ['a', 'b', 'c'], tasks: { a: 2, b: 1, c: 1 }, submittedBy: ['a', 'b', 'c'] }), 'a', ['a2'])
    const others = withReview(withReview(withReview(base, 'a', 'b', { b1: 1 }), 'b', 'c', { c1: 1 }), 'c', 'b', { b1: 1 })
    const vote = (c: ReviewMark) => withReview(withReview(others, 'b', 'a', { a1: 1, a2: 'fair' }), 'c', 'a', { a1: 1, a2: c })
    // Both say fair: a's week is 100% on a1 alone.
    const fair = computeMonth(space(['a', 'b', 'c']), M, [w1, vote('fair')], complete)
    expect(fair.a.weeks).toEqual([
      { weekId: '2026-10-05', score: 100, closed: true },
      { weekId: W, score: 100, closed: true },
    ])
    expect(fair.a).toMatchObject({ average: 100, missedReviews: 1, penaltyPoints: 5, finalScore: 95, passed: true, others: ['b', 'c'] })
    // A tie (c says Not Done): a2 counts 0, the week is 50%.
    const tie = computeMonth(space(['a', 'b', 'c']), M, [w1, vote(0)], complete)
    expect(tie.a.weeks[1]).toEqual({ weekId: W, score: 50, closed: true })
    expect(tie.a).toMatchObject({ average: 75, missedReviews: 1, finalScore: 70, passed: false })
    // c's old client marks a2 Done: still Not Done.
    expect(computeMonth(space(['a', 'b', 'c']), M, [w1, vote(1)], complete).a).toMatchObject({ average: 75, finalScore: 70 })
  })

  it('a skipped week with a missed review: no average, but the misses are still counted', () => {
    // a crossed out their only task; b said fair; a never reviewed b.
    const w2 = withReview(crossOut(weekData(W, { members: ['a', 'b'], tasks: { a: 1, b: 1 }, done: { b: 1 }, submittedBy: ['b'] }), 'a', ['a1']), 'b', 'a', { a1: 'fair' })
    const res = computeMonth(space(['a', 'b']), M, [w2], complete)
    expect(res.a).toMatchObject({ weeks: [{ weekId: W, score: null, closed: true, skipped: true }], average: null, missedReviews: 1, penaltyPoints: 5, finalScore: null, passed: null, others: ['b'] })
    // a isn't a player, so b plays alone: nobody to owe or be owed.
    expect(res.b).toMatchObject({ average: 100, others: [] })
    // Paused and skipped weeks together: still no average.
    const w1 = weekData('2026-10-05', { members: ['a', 'b'], tasks: { a: 1, b: 1 } })
    const both = computeMonth({ ...space(['a', 'b']), paused: { [M]: '2026-10-05' } }, M, [w1, w2], complete)
    expect(both.a.weeks).toEqual([
      { weekId: '2026-10-05', score: null, closed: true, paused: true },
      { weekId: W, score: null, closed: true, skipped: true },
    ])
    expect(both.a).toMatchObject({ average: null, finalScore: null })
  })

  it('a skipped week next to a scored monthly list: a player, so a closed judged week counts as 0%', () => {
    // c judged the first week, had their only task of the second excused, and scored 75% on the October list.
    const w1 = judged(weekData('2026-10-05', { members: ['a', 'b', 'c'], tasks: { a: 1, b: 1 }, reviews: allDone(['a', 'b', 'c'], { a: 1, b: 1 }), submittedBy: ['a', 'b', 'c'] }), ['c'])
    const base = weekData(W, { members: ['a', 'b', 'c'], tasks: { a: 1, b: 1, c: 1 }, reviews: allDone(['a', 'b', 'c'], { a: 1, b: 1 }), submittedBy: ['a', 'b', 'c'] })
    const w2 = withReview(withReview(crossOut(base, 'c', ['c1']), 'a', 'c', { c1: 'fair' }), 'b', 'c', { c1: 'fair' })
    const list = withReview(withReview(monthlyData(M, { members: ['a', 'b', 'c'], tasks: { c: 1 }, submittedBy: ['a', 'b', 'c'] }), 'a', 'c', { c1: 0.5 }), 'b', 'c', { c1: 1 })
    const res = computeMonth(space(['a', 'b', 'c']), M, [w1, w2], listEnd, list)
    expect(res.c).toMatchObject({
      weeks: [{ weekId: W, score: null, closed: true, skipped: true }],
      judged: ['2026-10-05'],
      monthly: { score: 75, closed: true, taskCount: 1, skipped: false },
      average: 37.5,
      others: ['a', 'b'],
    })
    expect(res.a.others).toEqual(['b', 'c'])
  })

  it('a monthly list voted on by three, a judge among them: 2 of 3 fair excuses it', () => {
    const base = crossOut(monthlyData(M, { members: ['a', 'b', 'c', 'j'], tasks: { a: 2 }, judges: ['j'], submittedBy: ['a', 'b', 'c', 'j'] }), 'a', ['a1'])
    const vote = (j: ReviewMark) => withReview(withReview(withReview(base, 'b', 'a', { a1: 'fair', a2: 1 }), 'c', 'a', { a1: 0, a2: 0.5 }), 'j', 'a', { a1: j, a2: 1 })
    const excused = computeMonthly(vote('fair'), space(['a', 'b', 'c', 'j']), listEnd).members.a
    expect(excused).toMatchObject({ score: 250 / 3, excusedCount: 1, skipped: false, reviewedBy: ['b', 'c', 'j'] })
    expect(excused.tasks[0]).toMatchObject({ fairBy: ['b', 'j'], excused: true, reviewerMarks: { b: 0, c: 0, j: 0 } })
    expect(computeMonth(space(['a', 'b', 'c', 'j']), M, [], listEnd, vote('fair')).a.monthly).toEqual({ score: 250 / 3, closed: true, taskCount: 2, skipped: false })
    // The judge's old client marks it Half: 1 of 3, counts 0 out of both tasks.
    expect(computeMonthly(vote(0.5), space(['a', 'b', 'c', 'j']), listEnd).members.a).toMatchObject({ score: 250 / 6, excusedCount: 0 })
  })

  it('isMonthPlayer: a week that is neither paused nor skipped, or a list that isn’t skipped', () => {
    const week = (e: Partial<MonthWeekEntry>): MonthWeekEntry => ({ weekId: W, score: null, closed: true, ...e })
    const list = (skipped: boolean): MonthlyEntry => ({ score: skipped ? null : 80, closed: true, taskCount: 1, skipped })
    expect(isMonthPlayer({ weeks: [], monthly: null })).toBe(false)
    expect(isMonthPlayer({ weeks: [] })).toBe(false)
    expect(isMonthPlayer({ weeks: [week({ score: 50 })] })).toBe(true)
    expect(isMonthPlayer({ weeks: [week({ paused: true }), week({ skipped: true })], monthly: null })).toBe(false)
    expect(isMonthPlayer({ weeks: [week({ skipped: true }), week({ score: 0 })] })).toBe(true)
    expect(isMonthPlayer({ weeks: [week({ skipped: true })], monthly: list(true) })).toBe(false)
    expect(isMonthPlayer({ weeks: [week({ paused: true })], monthly: list(false) })).toBe(true)
    // A monthly entry from before batch 2.5 (no `skipped`) plays.
    expect(isMonthPlayer({ weeks: [], monthly: { score: 80, closed: true, taskCount: 1 } })).toBe(true)
  })
})

// ---------- With no cross-out, every result is batch 2's (SPEC §10.4, §10.11) ----------

describe('no cross-out: every result equals the frozen batch-2 scoring', () => {
  /** mulberry32: a small seeded generator, so a failure always replays. */
  function rng(seed: number): () => number {
    let a = seed
    return () => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const UIDS = ['a', 'b', 'c', 'd', 'e']
  /** Every value a stored mark can hold, including ones no client writes. */
  const VALUES: unknown[] = [1, 1, 1, 0.5, 0.5, 0, 'fair', 'fair', undefined, 2, 'Fair', null]
  const NEW_KEYS = new Set(['cancelledCount', 'excusedCount', 'skipped', 'cancel', 'fairBy', 'excused'])

  function strip(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(strip)
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !NEW_KEYS.has(k)).map(([k, x]) => [k, strip(x)]))
    return v
  }

  function fixture(rand: () => number) {
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]
    const some = (xs: readonly string[], p: number) => xs.filter(() => rand() < p)
    const memberIds = some(UIDS, 0.75)
    if (memberIds.length === 0) memberIds.push('a')
    const leftAt: Record<UID, number> = {}
    for (const uid of UIDS) if (!memberIds.includes(uid) && rand() < 0.6) leftAt[uid] = b.lockAt + (rand() < 0.5 ? -H : 2 * H)
    const sp: Space = { ...space(memberIds), leftAt }
    if (rand() < 0.3) sp.judges = some(UIDS, 0.3)
    return { sp, pick, some }
  }

  function period(rand: () => number, pick: <T>(xs: readonly T[]) => T, some: (xs: readonly string[], p: number) => string[], id: string, bounds: ReturnType<typeof weekBounds>) {
    const members = some(UIDS, 0.7)
    const plans: WeekData['plans'] = {}
    const progress: WeekData['progress'] = {}
    for (const uid of UIDS) {
      if (rand() < 0.15) continue
      const tasks: Task[] = Array.from({ length: Math.floor(rand() * 5) }, (_, i) => {
        const task: Task = { id: `${uid}${i + 1}`, title: `Task ${i + 1}` }
        if (rand() < 0.3) task.subtasks = Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, j) => ({ id: `${uid}${i + 1}s${j + 1}`, title: `Step ${j + 1}` }))
        if (rand() < 0.2) task.addedAt = bounds.lockAt + H
        // Crossed out, then restored (once or twice): no cross-out now.
        if (rand() < 0.2) task.cancel = { cancelled: false, changes: pick([2, 4]), at: bounds.lockAt + H, why: WHY }
        return task
      })
      plans[uid] = { uid, tasks, updatedAt: 0 }
      const ids = tasks.flatMap((t) => [t.id, ...(t.subtasks ?? []).map((s) => s.id)])
      progress[uid] = { uid, done: Object.fromEntries(some(ids, 0.6).map((x) => [x, rand() < 0.9])), updatedAt: 0 }
    }
    const reviews: Review[] = []
    for (let i = Math.floor(rand() * 14); i > 0; i--) {
      const reviewerId = pick(UIDS)
      const revieweeId = pick(UIDS)
      const marks: Record<string, ReviewMark> = {}
      for (const t of plans[revieweeId]?.tasks ?? []) {
        const v = pick(VALUES)
        if (v !== undefined) marks[t.id] = v as ReviewMark
      }
      if (rand() < 0.1) marks.unknown = 1
      reviews.push({ id: `${reviewerId}_${revieweeId}`, reviewerId, revieweeId, marks, submittedAt: 0 })
    }
    const doc = { id, spaceId: 's1', ...bounds, members, submittedBy: some(members, 0.6), judges: rand() < 0.3 ? some(members, 0.3) : undefined }
    if (doc.judges === undefined) delete doc.judges
    return { doc, plans, progress, reviews }
  }

  function expectNeutral(members: Record<UID, { judge?: boolean; cancelledCount?: number; excusedCount?: number; skipped?: boolean; tasks: { cancel?: TaskCancel }[] }>) {
    for (const m of Object.values(members)) {
      if (!m.judge) expect([m.cancelledCount, m.excusedCount, m.skipped]).toEqual([0, 0, false])
      for (const t of m.tasks) expect(['fairBy' in t, 'excused' in t, t.cancel?.cancelled ?? false]).toEqual([false, false, false])
    }
  }

  it('weeks and monthly lists: 600 random periods at every phase', () => {
    const rand = rng(20261017)
    for (let i = 0; i < 600; i++) {
      const { sp, pick, some } = fixture(rand)
      const nowMs = pick([b.lockAt - H, duringWeek, duringReview, b.deadlineAt - 1, afterDeadline])
      if (rand() < 0.25) sp.paused = { '2026-10': W }
      const w = period(rand, pick, some, W, b)
      const week: WeekData = { spaceId: 's1', weekId: W, week: rand() < 0.1 ? null : w.doc, plans: w.plans, progress: w.progress, reviews: w.reviews }
      const fresh = computeWeek(week, sp, nowMs)
      expect(strip(fresh), `week fixture ${i}`).toEqual(oracleWeek(week, sp, nowMs))
      expectNeutral(fresh.members)

      const lb = monthlyBounds('2026-10', (x) => weekBounds(x, TZ))
      const l = period(rand, pick, some, '2026-10', lb)
      const list: MonthlyData = { spaceId: 's1', monthId: '2026-10', monthly: { ...l.doc, judges: l.doc.judges ?? [] }, plans: l.plans, progress: l.progress, reviews: l.reviews }
      const listNow = pick([lb.lockAt + H, lb.reviewOpenAt + H, lb.deadlineAt - 1, lb.deadlineAt + H])
      const freshList = computeMonthly(list, sp, listNow)
      expect(strip(freshList), `list fixture ${i}`).toEqual(oracleMonthly(list, sp, listNow))
      expectNeutral(freshList.members)
    }
  })

  it('months: 200 random months of weeks and lists, with penalties, judges and pauses', () => {
    const rand = rng(42)
    const M = '2026-10'
    const ids = weekIdsInMonth(M)
    const lb = monthlyBounds(M, (x) => weekBounds(x, TZ))
    for (let i = 0; i < 200; i++) {
      const { sp, pick, some } = fixture(rand)
      if (rand() < 0.3) sp.paused = { [M]: pick(ids) }
      const weeks: WeekData[] = ids.map((weekId) => {
        const p = period(rand, pick, some, weekId, weekBounds(weekId, TZ))
        return { spaceId: 's1', weekId, week: rand() < 0.15 ? null : p.doc, plans: p.plans, progress: p.progress, reviews: p.reviews }
      })
      const l = period(rand, pick, some, M, lb)
      const list: MonthlyData | undefined =
        rand() < 0.2 ? undefined : { spaceId: 's1', monthId: M, monthly: { ...l.doc, judges: l.doc.judges ?? [] }, plans: l.plans, progress: l.progress, reviews: l.reviews }
      const nowMs = pick([weekBounds(ids[2], TZ).deadlineAt + H, lb.reviewOpenAt + H, lb.deadlineAt, lb.deadlineAt + 24 * H])
      const fresh = computeMonth(sp, M, weeks, nowMs, list)
      expect(strip(fresh), `month fixture ${i}`).toEqual(oracleMonth(sp, M, weeks, nowMs, list))
      for (const m of Object.values(fresh)) {
        expect(m.weeks.some((e) => 'skipped' in e)).toBe(false)
        if (m.monthly) expect(m.monthly.skipped).toBe(false)
      }
    }
  })
})
