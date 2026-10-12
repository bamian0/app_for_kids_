// Wording for money screens: which week money belongs to, week labels, and when something happened.
import { weekIdFor } from '../../domain/time.ts'
import type { WeekId } from '../../domain/types.ts'
import { deviceZone } from '../components/zone.ts'

/** This week on this device's clock. Money spans every space, so it follows the device, not a space. */
export function moneyWeekId(nowMs: number): WeekId {
  return weekIdFor(nowMs, deviceZone())
}

const WEEK_LABEL = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/** "Sep 14": the week's Monday. */
export function weekLabel(weekId: WeekId): string {
  const [year, month, day] = weekId.split('-').map(Number)
  return WEEK_LABEL.format(Date.UTC(year, month - 1, day))
}

const DAY = 86_400_000
const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'long' })
const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const DATE_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Like Wallet: "Today", "Yesterday", "Friday" within the week, then "Oct 3" (with the year once it isn't this one). */
export function activityDate(ms: number, nowMs: number): string {
  const days = Math.round((startOfDay(nowMs) - startOfDay(ms)) / DAY)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return WEEKDAY.format(ms)
  return new Date(ms).getFullYear() === new Date(nowMs).getFullYear() ? DATE.format(ms) : DATE_YEAR.format(ms)
}

/** "≈ 6 weeks", "≈ 1 week". */
export function weeksText(weeks: number): string {
  return `≈ ${weeks} ${weeks === 1 ? 'week' : 'weeks'}`
}
