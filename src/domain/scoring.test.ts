import { describe, expect, it } from 'vitest'
import { computeMonth, computeWeek, isRevealed, joinedAfterLock, membersAt, reviewTargets } from './scoring.ts'
import { monthCompleteAt, weekBounds } from './time.ts'
import type { Mark, Review, Space, UID, WeekData, WeekId } from './types.ts'

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
  it('with the current members, someone who left does not hold the reveal back', () => {
    const three = { members: ['a', 'b', 'c'], submittedBy: ['a', 'b'], deadlineAt: b.deadlineAt }
    expect(isRevealed(three, duringReview)).toBe(false)
    expect(isRevealed(three, duringReview, ['a', 'b', 'c'])).toBe(false)
    expect(isRevealed(three, duringReview, ['a', 'b', 'd'])).toBe(true)
    // Everyone left: nothing to wait for.
    expect(isRevealed({ ...three, submittedBy: [] }, duringReview, ['z'])).toBe(true)
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
  it('with the current members, skips participants who left the space', () => {
    expect(reviewTargets(data, 'c', ['a', 'c', 'd'])).toEqual(['a'])
    expect(reviewTargets(data, 'd', ['c', 'd'])).toEqual([])
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

  it('a participant who left mid-week: nobody must review them, the reveal and penalties ignore them', () => {
    // c planned, then left the space on Wednesday; a and b reviewed each other only.
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
    const sp = space(['a', 'b'])
    expect(reviewTargets(data, 'a', sp.memberIds)).toEqual(['b'])
    expect(computeWeek(data, sp, duringReview).revealed).toBe(true)
    const r = computeWeek(data, sp, afterDeadline)
    expect(r.members.a.missedReviewsOf).toEqual([])
    expect(r.members.b.missedReviewsOf).toEqual([])
    // Still a participant of the week, scored on their own check-offs (nobody reviewed them), and
    // charged for the reviews they no longer can write.
    expect(r.members.c).toMatchObject({ participating: true, score: 100, reviewedBy: [], missedReviewsOf: ['a', 'b'] })
  })

  it('someone who left after the deadline still counts for that week: their leaving never rewrites it', () => {
    const data = weekData(W, { members: ['a', 'b', 'c'], tasks: { a: 1, b: 1, c: 1 }, reviews: [['a', 'b', [1]], ['b', 'a', [1]]], submittedBy: ['a', 'b'] })
    const leftLater = { ...space(['a', 'b']), leftAt: { c: b.deadlineAt + 2 * H } }
    const leftEarly = { ...space(['a', 'b']), leftAt: { c: b.deadlineAt - 2 * H } }
    expect(computeWeek(data, leftLater, afterDeadline).members.a.missedReviewsOf).toEqual(['c'])
    expect(computeWeek(data, leftEarly, afterDeadline).members.a.missedReviewsOf).toEqual([])
    // During the review window nobody has "left later" yet, so c doesn't hold the reveal back.
    expect(computeWeek(data, { ...space(['a', 'b']), leftAt: { c: b.lockAt } }, duringReview).revealed).toBe(true)
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
    })
  })

  it('reports current members plus everyone who played the month, and ignores weeks from other months', () => {
    const weeks = [
      weekData('2026-11-02', { members: ['a', 'b'], tasks: { a: 1, b: 1 } }),
      weekData('2026-10-05', { members: ['a', 'z'], tasks: { a: 2, z: 1 }, done: { a: 1, z: 1 }, reviews: [['z', 'a', [1, 1]]], submittedBy: ['z'] }),
    ]
    const res = computeMonth(space(['a', 'n']), M, weeks, complete)
    expect(Object.keys(res).sort()).toEqual(['a', 'n', 'z'])
    expect(res.a.weeks).toEqual([{ weekId: '2026-10-05', score: 100, closed: true }])
    // z has left the space, so a not reviewing z costs nothing.
    expect(res.a).toMatchObject({ former: false, others: ['z'], missedReviews: 0, finalScore: 100, passed: true })
    expect(res.z).toMatchObject({ former: true, others: ['a'], weeks: [{ weekId: '2026-10-05', score: 100, closed: true }], finalScore: 100 })
    // n is a member who played no week of October: listed, but nobody owes n or is owed by n.
    expect(res.n).toMatchObject({ former: false, others: ['a', 'z'], weeks: [], finalScore: null, passed: null })
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
  it('counts current members plus anyone who left at or after the instant', () => {
    const sp = { memberIds: ['a', 'b'], leftAt: { c: 100, d: 50, b: 10 } }
    expect(membersAt(sp, 100)).toEqual(['a', 'b', 'c'])
    expect(membersAt(sp, 101)).toEqual(['a', 'b'])
    expect(membersAt({ memberIds: ['a'] }, 0)).toEqual(['a'])
  })

  it('tells a late joiner from a member without tasks', () => {
    const sp = { joinedAt: { early: b.lockAt - 1, late: b.lockAt } }
    expect(joinedAfterLock(sp, 'early', b.lockAt)).toBe(false)
    expect(joinedAfterLock(sp, 'late', b.lockAt)).toBe(true)
    expect(joinedAfterLock(sp, 'gone', b.lockAt)).toBe(false)
  })
})
