// Short status copy for a week: the pill in the week view and the line on each space card.
import type { WeekResult } from '../../domain/scoring.ts'
import { formatCountdown } from '../../domain/time.ts'
import type { WeekBounds, WeekPhase } from '../../domain/time.ts'
import type { UID } from '../../domain/types.ts'
import type { IconName } from '../../ui/index.ts'

export interface StatusLine {
  text: string
  icon: IconName
  tone: 'default' | 'urgent' | 'done'
}

const HOUR = 3_600_000

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * The week's next deadline as a countdown, e.g. "Locks in 5h 12m". Once everyone has reviewed, the
 * deadline no longer matters. On Friday it is urgent only for someone who still owes reviews, and
 * alone in a week (nobody to review or wait for) it simply counts down to the results.
 */
export function phaseCountdown(
  phase: WeekPhase,
  bounds: WeekBounds,
  nowMs: number,
  revealed = false,
  review: { due: boolean; alone: boolean } = { due: true, alone: false },
): StatusLine {
  switch (phase) {
    case 'planning':
      return { text: `Locks in ${formatCountdown(bounds.lockAt - nowMs)}`, icon: 'lock', tone: bounds.lockAt - nowMs < 6 * HOUR ? 'urgent' : 'default' }
    case 'active':
      return { text: `Reviews open in ${formatCountdown(bounds.reviewOpenAt - nowMs)}`, icon: 'clock', tone: 'default' }
    case 'review':
      if (revealed) return { text: 'Results are in', icon: 'trophy', tone: 'done' }
      if (review.alone) return { text: `Results in ${formatCountdown(bounds.deadlineAt - nowMs)}`, icon: 'clock', tone: 'default' }
      return { text: `Reviews due in ${formatCountdown(bounds.deadlineAt - nowMs)}`, icon: 'clock', tone: review.due ? 'urgent' : 'default' }
    case 'closed':
      return { text: 'Closed', icon: 'lock', tone: 'default' }
  }
}

/** Members of `result` other than `uid` who are still in the space. */
export function stillIn(result: WeekResult, uid: UID, memberIds: UID[]): UID[] {
  return Object.values(result.members)
    .filter((m) => m.participating && m.uid !== uid && memberIds.includes(m.uid))
    .map((m) => m.uid)
}

/** Friends `uid` must review: participants still in the space with at least one task. */
export function reviewTargetsOf(result: WeekResult, uid: UID, memberIds: UID[]): UID[] {
  return stillIn(result, uid, memberIds).filter((id) => result.members[id].taskCount > 0)
}

export interface StatusContext {
  /** The space's current members (someone who left isn't waited for). */
  memberIds: UID[]
  /** Who counts for the week, `membersAt(space, lockAt)`: whom you review (someone who left after the lock still
   *  does, SPEC §9.6). Defaults to `memberIds`. */
  counted?: UID[]
  /** True when `uid` joined after this week's lock (as opposed to a week that started without them). */
  joinedLate: boolean
  /** Tasks on next week's list; only known on the weekend (null otherwise). */
  nextWeekTasks: number | null
  /** When next week's list locks, in words for a status line: "Mon", or "Mon 3:00 PM" on another clock. */
  nextLock: string
  /** Your part of the month's lists is open with friends to review (the month's last week, SPEC §9.5): a review
   *  is due even when this week is paused. */
  monthlyDue?: boolean
  /** A friend asks you to pause a week and your OK is needed: "Lena asks to pause next week" (SPEC §9.3). */
  pauseAsk?: string | null
  /** Next week is paused: it replaces the weekend's nudge to plan it. */
  nextPaused?: boolean
  /** You judge next week (the space's choice): nothing to plan on the weekend. */
  judgingNext?: boolean
  /** The month's verdict line, shown over the usual line (not over urgent ones or a paused week). */
  verdict?: StatusLine | null
  /** The schedule notice's line, "New times from next week", shown like the verdict. */
  notice?: string | null
}

/**
 * The one line that tells a member what matters in a space right now (SPEC §9.3 priorities): a review due (in a
 * paused week, the monthly lists' part) > a friend asking you to pause > an urgent plan for a week that isn't
 * paused > "Paused this week" > the verdict or the schedule notice > the usual line. A paused week never shows its
 * own plan, lock, "Nothing planned" or 0% lines.
 */
