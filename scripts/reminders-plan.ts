// Pure reminder planning for scripts/reminders.ts (no Firebase, no network). See docs/SPEC.md §4.
//
// Each reminder has a window in the space's local time instead of an exact hour, so a delayed or
// dropped hourly run still sends it on the next run. The sent log (keys from reminderKey) makes
// sure each one goes out once.
import { DateTime } from 'luxon'
import type { MonthId, Space, UID, UserProfile, WeekData, WeekId } from '../src/domain/types.ts'
import { addMonths, addWeeks, monthIdFor, weekBounds, weekIdFor, weekIdsInMonth } from '../src/domain/time.ts'
import { computeMonth, computeWeek, reviewTargets } from '../src/domain/scoring.ts'

export type ReminderKind = 'plan' | 'review' | 'last-call' | 'results' | 'verdict'

export interface DueWindow {
  kind: ReminderKind
  /** WeekId for the weekly reminders, MonthId (the month being judged) for the verdict. */
  period: WeekId | MonthId
  /** Weeks whose data the planner needs to decide this window. */
  weekIds: WeekId[]
  opensAt: number
  closesAt: number
  /** After this the reminder is pointless; used as the push TTL. */
  expiresAt: number
}

export interface Reminder {
  /** Doc id under _private/sent/log. */
  key: string
  kind: ReminderKind
  spaceId: string
  uid: UID
  title: string
  body: string
  /** Opened on tap, relative to the app root. */
  url: string
  /** A newer notification with the same tag replaces the older one. */
  tag: string
  expiresAt: number
}

export interface SpaceInput {
  space: Space
  /** Loaded weeks by id (a week without a doc has `week: null`). Windows whose weeks are absent are skipped. */
  weeks: Record<WeekId, WeekData>
}

export interface PlanInput {
  nowMs: number
  spaces: SpaceInput[]
  profiles: Record<UID, Pick<UserProfile, 'name'>>
  /** Keys already in the sent log. */
  sent: ReadonlySet<string>
}

export interface PlanResult {
  send: Reminder[]
  /** Keys whose answer is final and is "nothing to send" (already reviewed, no score…).
   *  Logging them keeps later runs from reloading the same data. */
  skipped: string[]
}

const HOUR = 3_600_000
const LOCALE = 'en-US'

export function reminderKey(spaceId: string, period: string, kind: ReminderKind, uid: UID): string {
  return `${spaceId}_${period}_${kind}_${uid}`
}

/** `hour`:00 local time, `days` calendar days after `date` ('YYYY-MM-DD') in `tz`. */
function localTime(date: string, days: number, hour: number, tz: string): number {
  return DateTime.fromISO(date, { zone: tz }).plus({ days }).set({ hour, minute: 0, second: 0, millisecond: 0 }).toMillis()
}

