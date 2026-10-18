// What the monthly card and the monthly screen say (SPEC §9.5), as pure functions of the list and the clock,
// so the copy is unit-tested without a DOM.
import { boundsFor } from '../../domain/schedule.ts'
import { judgesOf, spaceJudges } from '../../domain/scoring.ts'
import type { MemberWeekResult, WeekResult } from '../../domain/scoring.ts'
import { formatCountdown, monthlyBounds, weekPhase } from '../../domain/time.ts'
import type { WeekBounds, WeekPhase } from '../../domain/time.ts'
import type { MonthlyData, Space, UID } from '../../domain/types.ts'
import type { IconName } from '../../ui/icons.tsx'
import { SKIPPED_PERIOD, openCount } from '../components/cancel.ts'
import { formatScore, monthName } from '../components/format.ts'
import { compactNames, listNames } from '../components/people.ts'

const DAY_MS = 86_400_000
/** A list can be planned from 8 days before its first week starts (when the upkeep may create it). */
export const MONTHLY_LEAD_MS = 8 * DAY_MS

/** The list's timeline: the stored doc's, else computed from its weeks on the space's schedule. */
export function monthlyBoundsOf(space: Pick<Space, 'timezone' | 'schedule'>, data: Pick<MonthlyData, 'monthId' | 'monthly'>): WeekBounds {
  return data.monthly ?? monthlyBounds(data.monthId, (w) => boundsFor(space, w))
}

/** "1 task", "3 tasks". */
function tasks(n: number): string {
  return `${n} task${n === 1 ? '' : 's'}`
}

/** Players with a list, in the list's members order: not judges, ≥ 1 task. */
export function listHolders(result: WeekResult): UID[] {
  return Object.values(result.members)
    .filter((m) => m.participating && !m.judge && m.taskCount > 0)
    .map((m) => m.uid)
}

export interface MonthlyCardView {
  title: string
  subtitle: string
  /** The row's glyph: a calendar for a list, two people for a judge. */
  icon: IconName
  /** The mini score beside it: provisional (graphite) until revealed. */
  score?: { value: number | null; provisional: boolean }
}

export interface MonthlyCardInput {
  space: Pick<Space, 'timezone' | 'schedule' | 'memberIds' | 'judges' | 'utcOffsetMin'>
  me: UID
  nowMs: number
  /** undefined while it loads (the card waits rather than flash). */
  data: MonthlyData | undefined
  /** computeMonthly of `data` (null without data). */
  result: WeekResult | null
  /** First names. */
  name: (uid: UID) => string
  /** A deadline in words ("Monday at midnight", "tonight at midnight"). */
  when: (ms: number) => string
}

/**
 * The monthly card on the Space screen (SPEC §9.5), or null when it doesn't show: shown when the list can exist
 * (its doc, or before its lock from 8 days before its first week, in a space with `utcOffsetMin`) and either
 * it hasn't locked, someone has a list, or you judge it. Someone outside a locked list doesn't see it.
 */
export function monthlyCardView({ space, me, nowMs, data, result, name, when }: MonthlyCardInput): MonthlyCardView | null {
  if (!data || !result || space.utcOffsetMin === undefined || !space.memberIds.includes(me)) return null
  const month = monthName(data.monthId)
  const list = data.monthly
  const bounds = monthlyBoundsOf(space, data)
  const phase = weekPhase(bounds, nowMs)
  // The list's snapshot decides (setJudge writes it with the space's); before you're in it, the space's choice.
  const judging = list && list.members.includes(me) ? judgesOf(list).includes(me) : spaceJudges(space).includes(me)
  const judgeView = (subtitle: string): MonthlyCardView => ({ title: `${month} lists`, subtitle, icon: 'person2' })
  const inReview = (): string | null => {
    if (phase === 'review' && !result.revealed) return `In review · due ${when(bounds.deadlineAt)}`
    if (phase === 'review' || phase === 'closed') return 'Results are in'
    return null
  }

  if (phase === 'planning') {
    if (!list && nowMs < bounds.startAt - MONTHLY_LEAD_MS) return null
    if (judging) return judgeView(`You rate them in ${month}’s last week.`)
    const plan = data.plans[me]?.tasks ?? []
    if (plan.length === 0) {
      return { title: `Your ${month} list`, subtitle: `Optional: a few bigger things for ${month}. Locks ${when(bounds.lockAt)}.`, icon: 'calendar' }
    }
    return { title: `Your ${month} list`, subtitle: `${tasks(plan.length)} · locks ${when(bounds.lockAt)}`, icon: 'calendar' }
  }

  // Locked: only the list's own members see it, and only when there is something in it for them.
  if (!list || !list.members.includes(me)) return null
  if (judging) return judgeView(inReview() ?? `You rate them in ${month}’s last week.`)
  const mine: MemberWeekResult | undefined = result.members[me]
  if (mine && mine.taskCount > 0) {
    if (result.revealed && mine.skipped) return { title: `Your ${month} list`, subtitle: SKIPPED_PERIOD, icon: 'calendar' }
    if (result.revealed && mine.score !== null) {
      return { title: `Your ${month} list`, subtitle: `Score ${formatScore(mine.score)}`, icon: 'calendar', score: { value: mine.score, provisional: false } }
    }
    // Crossed-out tasks don't count yet (SPEC §10.5): "2 of 3 done" leaves them out. Every task crossed out: no
    // provisional score, so no ring (as on the member card); the subtitle says why.
    const { open, done } = openCount(mine)
    const progress = open === 0 ? 'Tasks crossed out' : `${done} of ${open} done`
    const subtitle = phase === 'review' ? `In review · due ${when(bounds.deadlineAt)}` : progress
    const view: MonthlyCardView = { title: `Your ${month} list`, subtitle, icon: 'calendar' }
    if (mine.provisionalScore !== null) view.score = { value: mine.provisionalScore, provisional: true }
    return view
  }
  const holders = listHolders(result).filter((id) => id !== me)
  if (holders.length === 0) return null
  const who = compactNames(holders.map(name))
  return {
    title: `${month} lists`,
    subtitle: inReview() ?? `${who} ${holders.length === 1 ? 'has' : 'have'} one. Yours is optional; you’ll review theirs in ${month}’s last week.`,
    icon: 'calendar',
  }
}

