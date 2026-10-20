// Shared goals (batch 3, SPEC §11.7): one team target a group of friends fills together, week by week. Pure:
// shared by the screens, the data layer and the reminders job (its check-in push uses the dates and isGoalId).
//
// Stored amounts are ints in hundredths (target100, total100, totals100, amount100: SPEC §11.3) so the rules can
// check the running total with `==`; domain and screen types use real units (the decoder divides by 100). Every
// write goes through toHundredths, and applyCheckin does the rules' own int arithmetic.
import { CURRENCIES, formatMoney, readAmount } from './money.ts'
import { momentAt, weekIdFor } from './time.ts'
import type { Checkin, SharedGoal, SharedGoalsView, UID, WeekId } from './types.ts'

/** Members + invited, at most. */
export const SHARED_MAX_PEOPLE = 8
export const SHARED_NAME_MAX = 60
export const SHARED_UNIT_MAX = 16
export const CHECKIN_NOTE_MAX = 80
/** The largest target or check-in, in the goal's unit (10¹¹ hundredths in the rules). */
export const MAX_GOAL_AMOUNT = 1e9
/** The unit chips of the New Shared Goal sheet (it adds your currency code). */
export const SHARED_UNITS: readonly string[] = Object.freeze(['km', 'books', 'hours', 'times'])

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const GOAL_ID = /^[A-Za-z0-9]{1,40}$/
const DATE_ID = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * The amount × 100 as an int, the way it is stored. Float noise is shaved first, as roundMoney does, so a value
 * typed with two decimals always lands on its own int (0.29 → 29, 1.005 → 101, never 28 or 100).
 */
export function toHundredths(x: number): number {
  // NaN and ±Infinity stay unusable (the rules refuse them) rather than turning into a plausible 0.
  if (!Number.isFinite(x)) return Number.NaN
  const scaled = Math.round(Number((Math.abs(x) * 100).toPrecision(15)))
  // `|| 0` turns −0 into 0.
  return Math.sign(x) * scaled || 0
}

export function fromHundredths(n: number): number {
  return n / 100
}

/**
 * Reads a target or a check-in the way parseAmount reads money ('1,250.5', '12,5', '$500'; a lone separator before
 * exactly three digits groups thousands), but keeps what was typed: more than 2 decimals is unreadable, not rounded.
 * null when empty, unreadable, negative or over MAX_GOAL_AMOUNT.
 */
export function parseGoalAmount(text: string): number | null {
  const read = readAmount(text)
  return read && amountProblem(text) === null ? read.value : null
}

export type AmountProblem = 'empty' | 'format' | 'big'

/** Why an amount field can't be saved yet, or null. */
export function amountProblem(text: string): AmountProblem | null {
  if (text.trim() === '') return 'empty'
  const read = readAmount(text)
  if (!read || read.decimals > 2 || !Number.isFinite(read.value)) return 'format'
  return read.value > MAX_GOAL_AMOUNT ? 'big' : null
}

export function amountProblemText(p: AmountProblem): string {
  switch (p) {
    case 'empty':
      return 'Enter 0 or more.'
    case 'format':
      return 'Use a number, like 12.5.'
    case 'big':
      return 'That number is too big.'
  }
}

/** A check-in note on one line: line breaks (CR, LF, U+2028, U+2029), and the spaces around them, become one space;
 *  trimmed. The rules refuse a note with a line break. */
export function cleanNote(text: string): string {
  return text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ').trim()
}

/** 'long' when the cleaned note is over CHECKIN_NOTE_MAX UTF-16 units. */
export function noteProblem(text: string): 'long' | null {
  return cleanNote(text).length > CHECKIN_NOTE_MAX ? 'long' : null
}

export function noteProblemText(p: 'long'): string {
  void p
  return 'Keep the note to 80 characters.'
}

/** The unit is one of CURRENCIES' codes ("USD"): the goal is money and shows as money. */
export function isCurrencyUnit(unit: string): boolean {
  return CURRENCIES.some((c) => c.code === unit)
}

const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

/** "1,250.5": en-US grouping, up to 2 decimals, trailing zeros dropped. */
export function formatGoalNumber(x: number): string {
  // A value that rounds to zero never shows a minus.
  return NUMBER.format(Number.isFinite(x) ? x : 0).replace(/^-0$/, '0')
}

/** "1,250.5 km", "20 books"; a currency unit as money: "$4,200.50". */
export function formatGoalAmount(x: number, unit: string): string {
  return isCurrencyUnit(unit) ? formatMoney(x, unit) : `${formatGoalNumber(x)} ${unit}`
}

/** "64 of 100 km"; money: "$4,200 of $5,000". */
export function progressText(goal: Pick<SharedGoal, 'total' | 'target' | 'unit'>): string {
  if (isCurrencyUnit(goal.unit)) return `${formatMoney(goal.total, goal.unit)} of ${formatMoney(goal.target, goal.unit)}`
  return `${formatGoalNumber(goal.total)} of ${formatGoalNumber(goal.target)} ${goal.unit}`
}

