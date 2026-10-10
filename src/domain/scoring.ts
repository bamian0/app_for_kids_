// Weekly and monthly scoring. See docs/SPEC.md §1 for the rules.
import type { Mark, MonthId, Review, Space, UID, WeekData, WeekId } from './types.ts'
import type { WeekBounds, WeekPhase } from './time.ts'
import { monthCompleteAt, weekBounds, weekIdsInMonth, weekPhase } from './time.ts'

export interface TaskResult {
  taskId: string
  title: string
  /** 0..1, the value that counts toward the score. */
  mark: number
  /** Where `mark` came from: friends' reviews, or the member's own check-off (nobody reviewed). */
  source: 'reviews' | 'self'
  reviewerMarks: Record<UID, Mark>
  selfDone: boolean
}

export interface MemberWeekResult {
  uid: UID
  participating: boolean
  taskCount: number
  tasks: TaskResult[]
  /** 0..100 from self check-offs; shown before reveal, labelled provisional. null if not participating. */
  provisionalScore: number | null
  /** 0..100 once revealed; null before reveal or if not participating. */
  score: number | null
  /** Reviewers who submitted a review of this member (visible to the current user). */
  reviewedBy: UID[]
  /** After deadlineAt: members with ≥1 task this member failed to review. Empty before. */
  missedReviewsOf: UID[]
  hasSubmitted: boolean
}

export interface WeekResult {
  weekId: WeekId
  phase: WeekPhase
  revealed: boolean
  members: Record<UID, MemberWeekResult>
}

export interface MemberMonthResult {
  uid: UID
  monthId: MonthId
  weeks: { weekId: WeekId; score: number | null; closed: boolean }[]
  /** Mean of closed participating weeks; null if none. */
  average: number | null
  missedReviews: number
  penaltyPoints: number
  /** max(0, average − penaltyPoints); null if average is null. */
  finalScore: number | null
  /** now ≥ monthCompleteAt. */
  complete: boolean
  /** finalScore ≥ threshold once complete; null until complete or if finalScore is null. */
  passed: boolean | null
}

/** Keeps the ≥ threshold check from failing on float error in means of thirds, sevenths, etc. */
const SCORE_EPSILON = 1e-9

/** Revealed when every member has submitted, or at deadlineAt. */
export function isRevealed(week: { members: UID[]; submittedBy: UID[]; deadlineAt: number }, nowMs: number): boolean {
  return nowMs >= week.deadlineAt || week.members.every((uid) => week.submittedBy.includes(uid))
}

function participantsOf(data: WeekData): UID[] {
  return data.week ? [...new Set(data.week.members)] : []
}

function tasksOf(data: WeekData, uid: UID) {
  return data.plans[uid]?.tasks ?? []
}

/** Members `uid` must review this week: other participants with ≥1 task. */
export function reviewTargets(data: WeekData, uid: UID): UID[] {
  const members = participantsOf(data)
  if (!members.includes(uid)) return []
  return members.filter((m) => m !== uid && tasksOf(data, m).length > 0)
}

function isMark(value: unknown): value is Mark {
  return value === 0 || value === 0.5 || value === 1
}

/** Reviews between two distinct participants, at most one per reviewer→reviewee pair. */
function validReviews(data: WeekData, members: UID[]): Review[] {
  const seen = new Set<string>()
  return data.reviews.filter((r) => {
    const key = `${r.reviewerId}_${r.revieweeId}`
    const ok = r.reviewerId !== r.revieweeId && members.includes(r.reviewerId) && members.includes(r.revieweeId) && !seen.has(key)
    seen.add(key)
    return ok
  })
}

function emptyResult(uid: UID): MemberWeekResult {
  return {
    uid,
    participating: false,
    taskCount: 0,
    tasks: [],
    provisionalScore: null,
    score: null,
    reviewedBy: [],
    missedReviewsOf: [],
    hasSubmitted: false,
  }
}

/**
 * Results for every week participant, plus a non-participating entry for each space member
 * who is not in the week (e.g. joined after lock). Before reveal `score` is null; `tasks[].mark`
 * always reflects the reviews visible to the caller, falling back to self check-offs.
 */
