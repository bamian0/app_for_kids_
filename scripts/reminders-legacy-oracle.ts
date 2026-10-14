// A frozen copy of the reminder windows as they were before batch 2 (SPEC §4), kept as the test oracle for
// scripts/reminders-plan.ts: on the usual times, the new schedule-aware windows must equal these in every zone
// (SPEC §9.11). Don't change it; it only exists to be compared against. Its own copy of the old weekBounds keeps
// it independent of later changes to src/domain/time.ts.
import { DateTime } from 'luxon'

export interface LegacyWindow {
  kind: 'plan' | 'no-progress' | 'open-tasks' | 'review' | 'last-call' | 'results' | 'verdict'
  period: string
  weekIds: string[]
  opensAt: number
  closesAt: number
  expiresAt: number
}

function calendarDate(isoDate: string): DateTime {
  return DateTime.fromISO(isoDate, { zone: 'utc' })
}

function weekIdFor(ms: number, tz: string): string {
  const local = DateTime.fromMillis(ms, { zone: tz })
  const date = DateTime.utc(local.year, local.month, local.day)
  return date.minus({ days: local.weekday - 1 }).toFormat('yyyy-MM-dd')
}

function weekBounds(weekId: string, tz: string): { startAt: number; lockAt: number; reviewOpenAt: number; deadlineAt: number } {
  const date = calendarDate(weekId)
  const monday = DateTime.fromObject({ year: date.year, month: date.month, day: date.day }, { zone: tz })
  const dayStart = (days: number) => monday.plus({ days }).startOf('day').toMillis()
  return { startAt: dayStart(0), lockAt: dayStart(1), reviewOpenAt: dayStart(4), deadlineAt: dayStart(5) }
}

function addWeeks(weekId: string, n: number): string {
  return calendarDate(weekId).plus({ weeks: n }).toFormat('yyyy-MM-dd')
}

function monthIdFor(ms: number, tz: string): string {
  return DateTime.fromMillis(ms, { zone: tz }).toFormat('yyyy-MM')
}

function addMonths(monthId: string, n: number): string {
  return calendarDate(`${monthId}-01`).plus({ months: n }).toFormat('yyyy-MM')
}

function weekIdsInMonth(monthId: string): string[] {
  const first = calendarDate(`${monthId}-01`)
  let friday = first.plus({ days: (5 - first.weekday + 7) % 7 })
  const ids: string[] = []
  while (friday.month === first.month) {
    ids.push(friday.minus({ days: 4 }).toFormat('yyyy-MM-dd'))
    friday = friday.plus({ weeks: 1 })
  }
  return ids
}

function localTime(date: string, days: number, hour: number, tz: string): number {
  return DateTime.fromISO(date, { zone: tz }).plus({ days }).set({ hour, minute: 0, second: 0, millisecond: 0 }).toMillis()
}

/** The reminder windows open at `nowMs` for a space in `tz`, exactly as the job computed them before batch 2. */
export function legacyDueWindows(tz: string, nowMs: number): LegacyWindow[] {
  const weekId = weekIdFor(nowMs, tz)
  const week = weekBounds(weekId, tz)
  const nextWeekStart = weekBounds(addWeeks(weekId, 1), tz).startAt
  const monthId = monthIdFor(nowMs, tz)
  const judged = addMonths(monthId, -1)
  const thisWeek = [weekId]
  const thursday = localTime(weekId, 3, 0, tz)

  const windows: LegacyWindow[] = [
    { kind: 'plan', period: weekId, weekIds: thisWeek, opensAt: localTime(weekId, 0, 18, tz), closesAt: week.lockAt, expiresAt: week.lockAt },
    { kind: 'no-progress', period: weekId, weekIds: thisWeek, opensAt: localTime(weekId, 2, 18, tz), closesAt: thursday, expiresAt: thursday },
    { kind: 'open-tasks', period: weekId, weekIds: thisWeek, opensAt: localTime(weekId, 3, 18, tz), closesAt: week.reviewOpenAt, expiresAt: week.reviewOpenAt },
    { kind: 'review', period: weekId, weekIds: thisWeek, opensAt: localTime(weekId, 4, 9, tz), closesAt: localTime(weekId, 4, 20, tz), expiresAt: week.deadlineAt },
    { kind: 'last-call', period: weekId, weekIds: thisWeek, opensAt: localTime(weekId, 4, 20, tz), closesAt: week.deadlineAt, expiresAt: week.deadlineAt },
    { kind: 'results', period: weekId, weekIds: thisWeek, opensAt: localTime(weekId, 5, 9, tz), closesAt: nextWeekStart, expiresAt: nextWeekStart },
    {
      kind: 'verdict',
      period: judged,
      weekIds: weekIdsInMonth(judged),
      opensAt: localTime(`${monthId}-01`, 0, 10, tz),
      closesAt: localTime(`${monthId}-01`, 2, 0, tz),
      expiresAt: localTime(`${monthId}-01`, 2, 0, tz),
    },
  ]
  return windows.filter((w) => w.opensAt <= nowMs && nowMs < w.closesAt)
}
