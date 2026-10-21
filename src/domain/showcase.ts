// Profile showcase, rings and stats (batch 3, SPEC §11.7). Pure: the app (switches, items, views) and the reminders
// job (ringOf, statsOf, playedWeeks: it publishes rings/{uid} and stats/{uid} from the unreadable scores/{uid}).
//
// A showcase holds only copies of what its owner switched on; money stays in the owner-only docs. The ring is one
// number for friends (their score this month so far across their spaces), stats four totals for anyone (per the
// switch): nothing readable says which spaces someone is in or how they did in each.
import { balanceOf, earnedInMonth, fundGoals, MAX_AMOUNT, weeklyPace } from './money.ts'
import type { MemberMonthResult } from './scoring.ts'
import { FIRST_RESULTS_MONTH } from './stakes.ts'
import { addMonths, monthIdForWeek, weekIdFor } from './time.ts'
import type {
  AchievedGoal,
  CurrencyCode,
  Earning,
  Goal,
  MoneyMove,
  MoneyState,
  MonthId,
  Ring,
  RingFacts,
  RingView,
  ScoreEntry,
  ScoreMonths,
  ShowcaseDoc,
  ShowcaseItems,
  Showcase,
  ShowKey,
  ShownEarnings,
  ShownGoal,
  ShowSwitches,
  StatsFacts,
  StatsView,
  UserStats,
  WeekId,
} from './types.ts'

/** No showcase doc reads as this: stats on (effort, not money), the three money items off. */
export const DEFAULT_SHOW: ShowSwitches = Object.freeze({ stats: true, achieved: false, goals: false, earnings: false })
export const SHOWCASE_MAX_ACHIEVED = 12
export const SHOWCASE_MAX_GOALS = 8
export const SHOWCASE_NAME_MAX = 60
/** A month is cleared when every space's score reached it (the spaces' threshold, always 90). */
export const STATS_THRESHOLD = 90

/** Float noise: a mean of exactly 90 can compute as 89.99999999999999 (as everywhere in scoring). */
const EPS = 1e-9
const SHOW_KEYS: readonly ShowKey[] = ['stats', 'achieved', 'goals', 'earnings']
/** The switches that hold an item (all of them money). */
type ItemKey = 'achieved' | 'goals' | 'earnings'

/** The stored switches, or DEFAULT_SHOW without a doc. */
export function showOf(showcase: Showcase | null): ShowSwitches {
  const show = showcase?.show ?? DEFAULT_SHOW
  return { stats: show.stats, achieved: show.achieved, goals: show.goals, earnings: show.earnings }
}

/** Whitespace, control and invisible format characters: a name made only of these is blank (the rules' text()
 *  trims before checking it isn't empty, so a write holding one would be refused, and the whole showcase with it). */
const INVISIBLE = /[\s\u0000-\u001f\u007f-\u009f\u00ad\u180e\u200b-\u200f\u2060-\u2064\ufeff]/g

/** A name on one line, trimmed, at most SHOWCASE_NAME_MAX UTF-16 units without splitting a surrogate pair; '' when
 *  nothing visible is left. */
function itemName(text: string): string {
  let name = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ')
    .trim()
  if (name.length > SHOWCASE_NAME_MAX) {
    const cut = /[\uD800-\uDBFF]/.test(name[SHOWCASE_NAME_MAX - 1]) ? SHOWCASE_NAME_MAX - 1 : SHOWCASE_NAME_MAX
    name = name.slice(0, cut).trimEnd()
  }
  return name.replace(INVISIBLE, '') === '' ? '' : name
}

/** The month before the month of this week's Friday on `tz`'s clock. */
function previousMonth(nowMs: number, tz: string): MonthId {
  return addMonths(monthIdForWeek(weekIdFor(nowMs, tz)), -1)
}

/** The month before the device's money month (the month of this week's Friday, as Overview and Goals use). */
export function lastMoneyMonth(nowMs: number, tz: string): MonthId {
  return previousMonth(nowMs, tz)
}

function cents(x: number): number {
  return Number.isFinite(x) ? Math.round(Number((x * 100).toPrecision(15))) : 0
}

