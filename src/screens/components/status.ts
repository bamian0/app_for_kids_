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
  /** The space's current members (someone who left isn't waited for or reviewed). */
  memberIds: UID[]
  /** True when `uid` joined after this week's lock (as opposed to a week that started without them). */
  joinedLate: boolean
  /** Tasks on next week's list; only known on the weekend (null otherwise). */
  nextWeekTasks: number | null
  /** When next week's list locks, in words for a status line: "Mon", or "Mon 3:00 PM" on another clock. */
  nextLock: string
}

/** The one line that tells a member what matters in a space right now. */
export function spaceStatus(result: WeekResult, bounds: WeekBounds, uid: UID, nowMs: number, ctx: StatusContext): StatusLine {
  const me = result.members[uid]
  const inWeek = me?.participating === true
  const tasks = me?.taskCount ?? 0
  switch (result.phase) {
    case 'planning': {
      const left = formatCountdown(bounds.lockAt - nowMs)
      const urgent = bounds.lockAt - nowMs < 12 * HOUR
      if (tasks === 0) return { text: `Plan your week · locks in ${left}`, icon: 'listBullet', tone: urgent ? 'urgent' : 'default' }
      return { text: `Locks in ${left} · ${plural(tasks, 'task')}`, icon: 'lock', tone: 'default' }
    }
    case 'active': {
      if (!inWeek) return { text: ctx.joinedLate ? 'You’re in from next week' : 'Sitting this week out', icon: 'calendar', tone: 'default' }
      if (tasks === 0) return { text: 'Nothing planned this week', icon: 'xmark', tone: 'urgent' }
      const done = me.tasks.filter((t) => t.selfDone).length
      return { text: `${done} of ${tasks} done`, icon: done === tasks ? 'checkmark' : 'listBullet', tone: done === tasks ? 'done' : 'default' }
    }
    case 'review': {
      if (!inWeek) return { text: 'Friends are reviewing', icon: 'clock', tone: 'default' }
      if (result.revealed) return { text: 'Results are in', icon: 'trophy', tone: 'done' }
      const left = formatCountdown(bounds.deadlineAt - nowMs)
      if (!me.hasSubmitted) {
        if (reviewTargetsOf(result, uid, ctx.memberIds).length > 0) return { text: `Review due in ${left}`, icon: 'clock', tone: 'urgent' }
        // Nobody to review: no points at stake. With friends in the week, confirming unlocks the results early.
        if (stillIn(result, uid, ctx.memberIds).length > 0) return { text: 'Nothing to review · confirm', icon: 'checkmark', tone: 'default' }
        return { text: `Results in ${left}`, icon: 'clock', tone: 'default' }
      }
      const waiting = stillIn(result, uid, ctx.memberIds).filter((id) => !result.members[id].hasSubmitted).length
      return { text: `Waiting for ${plural(waiting, 'review')}`, icon: 'clock', tone: 'default' }
    }
    case 'closed': {
      if (inWeek) {
        if (ctx.nextWeekTasks === 0) return { text: 'Results are in · Plan next week', icon: 'listBullet', tone: 'default' }
        return { text: 'Results are in', icon: 'trophy', tone: 'done' }
      }
      if (ctx.nextWeekTasks) return { text: `Next week: ${plural(ctx.nextWeekTasks, 'task')} · locks ${ctx.nextLock}`, icon: 'lock', tone: 'default' }
      return { text: `Plan next week · locks ${ctx.nextLock}`, icon: 'listBullet', tone: 'default' }
    }
  }
}
