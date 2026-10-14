// Week/month calendar logic in a space's timezone. See docs/SPEC.md §1.
import { DateTime } from 'luxon'
import type { MonthId, Space, WeekId, WeekSchedule } from './types.ts'

export interface WeekBounds {
  startAt: number
  lockAt: number
  reviewOpenAt: number
  deadlineAt: number
}

export type WeekPhase = 'planning' | 'active' | 'review' | 'closed'

const DEFAULT_LOCALE = 'en-US'

function zoned(ms: number, tz: string): DateTime {
  const dt = DateTime.fromMillis(ms, { zone: tz })
  if (!dt.isValid) throw new RangeError(`Invalid time ${ms} in zone ${tz}: ${dt.invalidExplanation ?? dt.invalidReason}`)
  return dt
}

/** A calendar date as a UTC-midnight DateTime, so plus()/minus() is pure date math. */
function calendarDate(isoDate: string): DateTime {
  const dt = /^\d{4}-\d{2}-\d{2}$/.test(isoDate) ? DateTime.fromISO(isoDate, { zone: 'utc' }) : null
  if (!dt?.isValid) throw new RangeError(`Invalid date ${isoDate}`)
  return dt
}

function calendarMonth(monthId: MonthId): DateTime {
  if (!/^\d{4}-\d{2}$/.test(monthId)) throw new RangeError(`Invalid month ${monthId}`)
  return calendarDate(`${monthId}-01`)
}

function isoDate(dt: DateTime): string {
  return dt.toFormat('yyyy-MM-dd')
}

function isoMonth(dt: DateTime): MonthId {
  return dt.toFormat('yyyy-MM')
}

/** WeekId (Monday date) of the week containing `ms` in timezone `tz`. */
export function weekIdFor(ms: number, tz: string): WeekId {
  const local = zoned(ms, tz)
  const date = DateTime.utc(local.year, local.month, local.day)
  return isoDate(date.minus({ days: local.weekday - 1 }))
}

/** The usual times (SPEC §1, §9.2): lists lock Monday at midnight, reviews open Thursday at midnight and are
 *  due Friday at midnight, in minutes after the week's Monday 00:00. A space or week without `schedule` uses it. */
export const DEFAULT_SCHEDULE: WeekSchedule = Object.freeze({ lock: 1440, reviewOpen: 5760, deadline: 7200 })

/** Minutes in a week: the latest a deadline can be (Sunday at midnight, the next Monday 00:00). */
export const WEEK_MINUTES = 10080

const DAY_MINUTES = 1440

/** The week's Monday 00:00 in `tz` (or the first instant of that day where midnight is skipped). */
function mondayOf(weekId: WeekId, tz: string): DateTime {
  const date = calendarDate(weekId)
  const monday = DateTime.fromObject({ year: date.year, month: date.month, day: date.day }, { zone: tz })
  if (!monday.isValid) throw new RangeError(`Invalid week ${weekId} in zone ${tz}: ${monday.invalidExplanation ?? monday.invalidReason}`)
  return monday
}

function momentFrom(monday: DateTime, minutes: number): number {
  if (!Number.isFinite(minutes)) throw new RangeError(`Invalid minutes ${minutes}`)
  const days = Math.floor(minutes / DAY_MINUTES)
  const rest = minutes - days * DAY_MINUTES
  // Calendar days in the zone, so a DST change inside the week moves the instants by ±1h as it should.
  // startOf('day') re-anchors to local midnight (or the first instant of the day where midnight is skipped).
  const day = monday.plus({ days }).startOf('day')
  if (rest === 0) return day.toMillis()
  // A wall-clock time on that day, set from the day's start: luxon guesses with the day's first offset, so a
  // time in a spring-forward gap moves forward by the gap (02:30 → 03:30) and an ambiguous fall-back time
  // takes its first occurrence.
  return day.set({ hour: Math.floor(rest / 60), minute: Math.floor(rest % 60), second: 0, millisecond: 0 }).toMillis()
}

