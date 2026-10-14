import { describe, expect, it } from 'vitest'
import { addedAfterLock, computeMonth, computeWeek, isRevealed, isTaskDone, joinedAfterLock, membersAt, reviewTargets, taskSelfFraction } from './scoring.ts'
import { monthCompleteAt, weekBounds } from './time.ts'
import type { Mark, Review, Space, Task, UID, WeekData, WeekId } from './types.ts'

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