/**
 * Every item a showcase can hold, from the owner's own money (the hooks of SPEC §6.3), `tz` the device's zone:
 * achieved = goals marked Bought (spends with goal: true), newest first, ≤ 12, named by the move's note (blank ones
 * left out); goals = saving order, ≤ 8, names and whole percent funded (floored; 100 only when funded), never
 * amounts; earnings = what tasks earned in `input.monthId` (default lastMoneyMonth; the background sync passes
 * earningsBasis's), even 0.
 */
export function showcaseItems(
  input: { moves: MoneyMove[]; goals: Goal[]; earnings: Earning[]; state: MoneyState | null; currency: CurrencyCode; monthId?: MonthId },
  nowMs: number,
  tz: string,
): ShowcaseItems {
  const achieved: AchievedGoal[] = input.moves
    .filter((m) => m.goal === true && Number.isFinite(m.at) && m.at > 0)
    .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((m) => ({ name: itemName(typeof m.note === 'string' ? m.note : ''), at: m.at }))
    .filter((g) => g.name !== '')
    .slice(0, SHOWCASE_MAX_ACHIEVED)

  const balance = balanceOf(input.state, input.earnings, input.moves)
  const goals: ShownGoal[] = fundGoals(input.goals, balance, weeklyPace(input.earnings, input.moves, nowMs))
    .map((f) => {
      const cost = cents(f.goal.cost)
      // In whole cents, so 0.29 of 1.00 is 29%, not 28.999…%.
      const pct = f.complete || cost <= 0 ? 100 : Math.min(99, Math.floor((cents(f.funded) * 100) / cost))
      return { name: itemName(f.goal.name), pct: Math.max(0, pct) }
    })
    .filter((g) => g.name !== '')
    .slice(0, SHOWCASE_MAX_GOALS)

  const monthId = input.monthId ?? lastMoneyMonth(nowMs, tz)
  const amount = Math.min(MAX_AMOUNT, Math.max(0, earnedInMonth(input.earnings, monthId)))
  const earnings: ShownEarnings = { monthId, amount, currency: input.currency }
  return { achieved, goals, earnings }
}

/**
 * What the background sync's earnings copy is about: the same on every device of one user, so two devices never
 * rewrite each other's copy for ever (each write wakes the other device's sync).
 * - monthId: this device's lastMoneyMonth, or the stored copy's month when that is the month right after it: a device
 *   further east reached the next money month first (zones are at most a day apart, so a month at most), and the copy
 *   only moves forward. A stored month further ahead came from a wrong clock and is replaced.
 * - currency: the money state's (one doc for every device); without one, the stored copy's, never replaced by a
 *   locale's guess (two devices' locales can differ, en-US and en-GB); only without both, `fallback` (the device's
 *   defaultCurrency, as Overview shows it).
 */
export function earningsBasis(
  stored: Showcase | null,
  state: MoneyState | null,
  nowMs: number,
  tz: string,
  fallback: CurrencyCode,
): { monthId: MonthId; currency: CurrencyCode } {
  const own = lastMoneyMonth(nowMs, tz)
  const kept = stored?.earnings
  const monthId = kept && kept.monthId === addMonths(own, 1) ? kept.monthId : own
  const currency = state?.currency || kept?.currency || fallback
  return { monthId, currency }
}

function cloneList<T extends object>(list: T[]): T[] {
  return list.map((x) => ({ ...x }))
}

/**
 * The editor's write (inside a transaction on the server's copy): the stored switches (DEFAULT_SHOW without a doc)
 * with `key` set to `on`; the item of a key just switched on, fresh from `items`; the other switched-on items as
 * stored (from `items` when the stored doc lacks one); switched-off items absent. Without `updatedAt`.
 */
export function switchShowcase(stored: Showcase | null, key: ShowKey, on: boolean, items: ShowcaseItems): ShowcaseDoc {
  const show: ShowSwitches = { ...showOf(stored), [key]: on }
  const keep = (k: ItemKey) => (k === key ? undefined : stored?.[k])
  const doc: ShowcaseDoc = { show }
  if (show.achieved) doc.achieved = cloneList((keep('achieved') as AchievedGoal[] | undefined) ?? items.achieved)
  if (show.goals) doc.goals = cloneList((keep('goals') as ShownGoal[] | undefined) ?? items.goals)
  if (show.earnings) doc.earnings = { ...((keep('earnings') as ShownEarnings | undefined) ?? items.earnings) }
  return doc
}

