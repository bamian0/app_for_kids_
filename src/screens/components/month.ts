// Which month to show, and the month verdict in words (who owes whom, and who may mark it settled).
import { scheduleOf } from '../../domain/schedule.ts'
import { isMonthPlayer } from '../../domain/scoring.ts'
import type { MemberMonthResult } from '../../domain/scoring.ts'
import { debtLines, monthDebts, monthTerms, streaksFor } from '../../domain/stakes.ts'
import type { DebtLine, House, Streaks } from '../../domain/stakes.ts'
import { addMonths, firstMonthOf, monthCompleteAt, monthIdForWeek, weekIdFor } from '../../domain/time.ts'
import type { MemberStakes, MonthId, MonthResults, Settlement, Space, TermsInForce, UID } from '../../domain/types.ts'
import { formatScore, monthName, shortDate } from './format.ts'
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
export function freshVerdictMonth(space: Pick<Space, 'timezone' | 'joinedAt'> & Partial<Pick<Space, 'schedule'>>, me: UID, nowMs: number): MonthId | null {
  const current = currentMonth(space, nowMs)
  for (const monthId of [current, addMonths(current, -1)]) {
    // On the space's own times (the usual ones without a schedule).
    const completeAt = monthCompleteAt(monthId, space.timezone, scheduleOf(space))
    if (nowMs < completeAt) continue
    const joined = space.joinedAt[me]
    return nowMs < completeAt + VERDICT_DAYS * DAY && joined !== undefined && joined < completeAt ? monthId : null
  }
  return null
}

