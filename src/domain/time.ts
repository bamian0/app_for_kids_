// Week/month calendar logic in a space's timezone. See docs/SPEC.md §1.
// STUB: signatures are the contract; the domain agent implements the bodies with Luxon.
import type { MonthId, WeekId } from './types.ts'

export interface WeekBounds {
  startAt: number
  lockAt: number
  reviewOpenAt: number
  deadlineAt: number
}

export type WeekPhase = 'planning' | 'active' | 'review' | 'closed'

/** WeekId (Monday date) of the week containing `ms` in timezone `tz`. */
export function weekIdFor(ms: number, tz: string): WeekId {
  throw new Error(`not implemented ${ms} ${tz}`)
}

/** Exact instants for a week in timezone `tz` (DST-correct). */
export function weekBounds(weekId: WeekId, tz: string): WeekBounds {
  throw new Error(`not implemented ${weekId} ${tz}`)
}

/** Calendar arithmetic on week ids (no timezone needed). */
export function addWeeks(weekId: WeekId, n: number): WeekId {
  throw new Error(`not implemented ${weekId} ${n}`)
}

export function weekPhase(bounds: WeekBounds, nowMs: number): WeekPhase {
  throw new Error(`not implemented ${bounds} ${nowMs}`)
}

/** Month of the week's Friday. */
export function monthIdForWeek(weekId: WeekId): MonthId {
  throw new Error(`not implemented ${weekId}`)
}

/** Calendar month containing `ms` in timezone `tz`. */
export function monthIdFor(ms: number, tz: string): MonthId {
  throw new Error(`not implemented ${ms} ${tz}`)
}

export function addMonths(monthId: MonthId, n: number): MonthId {
  throw new Error(`not implemented ${monthId} ${n}`)
}

/** Week ids whose Friday falls in the month, ascending. */
export function weekIdsInMonth(monthId: MonthId): WeekId[] {
  throw new Error(`not implemented ${monthId}`)
}

/** deadlineAt of the month's last week: when the month's verdict becomes final. */
export function monthCompleteAt(monthId: MonthId, tz: string): number {
  throw new Error(`not implemented ${monthId} ${tz}`)
}

/** Local wall-clock parts of `ms` in `tz` (weekday 1 = Monday … 7 = Sunday). */
export function localParts(ms: number, tz: string): { weekday: number; hour: number; day: number; month: number; year: number } {
  throw new Error(`not implemented ${ms} ${tz}`)
}

/** Compact countdown: "2d 4h", "5h 12m", "12m", "<1m". */
export function formatCountdown(ms: number): string {
  throw new Error(`not implemented ${ms}`)
}

/** e.g. "Oct 12 – 16" (Monday to Friday). */
export function formatWeekRange(weekId: WeekId, locale?: string): string {
  throw new Error(`not implemented ${weekId} ${locale}`)
}

/** e.g. "October 2026". */
export function formatMonth(monthId: MonthId, locale?: string): string {
  throw new Error(`not implemented ${monthId} ${locale}`)
}