export interface PillView {
  text: string
  icon: IconName
  urgent: boolean
}

/** The monthly screen's countdown pill: "Locks in 2d 4h", "Reviews open in 18d", "Reviews due in 5h" (urgent
 *  while your reviews are due), "Results are in". */
export function monthlyPill(phase: WeekPhase, bounds: WeekBounds, nowMs: number, revealed: boolean, due: boolean): PillView {
  switch (phase) {
    case 'planning':
      return { text: `Locks in ${formatCountdown(bounds.lockAt - nowMs)}`, icon: 'lock', urgent: bounds.lockAt - nowMs < 6 * 3_600_000 }
    case 'active':
      return { text: `Reviews open in ${formatCountdown(bounds.reviewOpenAt - nowMs)}`, icon: 'clock', urgent: false }
    case 'review':
      if (!revealed) return { text: `Reviews due in ${formatCountdown(bounds.deadlineAt - nowMs)}`, icon: 'clock', urgent: due }
      return { text: 'Results are in', icon: 'trophy', urgent: false }
    case 'closed':
      return { text: 'Results are in', icon: 'trophy', urgent: false }
  }
}

/** A judge's line in the Judges section (SPEC §9.4): "Judge" before the review window, "Reviews in" / "Still
 *  reviewing" during it, "Reviewed", "Didn’t review" or "Nothing to review" once closed; "Left · …" after leaving. */
export function judgeDetail(member: MemberWeekResult, phase: WeekPhase, former: boolean): string {
  let text = 'Judge'
  if (phase === 'review') text = member.hasSubmitted ? 'Reviews in' : 'Still reviewing'
  else if (phase === 'closed') text = member.missedReviewsOf.length > 0 ? 'Didn’t review' : member.hasSubmitted ? 'Reviewed' : 'Nothing to review'
  return former ? `Left · ${text}` : text
}

/** The planning footer under your monthly list. */
export function planningFooter(taskCount: number, lockText: string): string {
  return taskCount === 0
    ? `Optional. Bigger things that take the month. Locks ${lockText}.`
    : `Saves as you type. Locks ${lockText}. After that you can still add tasks, but not change them.`
}

/** Under your locked list while tasks can still be added (SPEC §10.5): until its reviews open, `untilText`. */
export function addWindowFooter(untilText: string): string {
  return `Locked. You can still add tasks until ${untilText}. Friends see the date you added them.`
}

/** The add sheet's footer for a monthly list: `month` "October", `today` "October 24" (the day it is added). */
export function monthlyAddFooter(month: string, today: string): string {
  return `The task joins your ${month} list and gets reviewed in ${month}’s last week. Friends see it was added on ${today}. Once added, it can’t be edited or removed.`
}

/**
 * You can add to your locked monthly list now (SPEC §10.2): in its add window (`lockAt ≤ now < reviewOpenAt`), still
 * in the space, a player of the list (not its judge) with ≥ 1 task on it (a list empty at its lock never grows).
 */
