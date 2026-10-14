// A space's own times (SPEC §9.2): validation, the words for them, and when a change starts. Pure; Node runs it
// in the reminders job.
import { addWeeks, DEFAULT_SCHEDULE, weekBounds, weekIdFor, WEEK_MINUTES, type WeekBounds } from './time.ts'
import type { Space, Week, WeekId, WeekSchedule } from './types.ts'

const HOUR_MS = 3_600_000
const DAY_MINUTES = 1440

/** A change of times needs a day's notice: it starts with the first week whose lists lock at least this far
 *  away on both its current times and the new ones. Weeks are retimed only under the same notice. */
export const RETIME_NOTICE_MS = 24 * HOUR_MS

/** The shortest review window, in minutes (3 hours). */
export const MIN_REVIEW_MINUTES = 180

/** The schedule a space or week follows: its own, else the usual one. */
export function scheduleOf(x: { schedule?: WeekSchedule } | null | undefined): WeekSchedule {
  return x?.schedule ?? DEFAULT_SCHEDULE
}

/** Equal by effective values (absent = the usual times). */
export function sameSchedule(a?: WeekSchedule | null, b?: WeekSchedule | null): boolean {
  const x = a ?? DEFAULT_SCHEDULE
  const y = b ?? DEFAULT_SCHEDULE
  return x.lock === y.lock && x.reviewOpen === y.reviewOpen && x.deadline === y.deadline
}

export function isUsualSchedule(s?: WeekSchedule | null): boolean {
  return sameSchedule(s, DEFAULT_SCHEDULE)
}

export type ScheduleProblem = 'shape' | 'order' | 'window' | 'range'

/**
 * null when the rules accept the schedule: ints with 0 ≤ lock < reviewOpen and
 * reviewOpen + 180 ≤ deadline ≤ 10080. Else why not: 'shape' (not three ints, or a lock before the week starts),
 * 'order' (lists lock at or after reviews open), 'window' (reviews shorter than 3 hours), 'range' (due after
 * Sunday at midnight).
 */
export function scheduleProblem(s: unknown): ScheduleProblem | null {
  if (typeof s !== 'object' || s === null) return 'shape'
  const { lock, reviewOpen, deadline } = s as Record<string, unknown>
  if (!Number.isInteger(lock) || !Number.isInteger(reviewOpen) || !Number.isInteger(deadline)) return 'shape'
  const l = lock as number
  const r = reviewOpen as number
  const d = deadline as number
  if (l < 0) return 'shape'
  if (l >= r) return 'order'
  if (r + MIN_REVIEW_MINUTES > d) return 'window'
  if (d > WEEK_MINUTES) return 'range'
  return null
}

const MIDNIGHT_HINT = ' Midnight is the end of the day you pick.'

/** What the Schedule screen's footer (and the data layer's error) says about a problem. For order and window,
 *  when one of `s`'s moments is a midnight, it adds that midnight is the end of the day picked. */
export function scheduleProblemText(p: ScheduleProblem, s?: WeekSchedule | null): string {
  const hasMidnight = !!s && [s.lock, s.reviewOpen, s.deadline].some((m) => Number.isInteger(m) && m % DAY_MINUTES === 0)
  switch (p) {
    case 'order':
      return `Lists have to lock before reviews open.${hasMidnight ? MIDNIGHT_HINT : ''}`
    case 'window':
      return `Give reviews at least 3 hours.${hasMidnight ? MIDNIGHT_HINT : ''}`
    case 'range':
      return 'Reviews have to be due by Sunday at midnight.'
    case 'shape':
      return 'Those times don’t work. Pick them again.'
  }
}

/**
 * A moment as picker parts: the day it falls on, Monday = 0 … Sunday = 6, and a time of day in (0, 1440], where
 * 1440 is midnight, the end of that day. m = 0 (the start of Monday) is { day: −1, time: 1440 }: Sunday at
 * midnight, the end of the week before.
 */
export function splitMoment(m: number): { day: number; time: number } {
  const day = Math.ceil(m / DAY_MINUTES) - 1
  return { day, time: m - day * DAY_MINUTES }
}

export function joinMoment(day: number, time: number): number {
  return day * DAY_MINUTES + time
}

export type HourCycle = 'h12' | 'h23'

