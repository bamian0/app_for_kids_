// Week/month calendar logic in a space's timezone. See docs/SPEC.md §1.
import { DateTime } from 'luxon'
import type { MonthId, WeekId } from './types.ts'

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

/** Exact instants for a week in timezone `tz` (DST-correct). */
export function weekBounds(weekId: WeekId, tz: string): WeekBounds {
  const date = calendarDate(weekId)
  const monday = DateTime.fromObject({ year: date.year, month: date.month, day: date.day }, { zone: tz })
  if (!monday.isValid) throw new RangeError(`Invalid week ${weekId} in zone ${tz}: ${monday.invalidExplanation ?? monday.invalidReason}`)
  // Calendar days in the zone, so a DST change inside the week moves the instants by ±1h as it should.
  // startOf('day') re-anchors to local midnight (or the first instant of the day where midnight is skipped).
  const dayStart = (days: number) => monday.plus({ days }).startOf('day').toMillis()
  return { startAt: dayStart(0), lockAt: dayStart(1), reviewOpenAt: dayStart(4), deadlineAt: dayStart(5) }
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

/** deadlineAt of the month's last week: when the month's verdict becomes final. */
export function monthCompleteAt(monthId: MonthId, tz: string): number {
  const weeks = weekIdsInMonth(monthId)
  return weekBounds(weeks[weeks.length - 1], tz).deadlineAt
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
