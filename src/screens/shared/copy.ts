// The shared-goal screens' wording (SPEC §11.9.5), kept pure so Node tests it. Dates read on the device's calendar
// (`tz`, the device's zone by default) except a goal's own days (its week, its end date), which are calendar days
// already: "{Mon d}" is "Oct 18", with the year once it isn't this year.
import { formatMoney } from '../../domain/money.ts'
import {
  canCheckIn,
  fromHundredths,
  formatGoalAmount,
  formatGoalNumber,
  goalEndsAt,
  goalProgress,
  goalStatus,
  isCurrencyUnit,
  progressText,
  SHARED_MAX_PEOPLE,
  toHundredths,
} from '../../domain/shared.ts'
import type { Checkin, CurrencyCode, SharedGoal, UID, WeekId } from '../../domain/types.ts'
import { firstName } from '../components/people.ts'
import { cityOf, deviceZone } from '../components/zone.ts'

const DAY = 86_400_000
/** A goal's row says when it ends once the end is this close. */
const ENDS_SOON_DAYS = 14
/** Invitations a new goal can send: everyone but you. */
export const MAX_INVITES = SHARED_MAX_PEOPLE - 1

export { unitFor } from '../../domain/shared.ts'

/** "12.5 km", "1 book", "$4,200.50": the domain's formatGoalAmount (the unit agrees with the number). */
export const amountText = formatGoalAmount

/** "64 of 100 km", "$4,200 of $5,000", "0 of 1 book": the domain's progressText (the push says the same). */
export const progressLine = progressText