export type GoalProblem = 'name' | 'name-long' | 'unit' | 'unit-long' | 'target' | 'target-big'

/**
 * What stops a goal from being saved, first problem first, or null. Name and unit are checked trimmed, which is what
 * the data layer writes; a target must be above 0 once stored in hundredths (0.004 isn't).
 */
export function goalProblem(input: { name: string; unit: string; target: number | null }): GoalProblem | null {
  const name = input.name.trim()
  if (name === '') return 'name'
  if (name.length > SHARED_NAME_MAX) return 'name-long'
  const unit = input.unit.trim()
  if (unit === '') return 'unit'
  if (unit.length > SHARED_UNIT_MAX) return 'unit-long'
  const target = input.target
  if (target === null || !Number.isFinite(target) || toHundredths(target) < 1) return 'target'
  if (target > MAX_GOAL_AMOUNT) return 'target-big'
  return null
}

export function goalProblemText(p: GoalProblem): string {
  switch (p) {
    case 'name':
      return 'Give the goal a name.'
    case 'name-long':
      return 'Keep the name to 60 characters.'
    case 'unit':
      return 'Add a unit, like km or books.'
    case 'unit-long':
      return 'Keep the unit to 16 characters.'
    case 'target':
      return 'Enter a target above 0.'
    case 'target-big':
      return 'That number is too big.'
  }
}

/** 1–40 letters and digits, as the rules check on create: safe in doc ids, push keys, tags and URLs. */
export function isGoalId(id: unknown): id is string {
  return typeof id === 'string' && GOAL_ID.test(id)
}

/** A check-in's doc id: one per member per week. */
export function checkinId(weekId: WeekId, uid: UID): string {
  return `${weekId}_${uid}`
}

// ---------- Dates: the goal's week is the space week (Monday to Sunday) in the goal's zone ----------

/** This week in the goal's zone (its Monday). */
export function goalWeek(goal: Pick<SharedGoal, 'timezone'>, nowMs: number): WeekId {
  return weekIdFor(nowMs, goal.timezone)
}

/** When check-ins stop: the start of the day after `endsOn` in the goal's zone (DST-correct), or null without an
 *  end date (or with one that isn't a date). */
export function goalEndsAt(goal: Pick<SharedGoal, 'endsOn' | 'timezone'>): number | null {
  if (goal.endsOn === null) return null
  try {
    // momentAt is calendar math from any date: 1440 minutes = the next day's first instant.
    return momentAt(goal.endsOn, goal.timezone, 1440)
  } catch {
    return null
  }
}

/**
 * The rules' upper bound for a check-in of `weekId` (SPEC §11.5): the week's Monday on the creation offset, + 7 days
 * + the hour of DST slack. Against the true week end in the goal's zone it is the same instant (a goal created in
 * summer, in winter) or up to 2 hours later (created in winter, in summer). NaN for a malformed week id.
 */
export function checkinClosesAt(goal: Pick<SharedGoal, 'utcOffsetMin'>, weekId: WeekId): number {
  const m = DATE_ID.exec(weekId)
  if (!m) return Number.NaN
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - goal.utcOffsetMin * MINUTE + 7 * DAY + HOUR
}

export type GoalStatus = 'finished' | 'ended' | 'reached' | 'active'

/** Exact comparison on the stored ints. */
function reachedOf(goal: Pick<SharedGoal, 'total' | 'target'>): boolean {
  return toHundredths(goal.total) >= toHundredths(goal.target)
}

/** In this precedence: finished (archivedAt), ended (now ≥ goalEndsAt), reached (total ≥ target), active. */
export function goalStatus(goal: SharedGoal, nowMs: number): GoalStatus {
  if (goal.archivedAt !== null) return 'finished'
  const endsAt = goalEndsAt(goal)
  if (endsAt !== null && nowMs >= endsAt) return 'ended'
  return reachedOf(goal) ? 'reached' : 'active'
}

/** A member of a goal that is neither finished nor ended (a reached goal keeps taking check-ins). */
export function canCheckIn(goal: SharedGoal, me: UID, nowMs: number): boolean {
  if (!goal.memberIds.includes(me)) return false
  const status = goalStatus(goal, nowMs)
  return status !== 'finished' && status !== 'ended'
}

export interface GoalProgress {
  total: number
  target: number
  /** total / target, 0..1 (capped). */
  ratio: number
  /** What's still needed, ≥ 0. */
  left: number
  reached: boolean
  /** How far past the target, ≥ 0. */
  over: number
}

export function goalProgress(goal: SharedGoal): GoalProgress {
  const total100 = toHundredths(goal.total)
  const target100 = toHundredths(goal.target)
  const ratio = target100 > 0 ? Math.min(1, Math.max(0, total100 / target100)) : total100 > 0 ? 1 : 0
  return {
    total: goal.total,
    target: goal.target,
    ratio,
    left: Math.max(0, target100 - total100) / 100,
    reached: target100 > 0 && total100 >= target100,
    over: Math.max(0, total100 - target100) / 100,
  }
}