/** The month the month view opens on: a fresh verdict, else the current month. */
export function defaultMonth(space: Pick<Space, 'timezone' | 'joinedAt'> & Partial<Pick<Space, 'schedule'>>, me: UID, nowMs: number): MonthId {
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

// ---------- Per-pair debt lines (SPEC §9.7) ----------

type Name = (uid: UID) => string

/** "you" first in a list of people: "You, Sam and Kim", "Lena", "you and Sam". */
function people(uids: UID[], me: UID, name: Name): string {
  const names = uids.map((id) => (id === me ? 'you' : name(id)))
  names.sort((a, b) => (a === 'you' ? -1 : b === 'you' ? 1 : 0))
  return listNames(names)
}

/**
 * A debt line in words: "You, Sam and Kim owe Lena: Weekend away", "Lena owes you: A coffee", "You owe Sam, Kim and
 * Ana: Coffee for a week", "Sam and Kim owe you: A weekend away".
 */
export function debtLineText(line: Pick<DebtLine, 'kind' | 'subject' | 'debtors' | 'creditors' | 'what'>, me: UID, name: Name): string {
  const debtors = line.debtors
  const one = debtors.length === 1 && debtors[0] !== me
  return `${cap(people(debtors, me, name))} ${one ? 'owes' : 'owe'} ${people(line.creditors, me, name)}: ${line.what}`
}

function creditorsLeft(line: Pick<DebtLine, 'creditors'>, memberIds: UID[]): boolean {
  return line.creditors.length > 0 && line.creditors.every((id) => !memberIds.includes(id))
}

/** Who marks a line settled: whoever was owed (the subject for a reward or streak reward, the friends owed for a
 *  penalty); when every one of them has left the space, its debtors instead. */
export function canSettleLine(line: Pick<DebtLine, 'debtors' | 'creditors'>, me: UID, memberIds: UID[]): boolean {
  return creditorsLeft(line, memberIds) ? line.debtors.includes(me) : line.creditors.includes(me)
}

/**
 * The hint under a line that isn't settled: why you can't mark it ("Only Lena can mark this.", "Only the people you
 * owe can mark this."), or that you may because they left ("Lena has left, so you can mark this yourself.").
 * null when it's yours to mark as usual.
 */
export function settleLineHint(line: Pick<DebtLine, 'kind' | 'subject' | 'debtors' | 'creditors'>, me: UID, memberIds: UID[], name: Name): string | null {
  if (creditorsLeft(line, memberIds)) {
    if (line.debtors.includes(me)) {
      const gone = line.creditors.map(name)
      return `${listNames(gone)} ${gone.length === 1 ? 'has' : 'have'} left, so you can mark this yourself.`
    }
    return line.kind === 'penalty' ? `Only ${people(line.debtors, me, name)} can mark this.` : `Only the people who owe ${name(line.subject)} can mark this.`
  }
  if (line.creditors.includes(me)) return null
  if (line.kind !== 'penalty') return `Only ${name(line.subject)} can mark this.`
  // One friend owed: name them; a group: say who it is about.
  if (line.creditors.length === 1) return `Only ${name(line.creditors[0])} can mark this.`
  return line.subject === me ? 'Only the people you owe can mark this.' : `Only the people ${name(line.subject)} owes can mark this.`
}

/** "Settled · marked by you, Nov 2". */
export function settledText(mark: Pick<Settlement, 'settledBy' | 'settledAt'>, me: UID, name: Name): string {
  return `Settled · marked by ${mark.settledBy === me ? 'you' : name(mark.settledBy)}, ${shortDate(mark.settledAt)}`
}

/** A debt line's subtitle: the streak length, "Together" (a group line with ≥ 2 owing), then settled or the hint. */
export function debtLineSubtitle(
  line: Pick<DebtLine, 'kind' | 'subject' | 'debtors' | 'creditors' | 'together' | 'tier'>,
  settled: { settled: boolean; last?: Pick<Settlement, 'settledBy' | 'settledAt'> },
  me: UID,
  memberIds: UID[],
  name: Name,
): string | undefined {
  const parts = [
    line.tier !== undefined ? `${line.tier} months in a row` : null,
    line.together && line.debtors.length >= 2 ? 'Together' : null,
    settled.settled && settled.last ? settledText(settled.last, me, name) : settled.settled ? null : settleLineHint(line, me, memberIds, name),
  ].filter((p): p is string => !!p)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/** A month in progress, read as if it ended now: each score so far against the bar (no streak rewards yet). */
export function soFar(results: Record<UID, MemberMonthResult>, threshold: number): Record<UID, MemberMonthResult> {
  const out: Record<UID, MemberMonthResult> = {}
  for (const [uid, r] of Object.entries(results)) {
    out[uid] = r.complete || r.finalScore === null ? r : { ...r, passed: r.finalScore >= threshold - 1e-9 }
  }
  return out
}

/** The member plays the month: a week they didn't judge that is neither paused nor skipped, or a monthly list that
 *  isn't skipped (SPEC §10.4; the domain's own test, so screens and the reminders job agree). */
export function playsMonth(result: MemberMonthResult): boolean {
  return isMonthPlayer(result)
}

/** The member only judged this month (weeks or its lists) and has no score. */
export function judgeOnly(result: MemberMonthResult): boolean {
  return !playsMonth(result) && ((result.judged?.length ?? 0) > 0 || result.monthlyJudge === true)
}

// ---------- The month view's rows (SPEC §9.3–§9.8) ----------

/** Weeks and the monthly list friends excused entirely this month (SPEC §10.4): listed, never averaged. */
export function skippedCount(result: MemberMonthResult): number {
  return result.weeks.filter((w) => w.skipped).length + (result.monthly?.skipped ? 1 : 0)
}

/**
 * A member's month in a line: "3 weeks scored · 1 paused · −5 late", "4 weeks + October list scored", "3 weeks
 * scored · 1 skipped", or for someone who only judged "Judge · no score this month · didn’t review 2".
 * `weekClosed` tells which judged weeks have closed (in a month they also play, each one counts as a 0% week).
 */
export function monthSummary(result: MemberMonthResult, weekClosed: (weekId: string) => boolean): string {
  if (judgeOnly(result)) {
    const skipped = result.skippedAsJudge ?? 0
    return `Judge · no score this month${skipped > 0 ? ` · didn’t review ${skipped}` : ''}`
  }
  const skipped = skippedCount(result)
  if (result.finalScore === null) return skipped > 0 ? `No scored weeks yet · ${skipped} skipped` : 'No scored weeks yet'
  const judgedScored = playsMonth(result) ? (result.judged ?? []).filter(weekClosed).length : 0
  const scored = result.weeks.filter((w) => !w.paused && w.closed && w.score !== null).length + judgedScored
  const list = !!result.monthly?.closed && result.monthly.score !== null
  const paused = result.weeks.filter((w) => w.paused).length
  return [
    `${scored} week${scored === 1 ? '' : 's'}${list ? ` + ${monthName(result.monthId)} list` : ''} scored`,
    paused > 0 ? `${paused} paused` : null,
    skipped > 0 ? `${skipped} skipped` : null,
    result.penaltyPoints ? `−${result.penaltyPoints} late` : null,
  ]
    .filter((p): p is string => !!p)
    .join(' · ')
}

/** A week row's detail in the month view: the score, "Paused", "Skipped" (friends excused every task), "Judge"
 *  ("Judge · 0%" once closed in a month they also play), "In progress", "Upcoming", "Sat out" or "Not in". */
export function weekDetail(result: MemberMonthResult, weekId: string, bounds: { startAt: number; deadlineAt: number }, nowMs: number): string {
  const started = nowMs >= bounds.startAt
  const closed = nowMs >= bounds.deadlineAt
  const entry = result.weeks.find((w) => w.weekId === weekId)
  if (entry?.paused) return 'Paused'
  if (entry?.skipped) return 'Skipped'
  if (result.judged?.includes(weekId)) return playsMonth(result) && closed ? 'Judge · 0%' : 'Judge'
  if (entry) return entry.score !== null ? `${formatScore(entry.score)}${entry.closed ? '' : ' so far'}` : started ? 'In progress' : 'Upcoming'
  return !started ? 'Upcoming' : closed ? 'Sat out' : 'Not in'
}

/** The "October list" row's detail: the list's score, "Skipped", "In progress", "Judge" or "No list". */
export function monthlyDetail(result: MemberMonthResult): string {
  if (result.monthlyJudge) return 'Judge'
  const list = result.monthly
  if (!list) return 'No list'
  if (list.skipped) return 'Skipped'
  if (!list.closed) return 'In progress'
  return list.score !== null ? formatScore(list.score) : 'No score'
}

/** The finished month's footnote for people who only judged it: "Kim judged October." */
export function judgedFootnote(names: string[], monthId: MonthId): string | null {
  return names.length > 0 ? `${listNames(names)} judged ${monthName(monthId)}.` : null
}

/** "3 months in a row" from 2 on. */
export function streakPill(streak: number | null | undefined): string | null {
  return typeof streak === 'number' && streak >= 2 ? `${streak} months in a row` : null
}

export interface MonthDebtView {
  /** The month's terms, subject → friend (stored, or monthTerms from the agreements before completion). */
  terms: Record<UID, Record<UID, TermsInForce>>
  /** Debt lines: by the final verdicts once complete; by the score so far before that (no streak rewards). */
  lines: DebtLine[]
  /** Streaks and runs after this month (complete months only); null while unknown. */
  streaks: Streaks | null
}

/**
 * What the month view shows about who owes whom (SPEC §9.7, §9.8): a complete month by its results doc's stored
 * terms, else by monthTerms with its `completeAt` and house stakes (a finished month never changes); a month in
 * progress by what counts now (the same as the stakes card, through termsFriends), read as if it ended now.
 */
export function monthDebtView(input: {
  space: Space
  monthId: MonthId
  results: Record<UID, MemberMonthResult>
  stakes: Record<UID, MemberStakes> | undefined
  house: House
  completeAt: number
  firstLockAt: number
  stored: MonthResults | null | undefined
  prev: MonthResults | null | undefined
}): MonthDebtView {
  const { space, monthId, results, stakes, house, completeAt, firstLockAt, stored, prev } = input
  const terms = monthTerms(space, monthId, results, stakes, house, { completeAt, firstLockAt }, stored)
  const complete = Object.values(results).some((r) => r.complete)
  if (!complete) return { terms, lines: debtLines(monthDebts(monthId, soFar(results, space.threshold), terms, null)), streaks: null }
  const streaks = streaksFor(monthId, firstMonthOf(space), stored, prev, results, terms)
  return { terms, lines: debtLines(monthDebts(monthId, results, terms, streaks?.tierRuns ?? null)), streaks }
}