export function canAddToList(list: Pick<MonthlyData, 'monthly' | 'plans'>, me: UID, memberIds: readonly UID[], nowMs: number): boolean {
  const period = list.monthly
  if (!period || !memberIds.includes(me) || !period.members.includes(me) || judgesOf(period).includes(me)) return false
  if (nowMs < period.lockAt || nowMs >= period.reviewOpenAt) return false
  return (list.plans[me]?.tasks.length ?? 0) > 0
}

/** "Kim and Ana have no October list." (players in a locked list without tasks), or null. */
export function noListNote(month: string, names: string[]): string | null {
  if (names.length === 0) return null
  return `${compactNames(names)} ${names.length === 1 ? 'has' : 'have'} no ${month} list.`
}

function inZone(ms: number, tz: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: tz }).format(ms).replace(/[  ]/g, ' ')
  } catch {
    return new Intl.DateTimeFormat('en-US', options).format(ms).replace(/[  ]/g, ' ')
  }
}

/** The calendar day of `ms` in `tz`, as a day number. */
function dayIn(ms: number, tz: string): number {
  const [month, day, year] = inZone(ms, tz, { year: 'numeric', month: 'numeric', day: 'numeric' }).split('/').map(Number)
  return Date.UTC(year, month - 1, day) / DAY_MS
}

/**
 * A list's deadline in words. Within the coming week, `near` words it ("Monday at midnight", "tomorrow at
 * midnight": deadlineText); further out a weekday alone would be ambiguous, so it names the date on the space's
 * clock: "Monday, Oct 5 at midnight" (a midnight ends the day before it), "Monday, Oct 5 at 8:00 PM".
 */
export function listWhen(ms: number, tz: string, nowMs: number, near: (ms: number) => string): string {
  const midnight = inZone(ms, tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) === '00:00'
  const day = midnight ? ms - 1 : ms
  if (dayIn(day, tz) - dayIn(nowMs, tz) < 7) return near(ms)
  const date = inZone(day, tz, { weekday: 'long', month: 'short', day: 'numeric' })
  return `${date} at ${midnight ? 'midnight' : inZone(ms, tz, { hour: 'numeric', minute: '2-digit' })}`
}

export interface StatusView {
  title: string
  subtitle: string
  icon: IconName
  urgent: boolean
  /** Tapping opens the review sheet. */
  opens: boolean
}

export interface MonthlyStatusInput {
  result: WeekResult
  me: UID
  /** The space's current members: only they can still review, so only they are waited for. */
  memberIds: UID[]
  /** Your part from reviewParts. */
  part: { open: boolean; targets: UID[] }
  month: string
  /** The list's deadline in words. */
  due: string
  latePenalty: number
  /** Missed monthly reviews cost nothing (the month's last week is paused). */
  penaltyFree: boolean
  name: (uid: UID) => string
}

/**
 * The monthly part's review line on the monthly screen, in its review window until the reveal: your reviews are
 * due, there is nobody to review (confirm), or you're waiting, for friends or, when only someone who left holds
 * it, for the deadline (SPEC §9.6). Null otherwise.
 */
export function monthlyReviewStatus({ result, me, memberIds, part, month, due, latePenalty, penaltyFree, name }: MonthlyStatusInput): StatusView | null {
  const mine = result.members[me]
  if (result.phase !== 'review' || result.revealed || !mine?.participating) return null
  const friends = Object.values(result.members)
    .filter((m) => m.participating && m.uid !== me && memberIds.includes(m.uid))
    .map((m) => m.uid)
  if (!mine.hasSubmitted) {
    if (!part.open) return null
    if (part.targets.length > 0) {
      let subtitle = `Due ${due}. Each friend you skip costs you ${latePenalty} points.`
      if (mine.judge) subtitle = `Due ${due}. Your friends’ results wait for you.`
      else if (penaltyFree) subtitle = `Due ${due}.`
      return { title: 'Your review is due', subtitle, icon: 'person2', urgent: true, opens: true }
    }
    if (friends.length === 0) return null
    return { title: 'Nothing to review', subtitle: `None of your friends has a list for ${month}. Confirm so results can unlock.`, icon: 'checkmark', urgent: false, opens: true }
  }
  const waiting = friends.filter((id) => !result.members[id].hasSubmitted)
  if (waiting.length === 0) {
    return { title: 'Reviews in', subtitle: `Results come in at the deadline, ${due}. A friend who left can’t review anymore.`, icon: 'clock', urgent: false, opens: false }
  }
  return {
    title: `Submitted. Waiting for ${waiting.length}`,
    subtitle: `${listNames(waiting.map(name))} still reviewing. Results ${due} at the latest.`,
    icon: 'clock',
    urgent: false,
    opens: false,
  }
}
