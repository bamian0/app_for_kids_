// Pausing a week (SPEC §9.3). Everything lives on the space doc (`pause`, `paused`); the request's state is
// derived here. Pure; Node runs it in the reminders job.
import { monthIdForWeek } from './time.ts'
import type { MonthId, PauseRequest, Space, UID, WeekId } from './types.ts'

const HOUR_MS = 3_600_000

/** Each person can ask at most once every 12 hours, cancelled requests included. */
export const PAUSE_COOLDOWN_MS = 12 * HOUR_MS
/** The app offers to ask only while the week's reviews open more than a day from now: friends need time to
 *  answer (the rules allow asking until they open). */
export const PAUSE_ASK_LEAD_MS = 24 * HOUR_MS

/** The week arguments: its stored bounds and members when the doc is known, else boundsFor and the current
 *  members. */
export interface PauseWeek {
  members: UID[]
  reviewOpenAt: number
  deadlineAt: number
}

function monthOf(weekId: WeekId): MonthId | null {
  try {
    return monthIdForWeek(weekId)
  } catch {
    return null
  }
}

/** A week in `space.paused` (the month of its Friday → that week): nothing counts in it. */
export function isWeekPaused(space: Pick<Space, 'paused'>, weekId: WeekId): boolean {
  const monthId = monthOf(weekId)
  return monthId !== null && space.paused?.[monthId] === weekId
}

/** The month's paused week, or null. */
export function pausedWeekOf(space: Pick<Space, 'paused'>, monthId: MonthId): WeekId | null {
  return space.paused?.[monthId] ?? null
}

/** Who must say OK: everyone in the week who is still in the space (judges too). */
export function pauseNeeded(memberIds: UID[], weekMembers: UID[]): UID[] {
  return [...new Set(weekMembers)].filter((uid) => memberIds.includes(uid))
}

/** Every needed member said OK. */
export function pauseCompletes(oks: UID[], memberIds: UID[], weekMembers: UID[]): boolean {
  return pauseNeeded(memberIds, weekMembers).every((uid) => oks.includes(uid))
}

function isRecorded(space: Pick<Space, 'paused'>, request: PauseRequest): boolean {
  return isWeekPaused(space, request.weekId)
}

/** The request is over for asking again: none, declined or cancelled, recorded, or past its week's review
 *  opening. */
function isLive(space: Pick<Space, 'paused'>, request: PauseRequest, nowMs: number, reviewOpenAt: number): boolean {
  return !request.declinedBy && !isRecorded(space, request) && nowMs < reviewOpenAt
}

export type PauseView =
  | { kind: 'none' }
  | { kind: 'pending'; request: PauseRequest; waitingFor: UID[]; me: 'asked' | 'said-ok' | 'to-answer' | 'not-asked' }
  | { kind: 'declined'; request: PauseRequest; by: UID }
  | { kind: 'paused'; weekId: WeekId }
  | { kind: 'lapsed'; request: PauseRequest; waitingFor: UID[] }

/**
 * What the request in play means for `me` now (SPEC §9.3). `week` is the request's week. Recorded: 'paused' until
 * that week's deadline. Cancelled by the asker: 'none'. Declined: until that week's reviews open. Not recorded
 * once its reviews opened: 'lapsed' until its deadline (`waitingFor` = who never said OK). Else 'pending', with
 * `me` 'asked', 'said-ok', 'to-answer' (needed and not yet OK'd) or 'not-asked' (not in the week, e.g. joined
 * after its lock). `waitingFor` = needed members not in `oks`, in the week's order.
 */
export function pauseView(space: Pick<Space, 'pause' | 'paused' | 'memberIds'>, me: UID, nowMs: number, week: PauseWeek): PauseView {
  const request = space.pause
  if (!request) return { kind: 'none' }
  if (isRecorded(space, request)) return nowMs < week.deadlineAt ? { kind: 'paused', weekId: request.weekId } : { kind: 'none' }
  if (request.declinedBy === request.by) return { kind: 'none' }
  if (request.declinedBy) return nowMs < week.reviewOpenAt ? { kind: 'declined', request, by: request.declinedBy } : { kind: 'none' }
  const needed = pauseNeeded(space.memberIds, week.members)
  const waitingFor = needed.filter((uid) => !request.oks.includes(uid))
  if (nowMs >= week.reviewOpenAt) return nowMs < week.deadlineAt ? { kind: 'lapsed', request, waitingFor } : { kind: 'none' }
  const role = request.by === me ? 'asked' : request.oks.includes(me) ? 'said-ok' : needed.includes(me) ? 'to-answer' : 'not-asked'
  return { kind: 'pending', request, waitingFor, me: role }
}

export type PauseChoice = 'ok' | 'too-late' | 'reviews-open' | 'month-used' | 'request-pending' | 'cooldown'

/**
 * Whether `me` can ask to pause this week and next week now, each with the first reason it can't, in this
 * order: 'reviews-open' (its reviews have opened), 'month-used' (the month of its Friday has its pause),
 * 'request-pending' (a request is waiting for answers), 'cooldown' (I asked within 12 hours, cancelled requests
 * included), 'too-late' (its reviews open in 24 hours or less), else 'ok'. The weeks give their stored
 * `reviewOpenAt` when the doc is known, else computed (boundsFor).
 */
export function pauseChoices(
  space: Pick<Space, 'pause' | 'paused'>,
  me: UID,
  nowMs: number,
  weeks: { thisWeek: { id: WeekId; reviewOpenAt: number }; nextWeek: { id: WeekId; reviewOpenAt: number } },
): { thisWeek: PauseChoice; nextWeek: PauseChoice } {
  const request = space.pause
  let pending = false
  if (request) {
    const known = [weeks.thisWeek, weeks.nextWeek].find((w) => w.id === request.weekId)
    // A request for an earlier week has lapsed (its reviews opened before this week began); a later one can't
    // exist (asks are for this or next week) and counts as live.
    const reviewOpenAt = known ? known.reviewOpenAt : request.weekId < weeks.thisWeek.id ? -Infinity : Infinity
    pending = isLive(space, request, nowMs, reviewOpenAt)
  }
  const cooldown = !!request && request.by === me && nowMs < request.at + PAUSE_COOLDOWN_MS
  const choice = (week: { id: WeekId; reviewOpenAt: number }): PauseChoice => {
    if (nowMs >= week.reviewOpenAt) return 'reviews-open'
    const monthId = monthOf(week.id)
    if (monthId !== null && space.paused?.[monthId] !== undefined) return 'month-used'
    if (pending) return 'request-pending'
    if (cooldown) return 'cooldown'
    if (week.reviewOpenAt - nowMs <= PAUSE_ASK_LEAD_MS) return 'too-late'
    return 'ok'
  }
  return { thisWeek: choice(weeks.thisWeek), nextWeek: choice(weeks.nextWeek) }
}

/**
 * A request that everyone still in the week has OK'd but nobody recorded (the last holdout left): ensureSpace
 * records it (the rules' finalizesPause). `week` is the request's week.
 */
export function pauseNeedsFinalizing(space: Pick<Space, 'pause' | 'paused' | 'memberIds'>, nowMs: number, week: Pick<PauseWeek, 'members' | 'reviewOpenAt'>): boolean {
  const request = space.pause
  if (!request || request.declinedBy || nowMs >= week.reviewOpenAt) return false
  const monthId = monthOf(request.weekId)
  if (monthId === null || space.paused?.[monthId] !== undefined) return false
  return pauseCompletes(request.oks, space.memberIds, week.members)
}
