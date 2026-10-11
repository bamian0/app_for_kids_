// Number and date wording shared by the screens (pure, so it is unit-tested without a DOM).
import type { MonthId } from '../../domain/types.ts'

/** Whole percent, floored like Fitness, with a hair of slack for float noise: 89.9 → 89, 89.9999999 → 90. */
export function wholePercent(score: number): number {
  return Math.floor(score + 1e-6)
}

/** "92%". The one score format everywhere, so a score shown as 90% never fails the 90% bar. */
export function formatScore(score: number): string {
  return `${wholePercent(score)}%`
}

const MONTH_NAME = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' })

/** "2026-10" → "October". */
export function monthName(monthId: MonthId): string {
  const [year, month] = monthId.split('-').map(Number)
  return MONTH_NAME.format(Date.UTC(year, month - 1, 1))
}

const SHORT_DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

/** "Oct 3" on this device's calendar. */
export function shortDate(ms: number): string {
  return SHORT_DATE.format(ms)
}