function sameAchieved(a: AchievedGoal[] | undefined, b: AchievedGoal[]): boolean {
  return a !== undefined && a.length === b.length && a.every((x, i) => x.name === b[i].name && x.at === b[i].at)
}

function sameGoals(a: ShownGoal[] | undefined, b: ShownGoal[]): boolean {
  return a !== undefined && a.length === b.length && a.every((x, i) => x.name === b[i].name && x.pct === b[i].pct)
}

function sameEarnings(a: ShownEarnings | undefined, b: ShownEarnings): boolean {
  return a !== undefined && a.monthId === b.monthId && a.amount === b.amount && a.currency === b.currency
}

/**
 * The background sync's write: for each item switched on in `stored`, its fresh copy when it differs from the stored
 * one; null when nothing differs. Never a switch, and nothing for an item switched off (the rules would refuse it).
 */
export function showcasePatch(stored: Showcase, items: ShowcaseItems): Partial<Pick<ShowcaseDoc, 'achieved' | 'goals' | 'earnings'>> | null {
  const patch: Partial<Pick<ShowcaseDoc, 'achieved' | 'goals' | 'earnings'>> = {}
  const show = showOf(stored)
  if (show.achieved && !sameAchieved(stored.achieved, items.achieved)) patch.achieved = cloneList(items.achieved)
  if (show.goals && !sameGoals(stored.goals, items.goals)) patch.goals = cloneList(items.goals)
  if (show.earnings && !sameEarnings(stored.earnings, items.earnings)) patch.earnings = { ...items.earnings }
  return Object.keys(patch).length > 0 ? patch : null
}

const SHORT_NAMES: Record<ShowKey, string> = { stats: 'Stats', achieved: 'Achieved goals', goals: 'Current goals', earnings: 'Earnings' }

/** Profile's Showcase row: "Nothing shown", one item's short name, or "{n} items". */
export function showcaseSummary(show: ShowSwitches): string {
  const on = SHOW_KEYS.filter((k) => show[k] === true)
  if (on.length === 0) return 'Nothing shown'
  return on.length === 1 ? SHORT_NAMES[on[0]] : `${on.length} items`
}

// ---------- Rings and stats (written by the reminders job from scores/{uid}) ----------

const MONTH_ID = /^\d{4}-(0[1-9]|1[0-2])$/

function scoreOf(e: ScoreEntry): number | null {
  return typeof e.score === 'number' && Number.isFinite(e.score) ? e.score : null
}

/** Rounds away float error, as scoring's normalise does, so a mean that is 90 is stored as exactly 90. */
function normalise(score: number): number {
  return Math.round(score * 1e9) / 1e9
}

/** A month's space entries that are entries at all (the job decodes them; this only guards against a null). */
function entriesOf(months: ScoreMonths, monthId: MonthId): ScoreEntry[] {
  const month = months[monthId]
  if (month === null || typeof month !== 'object') return []
  return Object.values(month).filter((e): e is ScoreEntry => e !== null && typeof e === 'object')
}

/** Valid month ids with at least one entry, ascending. */
function monthsWithEntries(months: ScoreMonths): MonthId[] {
  return Object.keys(months)
    .filter((m) => MONTH_ID.test(m) && entriesOf(months, m).length > 0)
    .sort()
}

/**
 * The ring (the job writes it to rings/{uid}): M = the newest month with any entry; score = the mean of M's non-null
 * space scores (null with none: a month someone only judged, or sat out, adds nothing); final = every entry of M is
 * final; spaces = how many scores were averaged. No months: the empty ring.
 */
export function ringOf(months: ScoreMonths): RingFacts {
  const ids = monthsWithEntries(months)
  if (ids.length === 0) return { monthId: null, score: null, final: false, spaces: 0 }
  const monthId = ids[ids.length - 1]
  const entries = entriesOf(months, monthId)
  const scores = entries.map(scoreOf).filter((s): s is number => s !== null)
  const score = scores.length > 0 ? normalise(scores.reduce((a, b) => a + b, 0) / scores.length) : null
  return { monthId, score, final: entries.every((e) => e.final === true), spaces: scores.length }
}

