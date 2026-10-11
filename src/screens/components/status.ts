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

/** The week's next deadline as a countdown, e.g. "Locks in 5h 12m". Once everyone has reviewed, the deadline no longer matters. */
export function phaseCountdown(phase: WeekPhase, bounds: WeekBounds, nowMs: number, revealed = false): StatusLine {
  switch (phase) {
    case 'planning':
      return { text: `Locks in ${formatCountdown(bounds.lockAt - nowMs)}`, icon: 'lock', tone: bounds.lockAt - nowMs < 6 * HOUR ? 'urgent' : 'default' }
    case 'active':
      return { text: `Reviews open in ${formatCountdown(bounds.reviewOpenAt - nowMs)}`, icon: 'clock', tone: 'default' }
    case 'review':
      if (revealed) return { text: 'Results are in', icon: 'trophy', tone: 'done' }
      return { text: `Reviews due in ${formatCountdown(bounds.deadlineAt - nowMs)}`, icon: 'clock', tone: 'urgent' }
    case 'closed':
      return { text: 'Closed', icon: 'lock', tone: 'default' }
  }
}

/**
 * The one line that tells a member what matters in a space right now.
 * `nextWeekTasks` is only known on the weekend (null otherwise): it adds the nudge to plan ahead.
 */
export function spaceStatus(result: WeekResult, bounds: WeekBounds, uid: UID, nowMs: number, nextWeekTasks: number | null): StatusLine {
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
      if (!inWeek) return { text: 'You’re in from next week', icon: 'calendar', tone: 'default' }
      if (tasks === 0) return { text: 'Nothing planned this week', icon: 'xmark', tone: 'urgent' }
      const done = me.tasks.filter((t) => t.selfDone).length
      return { text: `${done} of ${tasks} done`, icon: done === tasks ? 'checkmark' : 'listBullet', tone: done === tasks ? 'done' : 'default' }
    }
    case 'review': {
      if (!inWeek) return { text: 'Friends are reviewing', icon: 'clock', tone: 'default' }
      if (!me.hasSubmitted) return { text: `Review due in ${formatCountdown(bounds.deadlineAt - nowMs)}`, icon: 'clock', tone: 'urgent' }
      if (!result.revealed) {
        const waiting = Object.values(result.members).filter((m) => m.participating && !m.hasSubmitted).length
        return { text: `Waiting for ${plural(waiting, 'review')}`, icon: 'clock', tone: 'default' }
      }
      return { text: 'Results are in', icon: 'trophy', tone: 'done' }
    }
    case 'closed': {
      const base = inWeek ? 'Results are in' : 'Week closed'
      if (nextWeekTasks === 0) return { text: `${base} · Plan next week`, icon: 'listBullet', tone: 'default' }
      return { text: base, icon: inWeek ? 'trophy' : 'lock', tone: inWeek ? 'done' : 'default' }
    }
  }
}
