// Which month to show, and the month verdict in words (who owes whom, and who may mark it settled).
import type { MemberMonthResult } from '../../domain/scoring.ts'
import { addMonths, monthCompleteAt, monthIdForWeek, weekIdFor } from '../../domain/time.ts'
import type { MonthId, Space, UID } from '../../domain/types.ts'
import { monthName } from './format.ts'
import { compactNames, listNames } from './people.ts'

const DAY = 86_400_000
/** How long a finished month stays the one the app opens on. */
export const VERDICT_DAYS = 7

/** The month of this week's Friday: the month the week counts toward. */
export function currentMonth(space: Pick<Space, 'timezone'>, nowMs: number): MonthId {
  return monthIdForWeek(weekIdFor(nowMs, space.timezone))
}

/** The month the space was created in (no month before it has anything to show). */
export function firstMonth(space: Pick<Space, 'timezone' | 'createdAt'>, nowMs: number): MonthId {
  return Number.isFinite(space.createdAt) && space.createdAt > 0 ? currentMonth(space, space.createdAt) : currentMonth(space, nowMs)
}

/**
 * A month that finished less than a week ago and that `me` was around for: its verdict is what
 * matters right now, so the month view and the home card show it first. null otherwise.
 */
export function freshVerdictMonth(space: Pick<Space, 'timezone' | 'joinedAt'>, me: UID, nowMs: number): MonthId | null {
  const current = currentMonth(space, nowMs)
  for (const monthId of [current, addMonths(current, -1)]) {
    const completeAt = monthCompleteAt(monthId, space.timezone)
    if (nowMs < completeAt) continue
    const joined = space.joinedAt[me]
    return nowMs < completeAt + VERDICT_DAYS * DAY && joined !== undefined && joined < completeAt ? monthId : null
  }
  return null
}

/** The month the month view opens on: a fresh verdict, else the current month. */
export function defaultMonth(space: Pick<Space, 'timezone' | 'joinedAt'>, me: UID, nowMs: number): MonthId {
  return freshVerdictMonth(space, me, nowMs) ?? currentMonth(space, nowMs)
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** "Lena owes you", "You and Sam owe Lena", "You owe Lena and Sam"; `compact` counts long lists ("You owe 4 friends"). */
export function owesPhrase(result: MemberMonthResult, me: UID, name: (uid: UID) => string, compact = false): string {
  const isMe = result.uid === me
  const who = isMe ? 'you' : name(result.uid)
  const others = result.others.map((id) => (id === me ? 'you' : name(id)))
  // "you" leads a list ("you and Sam").
  others.sort((a, b) => (a === 'you' ? -1 : b === 'you' ? 1 : 0))
  const list = compact ? compactNames(others) : listNames(others)
  if (result.passed) return `${cap(list)} ${others.length === 1 && others[0] !== 'you' ? 'owes' : 'owe'} ${who}`
  return `${cap(who)} ${isMe ? 'owe' : 'owes'} ${list}`
}

/** The verdict line under a member's month, quoting the month's stakes; null until the month is over. */
export function verdictText(result: MemberMonthResult, me: UID, name: (uid: UID) => string, stakes: { reward: string; penalty: string }): string | null {
  if (!result.complete) return null
  if (result.passed === null) return 'No scored weeks, so nothing’s owed.'
  if (result.others.length === 0) return `Just ${result.uid === me ? 'you' : name(result.uid)} this month, so nothing’s owed.`
  return `${owesPhrase(result, me, name)}: ${result.passed ? stakes.reward : stakes.penalty}`
}

/** The home card's line for a fresh verdict: "October: Lena owes you". null when there is no verdict. */
export function verdictStatus(monthId: MonthId, result: MemberMonthResult, me: UID, name: (uid: UID) => string): string | null {
  if (!result.complete || result.passed === null) return null
  if (result.others.length === 0) return `${monthName(monthId)}: just you, nothing owed`
  return `${monthName(monthId)}: ${owesPhrase(result, me, name, true)}`
}

/** Whether a verdict involves anyone else, so there is something to settle. */
export function hasDebt(result: MemberMonthResult): boolean {
  return result.complete && result.passed !== null && result.others.length > 0
}

/** Only the people owed mark a debt settled: the winner for their own reward, the others for a miss. */
export function canSettle(result: MemberMonthResult, me: UID): boolean {
  return result.passed ? result.uid === me : result.uid !== me && result.others.includes(me)
}

/** Why the Settled switch is off limits for `me`, or null when it isn't. */
export function settleHint(result: MemberMonthResult, me: UID, name: (uid: UID) => string): string | null {
  if (canSettle(result, me)) return null
  if (result.passed) return `Only ${name(result.uid)} can mark this.`
  return result.uid === me ? 'Only the people you owe can mark this.' : `Only the people ${name(result.uid)} owes can mark this.`
}