/**
 * The stats (the job writes them to stats/{uid}). A month counts when it has an entry and every entry is final; it
 * is cleared when it has a score and every non-null space score is at least 90 (so 100% in one space and 80% in
 * another isn't). Streaks walk counted months in order: no score in any space carries (as does a month missing from
 * the doc), cleared adds one, anything else resets. weeksPlayed: distinct week ids of every entry, this month's too.
 * since: the earliest month, never before FIRST_RESULTS_MONTH.
 */
export function statsOf(months: ScoreMonths): StatsFacts {
  const ids = monthsWithEntries(months)
  const weeks = new Set<WeekId>()
  let monthsCleared = 0
  let currentStreak = 0
  let bestStreak = 0
  let finishedMonths = 0
  for (const id of ids) {
    const entries = entriesOf(months, id)
    for (const e of entries) for (const w of Array.isArray(e.weeks) ? e.weeks : []) if (typeof w === 'string') weeks.add(w)
    if (!entries.every((e) => e.final === true)) continue
    const scores = entries.map(scoreOf).filter((s): s is number => s !== null)
    if (scores.length === 0) continue
    finishedMonths += 1
    if (scores.every((s) => s >= STATS_THRESHOLD - EPS)) {
      monthsCleared += 1
      currentStreak += 1
      bestStreak = Math.max(bestStreak, currentStreak)
    } else {
      currentStreak = 0
    }
  }
  const since = ids.length === 0 ? null : ids[0] < FIRST_RESULTS_MONTH ? FIRST_RESULTS_MONTH : ids[0]
  return { monthsCleared, currentStreak, bestStreak, weeksPlayed: weeks.size, finishedMonths, since }
}

/** The weeks of a member's month that count as played: closed and scored, not paused, skipped or judged. */
export function playedWeeks(result: MemberMonthResult): WeekId[] {
  return result.weeks.filter((w) => w.closed && w.score !== null && w.paused !== true && w.skipped !== true).map((w) => w.weekId)
}

const EMPTY_RING: RingView = Object.freeze({ value: null, monthId: null, final: false, spaces: 0 })

/**
 * What a ring shows on this device (`tz` its zone): the ring's numbers, or the empty ring when there is none, it has
 * no month, or its month is older than the viewer's previous month (a friend who stopped playing). So at a month's
 * start it shows last month's final score until their first week of the new month is scored.
 */
export function ringView(ring: Ring | RingFacts | null, nowMs: number, tz: string): RingView {
  if (!ring || ring.monthId === null || !MONTH_ID.test(ring.monthId)) return { ...EMPTY_RING }
  if (ring.monthId < previousMonth(nowMs, tz)) return { ...EMPTY_RING }
  const value = typeof ring.score === 'number' && Number.isFinite(ring.score) ? Math.min(100, Math.max(0, ring.score)) : null
  return { value, monthId: ring.monthId, final: ring.final === true, spaces: value === null ? 0 : ring.spaces }
}

const MONTH_NAME = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' })

function monthName(monthId: MonthId): string {
  const [year, month] = monthId.split('-').map(Number)
  return MONTH_NAME.format(Date.UTC(year, month - 1, 1))
}

/** Whole percent, never rounded up past a bar (89.9 → 89), as every score in the app. */
function wholePercent(v: number): number {
  return Math.floor(v + 1e-6)
}

/** "No score yet this month", "September" (final) or "October so far". */
export function ringCaption(view: RingView): string {
  if (view.value === null || view.monthId === null) return 'No score yet this month'
  return view.final ? monthName(view.monthId) : `${monthName(view.monthId)} so far`
}

/** "92% · October so far", "88% · September", or the caption alone ("No score yet this month"). */
export function ringLine(view: RingView): string {
  const caption = ringCaption(view)
  return view.value === null || view.monthId === null ? caption : `${wholePercent(view.value)}% · ${caption}`
}

/** The showcase's stats: zeros and since null without a stats doc. */
export function statsView(stats: UserStats | StatsFacts | null): StatsView {
  if (!stats) return { monthsCleared: 0, currentStreak: 0, bestStreak: 0, weeksPlayed: 0, finishedMonths: 0, since: null }
  const { monthsCleared, currentStreak, bestStreak, weeksPlayed, finishedMonths, since } = stats
  return { monthsCleared, currentStreak, bestStreak, weeksPlayed, finishedMonths, since }
}
