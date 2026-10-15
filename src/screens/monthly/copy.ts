// What the monthly card and the monthly screen say (SPEC §9.5), as pure functions of the list and the clock,
// so the copy is unit-tested without a DOM.
import { boundsFor } from '../../domain/schedule.ts'
import { judgesOf, spaceJudges } from '../../domain/scoring.ts'
import type { MemberWeekResult, WeekResult } from '../../domain/scoring.ts'
import { formatCountdown, monthlyBounds, weekPhase } from '../../domain/time.ts'
import type { WeekBounds, WeekPhase } from '../../domain/time.ts'
import type { MonthlyData, Space, UID } from '../../domain/types.ts'
import type { IconName } from '../../ui/icons.tsx'
import { formatScore, monthName } from '../components/format.ts'
import { compactNames } from '../components/people.ts'

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
  /** Your list's step ring (tasks done of n), or an icon. */
  lead: { kind: 'ring'; done: number; total: number } | { kind: 'icon'; icon: IconName }
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
  const judgeView = (subtitle: string): MonthlyCardView => ({ title: `${month} lists`, subtitle, lead: { kind: 'icon', icon: 'person2' } })
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
      return { title: `Your ${month} list`, subtitle: `Optional: a few bigger things for ${month}. Locks ${when(bounds.lockAt)}.`, lead: { kind: 'icon', icon: 'calendar' } }
    }
    const mine = result.members[me]
    const done = mine?.tasks.filter((t) => t.selfDone).length ?? 0
    return { title: `Your ${month} list`, subtitle: `${tasks(plan.length)} · locks ${when(bounds.lockAt)}`, lead: { kind: 'ring', done, total: plan.length } }
  }

  // Locked: only the list's own members see it, and only when there is something in it for them.
  if (!list || !list.members.includes(me)) return null
  if (judging) return judgeView(inReview() ?? `You rate them in ${month}’s last week.`)
  const mine: MemberWeekResult | undefined = result.members[me]
  if (mine && mine.taskCount > 0) {
    const done = mine.tasks.filter((t) => t.selfDone).length
    const lead = { kind: 'ring', done, total: mine.taskCount } as const
    if (result.revealed && mine.score !== null) {
      return { title: `Your ${month} list`, subtitle: `Score ${formatScore(mine.score)}`, lead, score: { value: mine.score, provisional: false } }
    }
    const subtitle = phase === 'review' ? `In review · due ${when(bounds.deadlineAt)}` : `${done} of ${mine.taskCount} done`
    return { title: `Your ${month} list`, subtitle, lead, score: { value: mine.provisionalScore, provisional: true } }
  }
  const holders = listHolders(result).filter((id) => id !== me)
  if (holders.length === 0) return null
  const who = compactNames(holders.map(name))
  return {
    title: `${month} lists`,
    subtitle: inReview() ?? `${who} ${holders.length === 1 ? 'has' : 'have'} one. Yours is optional; you’ll review theirs in ${month}’s last week.`,
    lead: { kind: 'icon', icon: 'calendar' },
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
    : `Saves as you type. Locks ${lockText}. After that you tick it off, but can’t add to it.`
}

/** "Kim and Ana have no October list." (players in a locked list without tasks), or null. */
export function noListNote(month: string, names: string[]): string | null {
  if (names.length === 0) return null
  return `${compactNames(names)} ${names.length === 1 ? 'has' : 'have'} no ${month} list.`
}
