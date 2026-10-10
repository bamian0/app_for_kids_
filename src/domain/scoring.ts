// Weekly and monthly scoring. See docs/SPEC.md §1 for the rules.
// STUB: signatures are the contract; the domain agent implements the bodies.
import type { Mark, MonthId, Space, UID, WeekData, WeekId } from './types.ts'
import type { WeekPhase } from './time.ts'

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

/** Revealed when every member has submitted, or at deadlineAt. */
export function isRevealed(week: { members: UID[]; submittedBy: UID[]; deadlineAt: number }, nowMs: number): boolean {
  throw new Error(`not implemented ${week} ${nowMs}`)
}

/** Members `uid` must review this week: other participants with ≥1 task. */
export function reviewTargets(data: WeekData, uid: UID): UID[] {
  throw new Error(`not implemented ${data} ${uid}`)
}

export function computeWeek(data: WeekData, space: Space, nowMs: number): WeekResult {
  throw new Error(`not implemented ${data} ${space} ${nowMs}`)
}

export function computeMonth(space: Space, monthId: MonthId, weeks: WeekData[], nowMs: number): Record<UID, MemberMonthResult> {
  throw new Error(`not implemented ${space} ${monthId} ${weeks} ${nowMs}`)
}