/** "Midnight", "Noon", "6:00 PM" (h12, the default) or "18:00" (h23). 0 and 1440 are both midnight. */
export function timeLabel(minuteOfDay: number, hourCycle: HourCycle = 'h12'): string {
  const m = ((Math.round(minuteOfDay) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES
  if (m === 0) return 'Midnight'
  if (m === 720) return 'Noon'
  const hour = Math.floor(m / 60)
  const minute = String(m % 60).padStart(2, '0')
  if (hourCycle === 'h23') return `${String(hour).padStart(2, '0')}:${minute}`
  return `${hour % 12 === 0 ? 12 : hour % 12}:${minute} ${hour < 12 ? 'AM' : 'PM'}`
}

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const

/** The weekday a moment falls on ("Monday" … "Sunday"; m = 0 is "Sunday", the end of the week before). */
export function momentDay(m: number): string {
  const { day } = splitMoment(m)
  return DAY_NAMES[((day % 7) + 7) % 7]
}

/** "Monday at midnight", "Friday at 6:00 PM", "Saturday at noon"; m = 0 is "Sunday at midnight". */
export function momentText(m: number, hourCycle: HourCycle = 'h12'): string {
  const label = timeLabel(splitMoment(m).time, hourCycle)
  return `${momentDay(m)} at ${label === 'Midnight' || label === 'Noon' ? label.toLowerCase() : label}`
}

/** One line per moment that differs: "Lists now lock Monday at 8:00 PM", "Reviews now open Thursday at
 *  6:00 PM", "Reviews are now due Saturday at noon". */
export function scheduleChangeLines(before: WeekSchedule | null | undefined, after: WeekSchedule | null | undefined, hourCycle: HourCycle = 'h12'): string[] {
  const b = before ?? DEFAULT_SCHEDULE
  const a = after ?? DEFAULT_SCHEDULE
  const lines: string[] = []
  if (a.lock !== b.lock) lines.push(`Lists now lock ${momentText(a.lock, hourCycle)}`)
  if (a.reviewOpen !== b.reviewOpen) lines.push(`Reviews now open ${momentText(a.reviewOpen, hourCycle)}`)
  if (a.deadline !== b.deadline) lines.push(`Reviews are now due ${momentText(a.deadline, hourCycle)}`)
  return lines
}

/** A week's bounds: the stored ones when its doc is given, else computed on the space's schedule. Every screen
 *  and job uses this instead of weekBounds(weekId, space.timezone). */
export function boundsFor(space: Pick<Space, 'timezone' | 'schedule'>, weekId: WeekId, week?: WeekBounds | null): WeekBounds {
  if (week) return { startAt: week.startAt, lockAt: week.lockAt, reviewOpenAt: week.reviewOpenAt, deadlineAt: week.deadlineAt }
  return weekBounds(weekId, space.timezone, scheduleOf(space))
}

/** The schedule a week follows: its doc's (absent = the usual times), else the space's. */
export function weekScheduleOf(space: Pick<Space, 'schedule'>, week?: Pick<Week, 'schedule'> | null): WeekSchedule {
  return week ? scheduleOf(week) : scheduleOf(space)
}

/**
 * The first week a new schedule `next` applies to, at `nowMs` (SPEC §9.2): this week, next week or the week
 * after, the first whose lists lock at least RETIME_NOTICE_MS away both on its current times (its stored lock,
 * else computed on the space's current schedule) and on `next`. The week after always qualifies.
 */
export function scheduleStartsWith(
  space: Pick<Space, 'timezone' | 'schedule'>,
  next: WeekSchedule,
  stored: { thisWeek?: Week | null; nextWeek?: Week | null },
  nowMs: number,
): WeekId {
  const thisWeek = weekIdFor(nowMs, space.timezone)
  const candidates: [WeekId, Week | null | undefined][] = [
    [thisWeek, stored.thisWeek],
    [addWeeks(thisWeek, 1), stored.nextWeek],
  ]
  for (const [weekId, doc] of candidates) {
    const current = doc && doc.id === weekId ? doc.lockAt : weekBounds(weekId, space.timezone, scheduleOf(space)).lockAt
    const moved = weekBounds(weekId, space.timezone, next).lockAt
    if (current - nowMs >= RETIME_NOTICE_MS && moved - nowMs >= RETIME_NOTICE_MS) return weekId
  }
  return addWeeks(thisWeek, 2)
}

/** The first period a change of role applies to (SPEC §9.4): this week while its lists haven't locked (its
 *  stored lock, else computed), else next week. No notice needed. */
export function firstUnlockedWeek(space: Pick<Space, 'timezone' | 'schedule'>, thisWeek: Week | null | undefined, nowMs: number): WeekId {
  const weekId = weekIdFor(nowMs, space.timezone)
  const lockAt = thisWeek && thisWeek.id === weekId ? thisWeek.lockAt : weekBounds(weekId, space.timezone, scheduleOf(space)).lockAt
  return nowMs < lockAt ? weekId : addWeeks(weekId, 1)
}

/**
 * The bounds a stored week moves to now, or null (the same test as the rules' retimesWeek): the week follows
 * another schedule than the space's, and its stored lock and its lock on the space's schedule are both at least
 * RETIME_NOTICE_MS away. `startAt` never changes.
 */
export function needsRetime(space: Pick<Space, 'timezone' | 'schedule'>, week: Week, nowMs: number): WeekBounds | null {
  const s = scheduleOf(space)
  if (sameSchedule(scheduleOf(week), s)) return null
  const moved = weekBounds(week.id, space.timezone, s)
  if (week.lockAt - nowMs < RETIME_NOTICE_MS || moved.lockAt - nowMs < RETIME_NOTICE_MS) return null
  return { startAt: week.startAt, lockAt: moved.lockAt, reviewOpenAt: moved.reviewOpenAt, deadlineAt: moved.deadlineAt }
}