/**
 * The instant `minutes` after `weekId`'s Monday 00:00 on the wall clock of `tz` (SPEC §9.2). Whole days resolve
 * through startOf('day') exactly as weekBounds always did (zones that skip midnight are unchanged); other times
 * through the wall clock (a gap time moves forward, an ambiguous time takes its first occurrence). Minutes < 0 or
 * ≥ WEEK_MINUTES roll into the neighbouring weeks.
 */
export function momentAt(weekId: WeekId, tz: string, minutes: number): number {
  return momentFrom(mondayOf(weekId, tz), minutes)
}

/** Exact instants for a week in timezone `tz` (DST-correct) on `schedule` (the usual times by default, which
 *  give exactly what this always gave). Once a week doc exists its stored bounds rule; see boundsFor in
 *  schedule.ts. */
export function weekBounds(weekId: WeekId, tz: string, schedule: WeekSchedule = DEFAULT_SCHEDULE): WeekBounds {
  const monday = mondayOf(weekId, tz)
  return {
    startAt: momentFrom(monday, 0),
    lockAt: momentFrom(monday, schedule.lock),
    reviewOpenAt: momentFrom(monday, schedule.reviewOpen),
    deadlineAt: momentFrom(monday, schedule.deadline),
  }
}

/** The zone's UTC offset in minutes at `ms` (e.g. 120 for Berlin in summer, −420 for Los Angeles). */
export function utcOffsetMinutes(tz: string, ms: number): number {
  return zoned(ms, tz).offset
}

/** True when any bound differs by more than `tolMs` (default 1h, the rules' DST slack). */
export function boundsDiffer(a: WeekBounds, b: WeekBounds, tolMs = 3_600_000): boolean {
  return (['startAt', 'lockAt', 'reviewOpenAt', 'deadlineAt'] as const).some((k) => Math.abs(a[k] - b[k]) > tolMs)
}

/** Calendar arithmetic on week ids (no timezone needed). */
export function addWeeks(weekId: WeekId, n: number): WeekId {
  return isoDate(calendarDate(weekId).plus({ weeks: n }))
}

export function weekPhase(bounds: WeekBounds, nowMs: number): WeekPhase {
  if (nowMs < bounds.lockAt) return 'planning'
  if (nowMs < bounds.reviewOpenAt) return 'active'
  if (nowMs < bounds.deadlineAt) return 'review'
  return 'closed'
}

/** Month of the week's Friday. */
export function monthIdForWeek(weekId: WeekId): MonthId {
  return isoMonth(calendarDate(weekId).plus({ days: 4 }))
}

/** Calendar month containing `ms` in timezone `tz`. */
export function monthIdFor(ms: number, tz: string): MonthId {
  return isoMonth(zoned(ms, tz))
}

export function addMonths(monthId: MonthId, n: number): MonthId {
  return isoMonth(calendarMonth(monthId).plus({ months: n }))
}

/** Week ids whose Friday falls in the month, ascending. */
export function weekIdsInMonth(monthId: MonthId): WeekId[] {
  const first = calendarMonth(monthId)
  let friday = first.plus({ days: (5 - first.weekday + 7) % 7 })
  const ids: WeekId[] = []
  while (friday.month === first.month) {
    ids.push(isoDate(friday.minus({ days: 4 })))
    friday = friday.plus({ weeks: 1 })
  }
  return ids
}

/** deadlineAt of the month's last week: when the month's verdict becomes final. With `lastWeek` (that week's
 *  stored doc), its stored deadline; else computed on `schedule`. A month with a monthly list ends at the later
 *  of this and the list's deadline (monthEndsAt in scoring.ts). */
export function monthCompleteAt(
  monthId: MonthId,
  tz: string,
  schedule: WeekSchedule = DEFAULT_SCHEDULE,
  lastWeek?: Pick<WeekBounds, 'deadlineAt'> | null,
): number {
  if (lastWeek && Number.isFinite(lastWeek.deadlineAt)) return lastWeek.deadlineAt
  const weeks = weekIdsInMonth(monthId)
  return weekBounds(weeks[weeks.length - 1], tz, schedule).deadlineAt
}

