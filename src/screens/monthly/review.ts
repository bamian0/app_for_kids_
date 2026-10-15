// Who you review right now, in the two parts of a month's last week (SPEC §9.5): this week's lists and the
// month's lists. One pure helper for the Space screen's toolbar and the review sheet, so they always agree.
import { isWeekPaused } from '../../domain/pause.ts'
import { membersAt, reviewTargets } from '../../domain/scoring.ts'
import type { MonthlyData, Space, UID, Week, WeekData } from '../../domain/types.ts'

export interface ReviewPart {
  /** Your reviews for this part are due now: you're in it and still in the space, you haven't submitted, it
   *  isn't paused, and its review window is open. */
  open: boolean
  /** Whom you review in it (empty unless open): friends with ≥ 1 task who count for it,
   *  `membersAt(space, period.lockAt)` (someone who left after the lock still does), never its judges. */
  targets: UID[]
}

export interface ReviewParts {
  weekly: ReviewPart
  monthly: ReviewPart
  /** Everyone to review in either part, once each, in the periods' members order. */
  people: UID[]
  /** A part is open with nobody to review in it, nobody to review anywhere, and a friend still in the space waits
   *  on it: confirming (an empty submit) lets its results come in early. */
  confirm: boolean
}

const CLOSED: ReviewPart = Object.freeze({ open: false, targets: [] as UID[] }) as ReviewPart

type Reviewable = Pick<Space, 'memberIds' | 'leftAt' | 'joinedAt'>

function partOf(period: Week | null, data: WeekData | MonthlyData, me: UID, space: Reviewable, nowMs: number): ReviewPart {
  if (!period) return CLOSED
  if (!period.members.includes(me) || period.submittedBy.includes(me) || !space.memberIds.includes(me)) return CLOSED
  if (nowMs < period.reviewOpenAt || nowMs >= period.deadlineAt) return CLOSED
  return { open: true, targets: reviewTargets(data, me, membersAt(space, period.lockAt)) }
}

/**
 * Your two review parts now: this week's (`week`, when loaded) and the month's lists (`monthly`, in the month's
 * last week; undefined otherwise or while loading). A paused week has no weekly part; its monthly part still
 * opens. A missing week doc has none either.
 */
export function reviewParts(
  week: WeekData | undefined,
  monthly: MonthlyData | undefined,
  me: UID,
  space: Reviewable & Pick<Space, 'paused'>,
  nowMs: number,
): ReviewParts {
  const weekly = week && !isWeekPaused(space, week.weekId) ? partOf(week.week, week, me, space, nowMs) : CLOSED
  const list = monthly ? partOf(monthly.monthly, monthly, me, space, nowMs) : CLOSED
  const order = [...(week?.week?.members ?? []), ...(monthly?.monthly?.members ?? [])]
  const wanted = new Set([...weekly.targets, ...list.targets])
  const people = [...new Set(order)].filter((id) => wanted.has(id))
  const waiting = [
    ...(weekly.open ? (week?.week?.members ?? []) : []),
    ...(list.open ? (monthly?.monthly?.members ?? []) : []),
  ].some((id) => id !== me && space.memberIds.includes(id))
  return { weekly, monthly: list, people, confirm: people.length === 0 && (weekly.open || list.open) && waiting }
}