export interface GoalShare {
  uid: UID
  amount: number
  /** Its segment of the bar: amount / target, scaled down once the total passes the target. */
  ratio: number
  /** No longer a member (left, or deleted their account): the part stays. */
  former: boolean
}

/** Everyone with a part > 0, largest first (ties by uid). The ratios sum to min(1, total / target). */
export function goalShares(goal: SharedGoal): GoalShare[] {
  const parts = Object.entries(goal.totals)
    .filter(([, amount]) => Number.isFinite(amount) && amount > 0)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
  const sum = parts.reduce((s, [, amount]) => s + amount, 0)
  const scale = Math.max(goal.target, goal.total, sum)
  return parts.map(([uid, amount]) => ({ uid, amount, ratio: scale > 0 ? amount / scale : 0, former: !goal.memberIds.includes(uid) }))
}

/** Current members with no check-in for `weekId`. */
export function waitingFor(goal: SharedGoal, checkins: Checkin[], weekId: WeekId): UID[] {
  const done = new Set(checkins.filter((c) => c.weekId === weekId).map((c) => c.uid))
  return goal.memberIds.filter((uid) => !done.has(uid))
}

export interface WeekProgress {
  weekId: WeekId
  /** One row per current member, in `memberIds` order: their check-in for the week, or null ("Not yet"). */
  rows: { uid: UID; checkin: Checkin | null }[]
  /** What the current members checked in that week, summed exactly (in hundredths). */
  total: number
  /** How many current members have checked in. */
  done: number
}

/**
 * The "This week" section: each current member's check-in for `weekId` (a former member's leftover, or another
 * week's, is ignored) and the week's total. The goal's running total (goalProgress) already includes it.
 */
export function weekProgress(goal: Pick<SharedGoal, 'memberIds'>, checkins: Checkin[], weekId: WeekId): WeekProgress {
  const byUid = new Map<UID, Checkin>()
  for (const c of checkins) if (c.weekId === weekId && !byUid.has(c.uid)) byUid.set(c.uid, c)
  const rows = goal.memberIds.map((uid) => ({ uid, checkin: byUid.get(uid) ?? null }))
  const total100 = rows.reduce((sum, r) => sum + (r.checkin ? toHundredths(r.checkin.amount) || 0 : 0), 0)
  return { weekId, rows, total: fromHundredths(total100), done: rows.filter((r) => r.checkin !== null).length }
}

/**
 * The goal's side of a check-in (or an edit of one), on the stored ints, exactly as the rules' `checksIn` checks it:
 * delta = new100 − old100 (old100: that week's earlier check-in, 0 for none); `totals100[uid]` and `total100` move by
 * delta. `reached`: 'now' when this write reaches the target (write reachedAt = server time), 'keep' when it was
 * already reached (leave reachedAt alone), 'none' when the total is below the target (reachedAt must be null: write
 * null if it was set).
 */
export function applyCheckin(
  g: { totals100: Record<UID, number>; total100: number; target100: number; reachedAt: number | null },
  uid: UID,
  old100: number,
  new100: number,
): { totals100: Record<UID, number>; total100: number; reached: 'keep' | 'now' | 'none' } {
  const delta = new100 - old100
  const totals100: Record<UID, number> = Object.fromEntries(Object.entries(g.totals100))
  totals100[uid] = (Object.hasOwn(g.totals100, uid) ? g.totals100[uid] : 0) + delta
  const total100 = g.total100 + delta
  const reached = total100 >= g.target100 ? (g.reachedAt !== null ? 'keep' : 'now') : 'none'
  return { totals100, total100, reached }
}

/** Invitations you can still act on: to goals that are neither finished nor ended (what the badge counts). */
export function openInvites(view: SharedGoalsView, nowMs: number): SharedGoal[] {
  return view.invites.filter((goal) => {
    const status = goalStatus(goal, nowMs)
    return status !== 'finished' && status !== 'ended'
  })
}

/**
 * Who owns the goal after `leaving` goes: the earliest-joined other member (ties by uid; a member without a join time
 * last), null when nobody remains. What leaveSharedGoal writes when the owner leaves, and what the rules'
 * earliestJoined accepts.
 */
export function nextOwner(goal: SharedGoal, leaving: UID): UID | null {
  const joined = (uid: UID) => {
    const at = Object.hasOwn(goal.joinedAt, uid) ? goal.joinedAt[uid] : undefined
    return typeof at === 'number' && Number.isFinite(at) ? at : Number.POSITIVE_INFINITY
  }
  const rest = goal.memberIds.filter((uid) => uid !== leaving)
  rest.sort((a, b) => joined(a) - joined(b) || (a < b ? -1 : a > b ? 1 : 0))
  return rest[0] ?? null
}