const formats = new Map<string, Intl.DateTimeFormat>()
function format(tz: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${tz}|${JSON.stringify(options)}`
  let f = formats.get(key)
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { ...options, timeZone: tz })
    } catch {
      f = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' })
    }
    formats.set(key, f)
  }
  return f
}

function yearOf(ms: number, tz: string): number {
  return Number(format(tz, { year: 'numeric' }).format(ms))
}

/** "Oct 18" on `tz`'s calendar, or "Oct 18, 2025" when it isn't this year there. */
export function monDay(ms: number, nowMs: number, tz: string = deviceZone()): string {
  const sameYear = yearOf(ms, tz) === yearOf(nowMs, tz)
  return format(tz, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }).format(ms)
}

const DAY_ID = /^(\d{4})-(\d{2})-(\d{2})$/

/** A calendar day ('YYYY-MM-DD') as a UTC midnight, or NaN. */
function dayMs(dayId: string): number {
  const m = DAY_ID.exec(dayId)
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : Number.NaN
}

/** A calendar day ('2026-12-31') as "Dec 31" (with the year when it isn't this year on `tz`'s calendar). */
export function dayText(dayId: string, nowMs: number, tz: string = deviceZone()): string {
  const ms = dayMs(dayId)
  if (Number.isNaN(ms)) return dayId
  const sameYear = new Date(ms).getUTCFullYear() === yearOf(nowMs, tz)
  return format('UTC', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }).format(ms)
}

/** A goal's week (Monday to Sunday): "Oct 19–25", "Oct 26–Nov 1". */
export function weekRange(weekId: WeekId): string {
  const start = dayMs(weekId)
  if (Number.isNaN(start)) return weekId
  const end = start + 6 * DAY
  const month = format('UTC', { month: 'short' })
  const day = (ms: number) => new Date(ms).getUTCDate()
  if (new Date(start).getUTCMonth() === new Date(end).getUTCMonth()) return `${month.format(start)} ${day(start)}–${day(end)}`
  return `${month.format(start)} ${day(start)}–${month.format(end)} ${day(end)}`
}

/** "This week · Oct 19–25". */
export function thisWeekHeader(weekId: WeekId): string {
  return `This week · ${weekRange(weekId)}`
}

/** "1 person", "3 people". */
export function peopleText(n: number): string {
  return n === 1 ? '1 person' : `${n} people`
}

/** The hero's big number: "64", or "$4,200" for money. */
export function bigNumber(goal: Pick<SharedGoal, 'total' | 'unit'>): string {
  return isCurrencyUnit(goal.unit) ? formatMoney(goal.total, goal.unit as CurrencyCode) : formatGoalNumber(goal.total)
}

/** Under the big number: "of 100 km", "of $5,000". */
export function ofTarget(goal: Pick<SharedGoal, 'target' | 'unit'>): string {
  return `of ${amountText(goal.target, goal.unit)}`
}

/** The goal ends within 14 days (and hasn't yet). */
export function endsSoon(goal: Pick<SharedGoal, 'endsOn' | 'timezone'>, nowMs: number): boolean {
  const endsAt = goalEndsAt(goal)
  return endsAt !== null && endsAt > nowMs && endsAt - nowMs <= ENDS_SOON_DAYS * DAY
}

/**
 * The hero's status line: active "36 km to go · Ends Dec 31", reached "Reached Oct 20 · 104 of 100 km", ended
 * "Ended Dec 31", finished "Finished Oct 30".
 */
export function statusLine(goal: SharedGoal, nowMs: number, tz: string = deviceZone()): string {
  switch (goalStatus(goal, nowMs)) {
    case 'finished':
      return `Finished ${monDay(goal.archivedAt ?? nowMs, nowMs, tz)}`
    case 'ended':
      return `Ended ${dayText(goal.endsOn ?? '', nowMs, tz)}`
    case 'reached':
      return goal.reachedAt !== null ? `Reached ${monDay(goal.reachedAt, nowMs, tz)} · ${progressLine(goal)}` : `Reached · ${progressLine(goal)}`
    case 'active': {
      const left = `${amountText(goalProgress(goal).left, goal.unit)} to go`
      return goal.endsOn ? `${left} · Ends ${dayText(goal.endsOn, nowMs, tz)}` : left
    }
  }
}

/** A goal's row in Shared Goals: "64 of 100 km · 3 people" (+ " · Ends Dec 31" within 14 days); "Reached · …". */
export function rowSubtitle(goal: SharedGoal, nowMs: number, tz: string = deviceZone()): string {
  const parts = [progressLine(goal), peopleText(goal.memberIds.length)]
  if (goal.endsOn && endsSoon(goal, nowMs)) parts.push(`Ends ${dayText(goal.endsOn, nowMs, tz)}`)
  const line = parts.join(' · ')
  return goalStatus(goal, nowMs) === 'reached' ? `Reached · ${line}` : line
}

/** An invitation's row: "Lena invited you · 64 of 100 km". */
export function inviteSubtitle(inviter: string, goal: SharedGoal): string {
  return `${firstName(inviter)} invited you · ${progressLine(goal)}`
}

/** The invitee view's line: "Lena invited you." */
export function invitedYou(inviter: string): string {
  return `${firstName(inviter)} invited you.`
}

/** A row in Finished: "104 of 100 km · Finished Oct 30", or "· Ended Dec 31". */
export function finishedSubtitle(goal: SharedGoal, nowMs: number, tz: string = deviceZone()): string {
  const when = goal.archivedAt !== null ? `Finished ${monDay(goal.archivedAt, nowMs, tz)}` : `Ended ${dayText(goal.endsOn ?? '', nowMs, tz)}`
  return `${progressLine(goal)} · ${when}`
}

/** When a goal finished or ended, for sorting Finished newest first. */
function closedAt(goal: SharedGoal): number {
  return goal.archivedAt ?? goalEndsAt(goal) ?? 0
}

/** Finished or ended goals, newest first. */
export function finishedGoals(goals: SharedGoal[], nowMs: number): SharedGoal[] {
  return goals
    .filter((g) => {
      const s = goalStatus(g, nowMs)
      return s === 'finished' || s === 'ended'
    })
    .sort((a, b) => closedAt(b) - closedAt(a) || a.name.localeCompare(b.name))
}

/**
 * Your goals in Shared Goals: neither finished nor ended; those waiting for your check-in this week first, then by
 * name. `checkedIn[goalId]`: whether you checked in this week (unknown yet: not waiting).
 */
export function sectionGoals(goals: SharedGoal[], me: UID, nowMs: number, checkedIn: Record<string, boolean | undefined>): SharedGoal[] {
  const open = goals.filter((g) => {
    const s = goalStatus(g, nowMs)
    return s !== 'finished' && s !== 'ended' && g.memberIds.includes(me)
  })
  const waiting = (g: SharedGoal) => (canCheckIn(g, me, nowMs) && checkedIn[g.id] === false ? 0 : 1)
  return open.sort((a, b) => waiting(a) - waiting(b) || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Someone's part in Everyone's part: "47%" of the total (+ " · Left" for a former member). */
export function shareSubtitle(amount: number, total: number, former: boolean): string {
  const pct = total > 0 ? Math.round((amount / total) * 100) : 0
  return former ? `${pct}% · Left` : `${pct}%`
}

/** Details' footer: "Weeks run Monday to Sunday, Berlin time." */
export function weeksFooter(timezone: string): string {
  return `Weeks run Monday to Sunday, ${cityOf(timezone)} time.`
}

export const SECTION_FOOTER = 'Fill a target together, like 100 km or 20 books. Everyone checks in their part each week.'
export const THIS_WEEK_FOOTER = 'Check in your part once a week. Missed a week? Add it to this week’s number.'
export const TARGET_FOOTER = 'What you’ll reach together. Everyone checks in their part each week.'
export const END_DATE_FOOTER = 'Optional. Check-ins stop after this day.'
export const NO_FRIENDS = 'Add friends first, then invite them here.'
export const KEEP_GOING_FOOTER = 'Raise the target to keep going.'
export const FORMER_MEMBER = 'A former member'
export const MOMENT_TITLE = 'You did it together'
/** The data layer's refusal of a week that just ended (the sheet then moves to the new week). */
export const WEEK_ENDED = 'That week just ended. Check in for this week instead.'

/** The moment's card: "Run 100 km: 104 of 100 km." */
export function momentText(goal: SharedGoal): string {
  return `${goal.name}: ${progressLine(goal)}.`
}

/** The moment's card for everyone but the owner: "Keep checking in, or Lena can finish it." */
export function momentOthers(owner: string | null): string {
  return `Keep checking in, or ${owner ? firstName(owner) : 'the owner'} can finish it.`
}

/** New Shared Goal's invite footer: "3 of 7 spots. They can join or decline." */
export function newInviteFooter(selected: number): string {
  return `${selected} of ${MAX_INVITES} spots. They can join or decline.`
}

/** Invite Friends' footer, as you pick: "2 spots left. Only friends can be invited." */
export function spotsLeftFooter(left: number): string {
  const spots = left <= 0 ? 'No spots left' : left === 1 ? '1 spot left' : `${left} spots left`
  return `${spots}. Only friends can be invited.`
}

/** Spots a goal still has for invitations (members + invited ≤ 8). */
export function spotsLeft(goal: Pick<SharedGoal, 'memberIds' | 'invited'>): number {
  return Math.max(0, SHARED_MAX_PEOPLE - goal.memberIds.length - goal.invited.length)
}

/** Check In's header: "Run 100 km · week of Oct 19". */
export function checkinHeader(name: string, weekId: WeekId): string {
  const ms = dayMs(weekId)
  const day = Number.isNaN(ms) ? weekId : format('UTC', { month: 'short', day: 'numeric' }).format(ms)
  return `${name} · week of ${day}`
}

/** What the team's total becomes if your check-in for the week is `next` instead of `old` (exact, in hundredths). */
export function teamTotal(goal: Pick<SharedGoal, 'total'>, old: number, next: number): number {
  return fromHundredths(toHundredths(goal.total) - toHundredths(old) + toHundredths(next))
}

/**
 * Check In's footer: first time "Your part this week. Missed a week? Add it here."; editing "You checked in 12 km
 * Wednesday. Saving replaces it."; plus "The team will be at 76 of 100 km." once the field holds an amount.
 */
export function checkinFooter(goal: SharedGoal, existing: Checkin | null, amount: number | null, tz: string = deviceZone()): string {
  const first = existing
    ? `You checked in ${amountText(existing.amount, goal.unit)} ${format(tz, { weekday: 'long' }).format(existing.at)}. Saving replaces it.`
    : 'Your part this week. Missed a week? Add it here.'
  if (amount === null) return first
  const total = teamTotal(goal, existing?.amount ?? 0, amount)
  return `${first} The team will be at ${progressLine({ ...goal, total })}.`
}

export interface ToastCopy {
  title: string
  message?: string
}

/** After saving a check-in that didn't reach the target: "Checked in" · "The team is at 76 of 100 km." */
export function checkedInToast(goal: Pick<SharedGoal, 'target' | 'unit'>, total: number): ToastCopy {
  return {
    title: 'Checked in',
    message: `The team is at ${progressLine({ ...goal, total })}.`,
  }
}

/** Join: "You joined Run 100 km" · "Check in your part each week." */
export function joinedToast(name: string): ToastCopy {
  return {
    title: `You joined ${name}`,
    message: 'Check in your part each week.',
  }
}

export interface Confirm {
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
}

export function finishConfirm(name: string): Confirm {
  return {
    title: `Finish ${name}?`,
    message: 'Check-ins stop and it moves to Finished. This can’t be undone.',
    confirmLabel: 'Finish',
    cancelLabel: 'Cancel',
  }
}

/**
 * Leave: "Your part stays in the total. To come back, you’ll need a new invite." plus, for the owner with others
 * left, " Sam becomes the owner." A finished goal only keeps the first sentence (it can't take invites). The last
 * member deletes the goal (SPEC §11.12): "You’re the last one here. The goal and its check-ins will be gone."
 */
export function leaveConfirm(goal: SharedGoal, me: UID, nextOwnerName: string | null): Confirm {
  const finished = goal.archivedAt !== null
  let message = finished ? 'Your part stays in the total.' : 'Your part stays in the total. To come back, you’ll need a new invite.'
  const others = goal.memberIds.filter((uid) => uid !== me)
  if (others.length === 0) message = 'You’re the last one here. The goal and its check-ins will be gone.'
  else if (!finished && goal.ownerId === me && nextOwnerName) message += ` ${firstName(nextOwnerName)} becomes the owner.`
  return {
    title: `Leave ${goal.name}?`,
    message,
    confirmLabel: 'Leave',
    cancelLabel: 'Cancel',
  }
}

/**
 * Edit Goal's footer for the draft target: at or under the total while not reached, "That’s already reached: the
 * goal will show as reached."; over the total while reached, "It won’t show as reached until you get there.";
 * else null.
 */
export function editTargetFooter(goal: Pick<SharedGoal, 'total' | 'reachedAt'>, target: number | null): string | null {
  if (target === null || !(target > 0)) return null
  const total100 = toHundredths(goal.total)
  const target100 = toHundredths(target)
  if (target100 <= total100 && goal.reachedAt === null) return 'That’s already reached: the goal will show as reached.'
  if (target100 > total100 && goal.reachedAt !== null) return 'It won’t show as reached until you get there.'
  return null
}

/** Today on the device's calendar, 'YYYY-MM-DD' (the end date's earliest choice). */
export function todayId(nowMs: number, tz: string = deviceZone()): string {
  const parts = format(tz, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(nowMs)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** The unit chips: km · books · hours · times · your currency code. */
export function unitChips(base: readonly string[], currency: string): string[] {
  return base.includes(currency) ? [...base] : [...base, currency]
}