/** The weeks that frame a month's list (SPEC §9.5): the first (its start), the second (its lock: the list locks
 *  with the second week's lists) and the last (its review window). A month has 4 or 5 weeks. */
export function monthlyWeeks(monthId: MonthId): { first: WeekId; lock: WeekId; last: WeekId } {
  const weeks = weekIdsInMonth(monthId)
  return { first: weeks[0], lock: weeks[1], last: weeks[weeks.length - 1] }
}

/** A month's list timeline from its weeks' bounds: the first week's startAt, the second week's lockAt and the
 *  last week's review window. `boundsOf` gives each week's stored bounds, else computed ones. */
export function monthlyBounds(monthId: MonthId, boundsOf: (weekId: WeekId) => WeekBounds): WeekBounds {
  const { first, lock, last } = monthlyWeeks(monthId)
  const end = boundsOf(last)
  return { startAt: boundsOf(first).startAt, lockAt: boundsOf(lock).lockAt, reviewOpenAt: end.reviewOpenAt, deadlineAt: end.deadlineAt }
}

/** True when `weekId` is its month's last week: its review window also reviews the month's lists. */
export function isMonthlyReviewWeek(weekId: WeekId): boolean {
  const weeks = weekIdsInMonth(monthIdForWeek(weekId))
  return weeks[weeks.length - 1] === weekId
}

/**
 * The latest month whose last week is before this week (SPEC §9.8): complete, since a deadline is at most a week
 * after its Monday 00:00. The caller still checks the stored deadline.
 */
export function lastCompleteMonthCandidate(nowMs: number, tz: string): MonthId {
  const lastWeek = addWeeks(weekIdFor(nowMs, tz), -1)
  const monthId = monthIdForWeek(lastWeek)
  return isMonthlyReviewWeek(lastWeek) ? monthId : addMonths(monthId, -1)
}

/** The month the space was created in (the month of that week's Friday), or null without a usable createdAt.
 *  No month before it has anything to show or score. */
export function firstMonthOf(space: Pick<Space, 'timezone' | 'createdAt'>): MonthId | null {
  if (!(Number.isFinite(space.createdAt) && space.createdAt > 0)) return null
  try {
    return monthIdForWeek(weekIdFor(space.createdAt, space.timezone))
  } catch {
    return null
  }
}

/** Local wall-clock parts of `ms` in `tz` (weekday 1 = Monday … 7 = Sunday). */
export function localParts(ms: number, tz: string): { weekday: number; hour: number; day: number; month: number; year: number } {
  const { weekday, hour, day, month, year } = zoned(ms, tz)
  return { weekday, hour, day, month, year }
}

/** Compact countdown: "2d 4h", "5h 12m", "12m", "<1m". Rounds down; zero second units are dropped ("2d", "5h"). */
export function formatCountdown(ms: number): string {
  if (!(ms > 0)) return '0m'
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 1) return '<1m'
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}

/** Engines differ on thin vs regular spaces around the range dash; settle on regular ones. */
function normalizeSpaces(text: string): string {
  return text.replace(/[   ]/g, ' ')
}

/** e.g. "Oct 12 – 16" (Monday to Friday). */
export function formatWeekRange(weekId: WeekId, locale: string = DEFAULT_LOCALE): string {
  const monday = calendarDate(weekId)
  const friday = monday.plus({ days: 4 })
  const fmt = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const start = monday.toJSDate()
  const end = friday.toJSDate()
  // formatRange adds years when the range crosses New Year; a week never needs them.
  if (monday.year !== friday.year) return normalizeSpaces(`${fmt.format(start)} – ${fmt.format(end)}`)
  return normalizeSpaces(fmt.formatRange(start, end))
}

/** e.g. "October 2026". */
export function formatMonth(monthId: MonthId, locale: string = DEFAULT_LOCALE): string {
  const fmt = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' })
  return normalizeSpaces(fmt.format(calendarMonth(monthId).toJSDate()))
}