/** The reminder windows open at `nowMs` for a space. Pure date math, no data needed. */
export function dueWindows(space: Space, nowMs: number): DueWindow[] {
  const tz = space.timezone
  const weekId = weekIdFor(nowMs, tz)
  const week = weekBounds(weekId, tz)
  const nextWeekStart = weekBounds(addWeeks(weekId, 1), tz).startAt
  const monthId = monthIdFor(nowMs, tz)
  const judged = addMonths(monthId, -1)
  const thisWeek = [weekId]

  const windows: DueWindow[] = [
    // Monday 18:00 until the list locks at midnight.
    { kind: 'plan', period: weekId, weekIds: thisWeek, opensAt: localTime(weekId, 0, 18, tz), closesAt: week.lockAt, expiresAt: week.lockAt },
    // Friday 09:00–20:00, then the louder last call until the deadline.
    { kind: 'review', period: weekId, weekIds: thisWeek, opensAt: localTime(weekId, 4, 9, tz), closesAt: localTime(weekId, 4, 20, tz), expiresAt: week.deadlineAt },
    { kind: 'last-call', period: weekId, weekIds: thisWeek, opensAt: localTime(weekId, 4, 20, tz), closesAt: week.deadlineAt, expiresAt: week.deadlineAt },
    // Saturday 09:00 through the weekend.
    { kind: 'results', period: weekId, weekIds: thisWeek, opensAt: localTime(weekId, 5, 9, tz), closesAt: nextWeekStart, expiresAt: nextWeekStart },
    // The 1st at 10:00, for two days. Every week of the judged month is closed by then.
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

/** "Anna", "Anna and Ben", "Anna, Ben, and Chris", "Anna, Ben, and 3 others". */
export function listNames(names: string[]): string {
  if (names.length <= 3) return new Intl.ListFormat(LOCALE, { type: 'conjunction' }).format(names)
  return `${names.slice(0, 2).join(', ')}, and ${names.length - 2} others`
}

/** Whole percent, rounded down so 89.6 never reads as a passing 90 (with slack for float error). */
export function formatPercent(score: number): string {
  return `${Math.floor(score + 1e-9)}%`
}

function monthName(monthId: MonthId): string {
  return new Intl.DateTimeFormat(LOCALE, { month: 'long', timeZone: 'UTC' }).format(new Date(`${monthId}-01T00:00:00Z`))
}

function hoursLeftTitle(msLeft: number): string {
  const hours = Math.round(msLeft / HOUR)
  if (hours >= 2) return `${hours} hours left`
  return hours === 1 ? '1 hour left' : 'Less than an hour left'
}

type Decision = { uid: UID; title: string; body: string } | { uid: UID; skip: 'final' | 'not-yet' }

function decide(window: DueWindow, space: Space, weeks: Record<WeekId, WeekData>, profiles: PlanInput['profiles'], nowMs: number): Decision[] {
  const members = space.memberIds
  const name = (uid: UID) => profiles[uid]?.name?.trim() || 'a friend'

  switch (window.kind) {
    case 'plan': {
      // Anyone in the space can still join the week before it locks, so the decision isn't final.
      const data = weeks[window.period]
      return members.map((uid) =>
        (data.plans[uid]?.tasks.length ?? 0) > 0
          ? { uid, skip: 'not-yet' }
          : { uid, title: 'Lock in your week', body: `Your task list for ${space.name} locks at midnight. Nothing planned = 0%.` },
      )
    }

    case 'review':
    case 'last-call': {
      // After lock, members and plans are frozen and submitting is one-way: every decision is final.
      const data = weeks[window.period]
      const week = data.week
      return members.map((uid): Decision => {
        if (!week || !week.members.includes(uid) || week.submittedBy.includes(uid)) return { uid, skip: 'final' }
        const targets = reviewTargets(data, uid)
        if (targets.length === 0) return { uid, skip: 'final' }
        const names = listNames(targets.map(name))
        if (window.kind === 'review') return { uid, title: 'Review day', body: `Rate ${names} in ${space.name} before midnight.` }
        const points = space.latePenalty * targets.length
        return { uid, title: hoursLeftTitle(week.deadlineAt - nowMs), body: `Miss the ${space.name} deadline and you lose ${points} points.` }
      })
    }

    case 'results': {
      const data = weeks[window.period]
      const result = data.week ? computeWeek(data, space, nowMs) : null
      return members.map((uid): Decision => {
        const member = result?.members[uid]
        if (!member?.participating || member.score === null) return { uid, skip: 'final' }
        return { uid, title: 'Results are in', body: `You scored ${formatPercent(member.score)}. See how ${space.name} did this week.` }
      })
    }

    case 'verdict': {
      const month = computeMonth(space, window.period, window.weekIds.map((id) => weeks[id]), nowMs)
      const label = monthName(window.period)
      return members.map((uid): Decision => {
        const result = month[uid]
        if (!result || result.finalScore === null || result.passed === null) return { uid, skip: 'final' }
        const score = formatPercent(result.finalScore)
        return result.passed
          ? { uid, title: `You made it: ${score}`, body: `${label} in ${space.name} is done. Collect: ${space.reward}` }
          : { uid, title: `You fell short: ${score}`, body: `${label} in ${space.name} is done. Pay up: ${space.penalty}` }
      })
    }
  }
}

/** Reminders to send now, and final no-ops to log, for one space. */
export function planSpace(input: SpaceInput, profiles: PlanInput['profiles'], sent: ReadonlySet<string>, nowMs: number): PlanResult {
  const { space, weeks } = input
  const result: PlanResult = { send: [], skipped: [] }
  for (const window of dueWindows(space, nowMs)) {
    if (!window.weekIds.every((id) => id in weeks)) continue
    for (const decision of decide(window, space, weeks, profiles, nowMs)) {
      const key = reminderKey(space.id, window.period, window.kind, decision.uid)
      if (sent.has(key)) continue
      if ('skip' in decision) {
        if (decision.skip === 'final') result.skipped.push(key)
        continue
      }
      result.send.push({
        key,
        kind: window.kind,
        spaceId: space.id,
        uid: decision.uid,
        title: decision.title,
        body: decision.body,
        url: './',
        // The last call replaces the morning's review reminder.
        tag: `${window.kind === 'last-call' ? 'review' : window.kind}-${space.id}`,
        expiresAt: window.expiresAt,
      })
    }
  }
  return result
}

export function planReminders(input: PlanInput): PlanResult {
  const all: PlanResult = { send: [], skipped: [] }
  for (const space of input.spaces) {
    const { send, skipped } = planSpace(space, input.profiles, input.sent, input.nowMs)
    all.send.push(...send)
    all.skipped.push(...skipped)
  }
  return all
}