export function computeWeek(data: WeekData, space: Space, nowMs: number): WeekResult {
  const week = data.week
  const bounds: WeekBounds = week ?? weekBounds(data.weekId, space.timezone)
  const revealed = week ? isRevealed(week, nowMs) : nowMs >= bounds.deadlineAt
  const pastDeadline = nowMs >= bounds.deadlineAt
  const members = participantsOf(data)
  const reviews = validReviews(data, members)

  const results: Record<UID, MemberWeekResult> = {}
  for (const uid of space.memberIds) results[uid] = emptyResult(uid)

  for (const uid of members) {
    const plan = tasksOf(data, uid)
    const done = data.progress[uid]?.done ?? {}
    const received = reviews.filter((r) => r.revieweeId === uid)
    const reviewedBy = received.map((r) => r.reviewerId)
    const fromReviews = received.length > 0

    let selfSum = 0
    let markSum = 0
    const tasks: TaskResult[] = plan.map((task) => {
      const selfDone = done[task.id] === true
      const reviewerMarks: Record<UID, Mark> = {}
      let reviewSum = 0
      for (const r of received) {
        // A submitted review that skips a task gives it 0.
        const mark = isMark(r.marks[task.id]) ? r.marks[task.id] : 0
        reviewerMarks[r.reviewerId] = mark
        reviewSum += mark
      }
      const selfMark = selfDone ? 1 : 0
      selfSum += selfMark
      markSum += fromReviews ? reviewSum : selfMark
      return {
        taskId: task.id,
        title: task.title,
        mark: fromReviews ? reviewSum / received.length : selfMark,
        source: fromReviews ? 'reviews' : 'self',
        reviewerMarks,
        selfDone,
      }
    })

    const n = plan.length
    // Divide once (sum over tasks and reviewers of half-point marks is exact) to keep float error minimal.
    const score = n === 0 ? 0 : (100 * markSum) / (n * (fromReviews ? received.length : 1))
    const missedReviewsOf = pastDeadline
      ? reviewTargets(data, uid).filter((target) => !reviews.some((r) => r.reviewerId === uid && r.revieweeId === target))
      : []

    results[uid] = {
      uid,
      participating: true,
      taskCount: n,
      tasks,
      provisionalScore: n === 0 ? 0 : (100 * selfSum) / n,
      score: revealed ? score : null,
      reviewedBy,
      missedReviewsOf,
      hasSubmitted: week?.submittedBy.includes(uid) ?? false,
    }
  }

  return { weekId: data.weekId, phase: weekPhase(bounds, nowMs), revealed, members: results }
}

/**
 * Month results for every current space member. `weeks` lists only the weeks in which the member
 * participated (weeks without a doc, or outside the month, are ignored); `score` there is the
 * revealed score, so it can be non-null before the week closes when everyone submitted early.
 */
export function computeMonth(space: Space, monthId: MonthId, weeks: WeekData[], nowMs: number): Record<UID, MemberMonthResult> {
  const inMonth = new Set(weekIdsInMonth(monthId))
  const computed = weeks
    .flatMap((d) => (d.week && inMonth.has(d.weekId) ? [{ weekId: d.weekId, closed: nowMs >= d.week.deadlineAt, result: computeWeek(d, space, nowMs) }] : []))
    .sort((a, b) => (a.weekId < b.weekId ? -1 : a.weekId > b.weekId ? 1 : 0))
  const complete = nowMs >= monthCompleteAt(monthId, space.timezone)

  const out: Record<UID, MemberMonthResult> = {}
  for (const uid of space.memberIds) {
    const entries: MemberMonthResult['weeks'] = []
    const closedScores: number[] = []
    let missedReviews = 0
    for (const { weekId, closed, result } of computed) {
      const member = result.members[uid]
      if (!member?.participating) continue
      entries.push({ weekId, score: member.score, closed })
      if (closed && member.score !== null) {
        closedScores.push(member.score)
        missedReviews += member.missedReviewsOf.length
      }
    }
    const average = closedScores.length > 0 ? closedScores.reduce((a, b) => a + b, 0) / closedScores.length : null
    const penaltyPoints = space.latePenalty * missedReviews
    const finalScore = average === null ? null : Math.max(0, average - penaltyPoints)
    out[uid] = {
      uid,
      monthId,
      weeks: entries,
      average,
      missedReviews,
      penaltyPoints,
      finalScore,
      complete,
      passed: complete && finalScore !== null ? finalScore >= space.threshold - SCORE_EPSILON : null,
    }
  }
  return out
}