export function spaceStatus(result: WeekResult, bounds: WeekBounds, uid: UID, nowMs: number, ctx: StatusContext): StatusLine {
  const me = result.members[uid]
  const weeklyDue =
    result.phase === 'review' && !result.revealed && !result.paused && !!me?.participating && !me.hasSubmitted && reviewTargetsOf(result, uid, ctx.counted ?? ctx.memberIds).length > 0
  if (weeklyDue || (ctx.monthlyDue && result.phase === 'review')) return { text: `Review due in ${formatCountdown(bounds.deadlineAt - nowMs)}`, icon: 'clock', tone: 'urgent' }
  if (ctx.pauseAsk) return { text: ctx.pauseAsk, icon: 'pause', tone: 'urgent' }
  const usual = usualLine(result, bounds, uid, nowMs, ctx)
  if (usual.tone === 'urgent' || usual === PAUSED) return usual
  if (ctx.verdict) return ctx.verdict
  if (ctx.notice) return { text: ctx.notice, icon: 'clock', tone: 'default' }
  return usual
}

const PAUSED: StatusLine = { text: 'Paused this week', icon: 'pause', tone: 'default' }

/** The line for the week as it stands, with nothing else going on. */
function usualLine(result: WeekResult, bounds: WeekBounds, uid: UID, nowMs: number, ctx: StatusContext): StatusLine {
  const me = result.members[uid]
  const inWeek = me?.participating === true
  const judge = inWeek && me.judge === true
  const tasks = me?.taskCount ?? 0
  // A paused week has no plan, lock or score lines; once it's over the weekend looks ahead as usual.
  if (result.paused && result.phase !== 'closed') return PAUSED
  switch (result.phase) {
    case 'planning': {
      const left = formatCountdown(bounds.lockAt - nowMs)
      if (judge) return { text: `Judging this week · locks in ${left}`, icon: 'person2', tone: 'default' }
      const urgent = bounds.lockAt - nowMs < 12 * HOUR
      if (tasks === 0) return { text: `Plan your week · locks in ${left}`, icon: 'listBullet', tone: urgent ? 'urgent' : 'default' }
      return { text: `Locks in ${left} · ${plural(tasks, 'task')}`, icon: 'lock', tone: 'default' }
    }
    case 'active': {
      if (!inWeek) return { text: ctx.joinedLate ? 'You’re in from next week' : 'Sitting this week out', icon: 'calendar', tone: 'default' }
      if (judge) return { text: 'Judging this week', icon: 'person2', tone: 'default' }
      if (tasks === 0) return { text: 'Nothing planned this week', icon: 'xmark', tone: 'urgent' }
      const done = me.tasks.filter((t) => t.selfDone).length
      return { text: `${done} of ${tasks} done`, icon: done === tasks ? 'checkmark' : 'listBullet', tone: done === tasks ? 'done' : 'default' }
    }
    case 'review': {
      if (!inWeek) return { text: 'Friends are reviewing', icon: 'clock', tone: 'default' }
      if (result.revealed) return { text: 'Results are in', icon: 'trophy', tone: 'done' }
      const left = formatCountdown(bounds.deadlineAt - nowMs)
      if (!me.hasSubmitted) {
        // Nobody to review: no points at stake. With friends in the week, confirming unlocks the results early.
        if (stillIn(result, uid, ctx.memberIds).length > 0) return { text: 'Nothing to review · confirm', icon: 'checkmark', tone: 'default' }
        return { text: `Results in ${left}`, icon: 'clock', tone: 'default' }
      }
      const waiting = stillIn(result, uid, ctx.memberIds).filter((id) => !result.members[id].hasSubmitted).length
      if (waiting === 0) return { text: `Results in ${left}`, icon: 'clock', tone: 'default' }
      return { text: `Waiting for ${plural(waiting, 'review')}`, icon: 'clock', tone: 'default' }
    }
    case 'closed': {
      const next = nextWeekLine(ctx)
      if (inWeek && !result.paused) {
        if (ctx.nextWeekTasks === 0 && next.icon === 'listBullet') return { text: 'Results are in · Plan next week', icon: 'listBullet', tone: 'default' }
        return { text: 'Results are in', icon: 'trophy', tone: 'done' }
      }
      return next
    }
  }
}

/** The weekend's look ahead: next week paused, judged, planned, or still to plan. */
function nextWeekLine(ctx: StatusContext): StatusLine {
  if (ctx.nextPaused) return { text: 'Next week is paused', icon: 'pause', tone: 'default' }
  if (ctx.judgingNext) return { text: 'Judging next week', icon: 'person2', tone: 'default' }
  if (ctx.nextWeekTasks) return { text: `Next week: ${plural(ctx.nextWeekTasks, 'task')} · locks ${ctx.nextLock}`, icon: 'lock', tone: 'default' }
  return { text: `Plan next week · locks ${ctx.nextLock}`, icon: 'listBullet', tone: 'default' }
}
