// Deals: stakes with a length (SPEC §12). A deal is what friends owe a member who keeps every week (or month) of it at
// 90% or more, what the member owes them on the first one under, and how many weeks or months it runs. Pure and
// Node-runnable: the app and the reminders job run the same dealState, so they can only differ in provisional text
// (§12.6). Nothing here changes how anything else is scored; stakes.ts doesn't import this file (no cycle).
import { isUid } from './ids.ts'
import { isWeekPaused } from './pause.ts'
import { RETIME_NOTICE_MS, boundsFor } from './schedule.ts'
import { computeWeek, judgesOf, membersAt, monthEndsAtFor, spaceJudges, type MemberMonthResult } from './scoring.ts'
import { addMonths, addWeeks, monthIdForWeek, weekIdFor, weekIdsInMonth } from './time.ts'
import type {
  Deal,
  DealEnd,
  DealInput,
  DealMark,
  DealPeriod,
  DealTerms,
  DealUnit,
  MonthId,
  MonthlyList,
  Space,
  UID,
  Week,
  WeekData,
  WeekId,
} from './types.ts'

export { DEALS_FROM_MONTH } from './stakes.ts'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** The longest deal, in weeks or months. */
export const DEAL_MAX_COUNT = 12
const ALL_COUNTS: readonly number[] = Object.freeze(Array.from({ length: DEAL_MAX_COUNT }, (_, i) => i + 1))
/** Every length the editor's picker offers ("N weeks or N months": all of 1–12). */
export const DEAL_COUNTS: { week: readonly number[]; month: readonly number[] } = Object.freeze({ week: ALL_COUNTS, month: ALL_COUNTS })
/** A person's deals in a space are numbered 1, 2, 3…; the rules take 1–9999. */
export const DEAL_MAX_SEQ = 9999
/** A deal starts with the first period whose lists lock at least this long after everyone agreed (as a change of
 *  times, §9.2), so a last-minute Agree can't start it on a week its person hasn't planned. */
export const DEAL_NOTICE_MS: number = RETIME_NOTICE_MS
/** The app loads deals that ended in the last 60 days (what's left to settle); older ones are in Past Deals. */
export const DEAL_RECENT_DAYS = 60
/** A deal's end shows on the stakes card (and as news) for 7 days. */
export const DEAL_NEWS_DAYS = 7
/** The `deal` push goes out for 7 days after a deal is proposed. */
export const DEAL_PUSH_DAYS = 7
/** A period's result unconfirmed for this long reads "Deal results are running late". */
export const DEAL_LATE_MS: number = DAY_MS
/** The editor's start: 4 weeks. */
export const DEAL_DEFAULT: { unit: DealUnit; count: number } = Object.freeze({ unit: 'week', count: 4 })
/** A line's text, as the rules count it (UTF-16 units). */
export const DEAL_TEXT_MAX = 120

/** Same as scoring's: keeps a 90 that is 89.9999999999 in floats a pass. */
const SCORE_EPSILON = 1e-9
/** The walk stops after this many periods whatever happens (a deal grows only by skips; this is years of them). */
const MAX_WALK = 1000

function round1e9(score: number): number {
  return Math.round(score * 1e9) / 1e9
}

function has(o: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key)
}

// ---------- Ids and periods ----------

/** spaces/{id}/deals/{uid}_{seq}. */
export function dealId(uid: UID, seq: number): string {
  return `${uid}_${seq}`
}

const DEAL_ID = /^([A-Za-z0-9]{1,128})_([1-9][0-9]{0,3})$/

/** `${uid}_${seq}` with a uid (letters and digits) and a seq 1–9999 written without leading zeros; else null. */
export function parseDealId(id: string): { uid: UID; seq: number } | null {
  const m = typeof id === 'string' ? DEAL_ID.exec(id) : null
  if (!m || !isUid(m[1])) return null
  const seq = Number(m[2])
  return seq >= 1 && seq <= DEAL_MAX_SEQ ? { uid: m[1], seq } : null
}

/** The push keys' period for a deal: `${uid}@${seq}` (no `_`, so `${spaceId}_${period}_${kind}_${to}` splits safely). */
export function dealPeriodKey(deal: Pick<Deal, 'uid' | 'seq'>): string {
  return `${deal.uid}@${deal.seq}`
}

/** The period `n` after `id` (a WeekId for weeks, a MonthId for months). */
export function nextPeriod(unit: DealUnit, id: string, n = 1): string {
  return unit === 'week' ? addWeeks(id, n) : addMonths(id, n)
}

const WEEK_ID = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTH_ID = /^\d{4}-(0[1-9]|1[0-2])$/

/** A WeekId that is a real Monday ('YYYY-MM-DD'), or a MonthId ('YYYY-MM'). */
export function isPeriodId(unit: DealUnit, v: unknown): v is string {
  if (typeof v !== 'string') return false
  if (unit === 'month') return MONTH_ID.test(v)
  const m = WEEK_ID.exec(v)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = new Date(Date.UTC(y, mo - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && t.getUTCDay() === 1
}

// ---------- The clock: when each period locks and is final ----------

/** When a deal's periods lock and become final: from the stored week docs (and monthly lists) the caller has, else
 *  computed on the space's times (boundsFor). */
export interface DealClock {
  /** When the period's (first) lists lock: a week's lock, a month's first week's lock. */
  lockOf(periodId: string): number
  /** When its result is final: a week's deadline, a month's completion (monthEndsAtFor). */
  finalOf(periodId: string): number
  /** Every lock a period needs its person in: a week's one lock; each week of a month, in order (the first is lockOf). */
  weekLocks(periodId: string): number[]
}

/**
 * The clock of a deal's unit (SPEC §12.8): weeks: `boundsFor(space, id, known week)`'s lock and deadline; months: the
 * locks of every week of the month (stored when known) and `monthEndsAtFor(space, id, known last week, known list)`.
 */
export function dealClock(space: Pick<Space, 'timezone' | 'schedule'>, unit: DealUnit, known?: { weeks?: Record<WeekId, Week>; lists?: Record<MonthId, MonthlyList> }): DealClock {
  const weekDoc = (weekId: WeekId): Week | null => {
    const w = known?.weeks && has(known.weeks, weekId) ? known.weeks[weekId] : undefined
    return w && w.id === weekId ? w : null
  }
  const bounds = (weekId: WeekId) => boundsFor(space, weekId, weekDoc(weekId))
  if (unit === 'week') {
    return {
      lockOf: (id) => bounds(id).lockAt,
      finalOf: (id) => bounds(id).deadlineAt,
      weekLocks: (id) => [bounds(id).lockAt],
    }
  }
  const weekLocks = (id: MonthId) => weekIdsInMonth(id).map((w) => bounds(w).lockAt)
  return {
    lockOf: (id) => bounds(weekIdsInMonth(id)[0]).lockAt,
    finalOf: (id) => {
      const weeks = weekIdsInMonth(id)
      const list = known?.lists && has(known.lists, id) ? known.lists[id] : null
      return monthEndsAtFor(space, id, weekDoc(weeks[weeks.length - 1]), list && list.id === id ? list : null)
    },
    weekLocks,
  }
}

/**
 * The first period a deal agreed at `t` starts with (SPEC §12.2): from the period holding `t` (weeks: its week;
 * months: the month of its week) on, the first whose lists lock at least DEAL_NOTICE_MS after `t` (`≥`: exactly a day
 * still counts). At most two steps on (a lock at Sunday midnight with `t` late on a Sunday skips one).
 */
export function firstPeriodAfter(space: Pick<Space, 'timezone'>, unit: DealUnit, t: number, clock: DealClock): string {
  const week = weekIdFor(t, space.timezone)
  let p = unit === 'week' ? week : monthIdForWeek(week)
  for (let i = 0; i < 8 && clock.lockOf(p) < t + DEAL_NOTICE_MS; i++) p = nextPeriod(unit, p)
  return p
}

/** Until when the last Agree still starts a deal with `start`: its lock minus a day (exactly 24 hours, DST or not). */
export function agreeBy(start: string, clock: DealClock): number {
  return clock.lockOf(start) - DEAL_NOTICE_MS
}

// ---------- Words shared by the app and the pushes (en-US) ----------

const SHORT_DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const MONTH_NAME = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' })

function utcDate(id: string): Date {
  const [y, m, d] = id.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d ?? 15))
}

/** "Nov 16": a week's Monday. */
function mondayText(weekId: WeekId): string {
  return SHORT_DATE.format(utcDate(weekId)).replace(/[   ]/g, ' ')
}

/** "November". */
function monthText(monthId: MonthId): string {
  return MONTH_NAME.format(utcDate(monthId))
}

/** "1 week", "4 weeks", "1 month", "3 months". */
export function dealLengthText(unit: DealUnit, count: number): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`
}

/** "the week of Nov 16" (its Monday) or "November" (capitalise it at a sentence start). */
export function periodLabel(unit: DealUnit, id: string): string {
  return unit === 'week' ? `the week of ${mondayText(id)}` : monthText(id)
}

/** "Week 2 of 4", "Month 1 of 3". */
export function positionText(unit: DealUnit, n: number, count: number): string {
  return `${unit === 'week' ? 'Week' : 'Month'} ${n} of ${count}`
}

/** When `start` is, seen at `nowMs` in the space's zone: "this week", "next week", "the week of Nov 9", "in December". */
export function startPhrase(unit: DealUnit, start: string, nowMs: number, tz: string): string {
  if (unit === 'month') return `in ${monthText(start)}`
  const thisWeek = weekIdFor(nowMs, tz)
  if (start === thisWeek) return 'this week'
  if (start === addWeeks(thisWeek, 1)) return 'next week'
  return periodLabel('week', start)
}

// ---------- Terms ----------

/** Who a deal proposed now is with: every current member but `uid` who doesn't judge, in `memberIds` order. */
export function dealFriends(space: Pick<Space, 'memberIds' | 'judges'>, uid: UID): UID[] {
  const judges = spaceJudges(space)
  return space.memberIds.filter((m) => m !== uid && !judges.includes(m))
}

/** A deal's terms between its person and `friend`: each line's text for them and whether it's owed together (Same
 *  for everyone). null when a line is per friend and `friend` has no entry. */
export function dealPairTerms(deal: DealTerms, friend: UID): { reward: string; penalty: string; rewardTogether: boolean; penaltyTogether: boolean } | null {
  const perFriend = deal.rewardMode === 'each' || deal.penaltyMode === 'each'
  const entry = has(deal.per, friend) ? deal.per[friend] : undefined
  if (perFriend && !entry) return null
  return {
    reward: deal.rewardMode === 'each' ? (entry?.reward ?? '') : deal.reward,
    penalty: deal.penaltyMode === 'each' ? (entry?.penalty ?? '') : deal.penalty,
    rewardTogether: deal.rewardMode === 'group',
    penaltyTogether: deal.penaltyMode === 'group',
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * The input as proposeDeal writes it (SPEC §12.8): texts trimmed; `per` only for `friends` (in their order) that have
 * an entry, with '' for a line that isn't per friend; `{}` when neither line is per friend. A unit or mode that isn't
 * known reads 'week' / 'group'; `count` as given (dealProblem checks it).
 */
export function cleanDeal(input: DealInput, friends: UID[]): DealInput {
  const rewardMode = input.rewardMode === 'each' ? 'each' : 'group'
  const penaltyMode = input.penaltyMode === 'each' ? 'each' : 'group'
  const entries: [UID, { reward: string; penalty: string }][] = []
  if (rewardMode === 'each' || penaltyMode === 'each') {
    const per = input.per !== null && typeof input.per === 'object' ? input.per : {}
    for (const f of friends) {
      const e = has(per, f) ? (per[f] as unknown) : undefined
      if (e === null || typeof e !== 'object') continue
      const { reward, penalty } = e as Record<string, unknown>
      entries.push([f, { reward: rewardMode === 'each' ? str(reward) : '', penalty: penaltyMode === 'each' ? str(penalty) : '' }])
    }
  }
  return {
    unit: input.unit === 'month' ? 'month' : 'week',
    count: input.count,
    rewardMode,
    penaltyMode,
    reward: str(input.reward),
    penalty: str(input.penalty),
    per: Object.fromEntries(entries),
  }
}

/** What keeps a deal from being proposed (the editor shows its text under the section it's about). */
export type DealProblem = 'count' | 'fill-group' | 'fill-reward-each' | 'fill-penalty-each' | 'long' | 'no-friends'

/**
 * The first problem of `input` (after cleanDeal) for a deal with `friends`, in this order: 'no-friends' (nobody else
 * plays), 'count' (not a whole number 1–12), 'long' (any text over 120), 'fill-group' (a Same-for-everyone line
 * blank), 'fill-reward-each' / 'fill-penalty-each' (a per-friend line blank or missing for a friend); else null.
 */
export function dealProblem(input: DealInput, friends: UID[]): DealProblem | null {
  if (friends.length === 0) return 'no-friends'
  const d = cleanDeal(input, friends)
  if (!Number.isInteger(d.count) || d.count < 1 || d.count > DEAL_MAX_COUNT) return 'count'
  const texts = [d.reward, d.penalty, ...Object.values(d.per).flatMap((e) => [e.reward, e.penalty])]
  if (texts.some((t) => t.length > DEAL_TEXT_MAX)) return 'long'
  if ((d.rewardMode === 'group' && d.reward === '') || (d.penaltyMode === 'group' && d.penalty === '')) return 'fill-group'
  const blank = (line: 'reward' | 'penalty') => friends.some((f) => !has(d.per, f) || d.per[f][line] === '')
  if (d.rewardMode === 'each' && blank('reward')) return 'fill-reward-each'
  if (d.penaltyMode === 'each' && blank('penalty')) return 'fill-penalty-each'
  return null
}

/** The editor's (and proposeDeal's) words for a problem (SPEC §12.8). */
export function dealProblemText(p: DealProblem): string {
  switch (p) {
    case 'count':
      return 'Pick how long: 1 to 12 weeks or months.'
    case 'fill-group':
      return 'Fill in what they owe you and what you owe them.'
    case 'fill-reward-each':
      return 'Fill in what each friend owes you, or make it the same for everyone.'
    case 'fill-penalty-each':
      return 'Fill in what you owe each friend, or make it the same for everyone.'
    case 'long':
      return 'Keep each one under 120 characters.'
    case 'no-friends':
      return 'Deals need a friend who plays. Invite one first.'
  }
}

/** The person's newest deal (highest seq) that ran: won, lost or off (a withdrawn one never ran). */
export function lastPlayedDeal(deals: Deal[], uid: UID): Deal | null {
  let last: Deal | null = null
  for (const d of deals) {
    const outcome = d.ended?.outcome
    if (d.uid !== uid || (outcome !== 'won' && outcome !== 'lost' && outcome !== 'off')) continue
    if (!last || d.seq > last.seq) last = d
  }
  return last
}

/**
 * Same Again (SPEC §12.2): `last`'s unit, length, modes and texts, with `per` for today's `friends` that had an entry.
 * `missing`: today's friends without one while a line is per friend (empty: propose at once; else the editor opens on
 * `input`, asking for those).
 */
export function sameAgain(last: Pick<Deal, 'unit' | 'count' | 'rewardMode' | 'penaltyMode' | 'reward' | 'penalty' | 'per'>, friends: UID[]): { input: DealInput; missing: UID[] } {
  const perFriend = last.rewardMode === 'each' || last.penaltyMode === 'each'
  const per: [UID, { reward: string; penalty: string }][] = []
  const missing: UID[] = []
  if (perFriend) {
    for (const f of friends) {
      const e = has(last.per, f) ? last.per[f] : undefined
      if (e) per.push([f, { reward: e.reward, penalty: e.penalty }])
      else missing.push(f)
    }
  }
  return {
    input: { unit: last.unit, count: last.count, rewardMode: last.rewardMode, penaltyMode: last.penaltyMode, reward: last.reward, penalty: last.penalty, per: Object.fromEntries(per) },
    missing,
  }
}

// ---------- State ----------

/** Everything the screens and the job read off a deal (SPEC §12.8), derived from the doc, the space and the time. */
export interface DealState {
  phase: 'waiting' | 'scheduled' | 'running' | 'won' | 'lost' | 'off' | 'withdrawn'
  /** Friends still in the space (who must agree), in `friends` order. */
  needed: UID[]
  /** Waiting: needed friends without an Agree, in `friends` order; else []. */
  waitingFor: UID[]
  /** When it became fully agreed: the job's stamp, else computed; null while waiting (and withdrawn). */
  agreedAt: number | null
  /** The stamp, else firstPeriodAfter(agreedAt); waiting: firstPeriodAfter(now) (where it would start). Null when
   *  withdrawn without a stamp. */
  start: string | null
  /** Scheduled on: agreed friends in membersAt(space, lockOf(start)) (before that lock: agreed and still members). */
  parties: UID[]
  /** Call Off: who tapped (its person, then parties, in order); who still has to (the person and the parties still in
   *  the space, without a tap); when it became off (null until it is). Empty while waiting. */
  callOff: { asked: UID[]; waitingFor: UID[]; completeAt: number | null }
  /** The stored track, then the periods that follow it (from `extra`, and a 'left' miss the walk found). */
  track: DealPeriod[]
  passes: number
  skips: number
  /** Running: the first period not yet in track (null once an end is known); scheduled: start. */
  current: string | null
  /** min(passes + 1, count). */
  position: number
  /** The stored `ended`, else what the walk determines (provisional). */
  end: DealEnd | null
  /** `end` comes from the walk, not from the job yet. */
  provisional: boolean
  /** A period whose final time has passed but whose result isn't known yet (not in track or `extra`). */
  pending: string | null
  /** A pending period (or a provisional end) unconfirmed for more than DEAL_LATE_MS. */
  late: boolean
}

/** What dealState reads off the space: who is in it when, and its zone. */
export type DealSpace = Pick<Space, 'memberIds' | 'leftAt' | 'joinedAt' | 'timezone'>
type Members = DealSpace

/**
 * When the deal became fully agreed (SPEC §12.2): its person is a current member, every friend still in the space
 * agreed, and at least one is: the latest of their Agrees and of the `leftAt` of friends who left without agreeing
 * after it was proposed. Else null.
 */
function computedAgreedAt(deal: Deal, space: Members, needed: UID[]): number | null {
  if (!space.memberIds.includes(deal.uid) || needed.length === 0) return null
  if (!needed.every((f) => typeof deal.agreed[f] === 'number')) return null
  let at = Math.max(...needed.map((f) => deal.agreed[f]))
  for (const f of deal.friends) {
    if (space.memberIds.includes(f) || typeof deal.agreed[f] === 'number') continue
    const left = space.leftAt?.[f]
    if (typeof left === 'number' && left > deal.createdAt && left > at) at = left
  }
  return at
}

/** Agreed friends in the space at the start's lock (before it: agreed and still members). */
function partiesOf(deal: Deal, space: Members, lock: number, nowMs: number): UID[] {
  const agreed = deal.friends.filter((f) => typeof deal.agreed[f] === 'number')
  if (nowMs < lock) return agreed.filter((f) => space.memberIds.includes(f))
  const at = membersAt(space, lock)
  return agreed.filter((f) => at.includes(f))
}

/** A party was in the space at `t`: a current member (who tapped while one), or a former one who left after `t`. */
function partyInAt(space: Members, p: UID, t: number): boolean {
  if (space.memberIds.includes(p)) return true
  const left = space.leftAt?.[p]
  return typeof left === 'number' && left > t
}

/**
 * Call Off (SPEC §12.2). Takers: the person and the parties (other taps are ignored). It completes once the person and
 * every party still in the space tapped, at the latest of the takers' taps and of the `leftAt` of parties who left
 * without tapping after the first tap (a party leaving can't date it back to before a miss), provided some party was
 * still in the space then (the person alone can't call it off).
 */
function callOffOf(deal: Deal, space: Members, parties: UID[]): DealState['callOff'] {
  const tapped = (u: UID) => typeof deal.off[u] === 'number'
  const asked = [deal.uid, ...parties].filter(tapped)
  const waitingFor = [deal.uid, ...parties.filter((p) => space.memberIds.includes(p))].filter((u) => !tapped(u))
  if (asked.length === 0 || waitingFor.length > 0) return { asked, waitingFor, completeAt: null }
  const taps = asked.map((u) => deal.off[u])
  const first = Math.min(...taps)
  let at = Math.max(...taps)
  for (const p of parties) {
    if (tapped(p) || space.memberIds.includes(p)) continue
    const left = space.leftAt?.[p]
    if (typeof left === 'number' && left > first && left > at) at = left
  }
  return { asked, waitingFor, completeAt: parties.some((p) => partyInAt(space, p, at)) ? at : null }
}

interface Walked {
  added: DealPeriod[]
  passes: number
  skips: number
  current: string | null
  end: DealEnd | null
  pending: string | null
  /** dealPeriodsToLoad: the final periods without a known result, in order. */
  toLoad: string[]
}

/**
 * The walk of SPEC §12.8, from `start`: for each period P, for each lock l it needs (in order): a completed Call Off
 * before l → off; l not reached → stop; the person not in membersAt(l) → lost, a 'left' miss; at P's first lock, no
 * party in membersAt(l) → off 'alone'. Then P's final time F: a Call Off before F → off; F not reached → stop; P's
 * result (stored track, else `extra`; never re-judged) → a miss ends it lost at F, the count-th pass won at F, a skip
 * adds a period; no result → pending (or, `plan`, listed and assumed a pass). Periods already in the stored track skip
 * the lock checks.
 */
function walk(
  deal: Deal,
  space: Members,
  nowMs: number,
  clock: DealClock,
  start: string,
  parties: UID[],
  completeAt: number | null,
  extra: DealPeriod[],
  plan: boolean,
): Walked {
  const stored = new Map<string, DealPeriod>()
  for (const e of deal.track ?? []) if (!stored.has(e.id)) stored.set(e.id, e)
  const given = new Map<string, DealPeriod>()
  for (const e of extra) if (!given.has(e.id)) given.set(e.id, e)
  const out: Walked = { added: [], passes: 0, skips: 0, current: null, end: null, pending: null, toLoad: [] }
  const callOffEnd = (): DealEnd => ({ outcome: 'off', at: completeAt as number, reason: 'called-off' })
  let assumed = 0
  let p = start
  for (let guard = 0; guard < MAX_WALK; guard++, p = nextPeriod(deal.unit, p)) {
    const fromStore = stored.get(p)
    if (!fromStore) {
      const locks = clock.weekLocks(p)
      for (let j = 0; j < locks.length; j++) {
        const l = locks[j]
        if (completeAt !== null && completeAt < l) {
          out.end = callOffEnd()
          return out
        }
        if (nowMs < l) {
          out.current = p
          return out
        }
        const inAt = membersAt(space, l)
        if (!inAt.includes(deal.uid)) {
          out.added.push({ id: p, result: 'miss', score: null, why: 'left' })
          out.end = { outcome: 'lost', at: l, period: p, score: null }
          return out
        }
        if (j === 0 && !parties.some((x) => inAt.includes(x))) {
          out.end = { outcome: 'off', at: l, reason: 'alone' }
          return out
        }
      }
      const final = clock.finalOf(p)
      if (completeAt !== null && completeAt < final) {
        out.end = callOffEnd()
        return out
      }
      if (nowMs < final) {
        out.current = p
        return out
      }
    }
    const entry = fromStore ?? given.get(p)
    if (!entry) {
      if (plan) {
        out.toLoad.push(p)
        assumed += 1
        if (out.passes + assumed >= deal.count) return out
        continue
      }
      out.pending = p
      out.current = p
      return out
    }
    if (!fromStore) out.added.push(entry)
    if (entry.result === 'miss') {
      out.end = { outcome: 'lost', at: clock.finalOf(p), period: p, score: entry.score }
      return out
    }
    if (entry.result === 'pass') {
      out.passes += 1
      if (out.passes >= deal.count) {
        out.end = { outcome: 'won', at: clock.finalOf(p), period: p }
        return out
      }
    } else {
      out.skips += 1
    }
  }
  out.current = p
  return out
}

function countOf(track: DealPeriod[], result: DealPeriod['result']): number {
  return track.filter((e) => e.result === result).length
}

/**
 * A deal's state at `nowMs` (SPEC §12.8). `clock` is dealClock(space, deal.unit, the stored docs the caller has);
 * `extra`: final periods the caller computed (weekDealPeriod / monthDealPeriod) that may follow the stored track. The
 * stored `ended` and the job's stamps (`agreedAt`, `start`, `track`) always win over what is computed here.
 */
export function dealState(deal: Deal, space: Members, nowMs: number, clock: DealClock, extra: DealPeriod[] = []): DealState {
  const needed = deal.friends.filter((f) => space.memberIds.includes(f))
  const stored = deal.track ?? []
  const state: DealState = {
    phase: 'waiting',
    needed,
    waitingFor: [],
    agreedAt: null,
    start: null,
    parties: [],
    callOff: { asked: [], waitingFor: [], completeAt: null },
    track: [...stored],
    passes: countOf(stored, 'pass'),
    skips: countOf(stored, 'skip'),
    current: null,
    position: Math.min(countOf(stored, 'pass') + 1, deal.count),
    end: null,
    provisional: false,
    pending: null,
    late: false,
  }
  const agreedAt = typeof deal.agreedAt === 'number' ? deal.agreedAt : computedAgreedAt(deal, space, needed)

  if (deal.ended?.outcome === 'withdrawn') {
    return { ...state, phase: 'withdrawn', start: deal.start ?? null, end: deal.ended }
  }
  // A stamped start means the job saw it fully agreed (the rules allow no withdrawal after it), even without agreedAt.
  if (!deal.ended && agreedAt === null && deal.start === undefined) {
    return {
      ...state,
      waitingFor: needed.filter((f) => typeof deal.agreed[f] !== 'number'),
      start: firstPeriodAfter(space, deal.unit, nowMs, clock),
    }
  }

  const start = deal.start ?? (agreedAt !== null ? firstPeriodAfter(space, deal.unit, agreedAt, clock) : null)
  const lock = start !== null ? clock.lockOf(start) : Infinity
  const parties = start !== null ? partiesOf(deal, space, lock, nowMs) : []
  const callOff = callOffOf(deal, space, parties)
  state.agreedAt = agreedAt
  state.start = start
  state.parties = parties

  if (deal.ended) {
    return { ...state, phase: deal.ended.outcome, callOff, end: deal.ended }
  }

  state.phase = nowMs < lock ? 'scheduled' : 'running'
  state.callOff = callOff
  const w = walk(deal, space, nowMs, clock, start as string, parties, callOff.completeAt, extra, false)
  state.track = [...stored, ...w.added]
  state.passes = w.passes
  state.skips = w.skips
  state.position = Math.min(w.passes + 1, deal.count)
  state.end = w.end
  state.provisional = w.end !== null
  state.current = w.end ? null : w.current
  state.pending = w.pending
  state.late =
    (w.pending !== null && nowMs >= clock.finalOf(w.pending) + DEAL_LATE_MS) || (w.end !== null && nowMs >= w.end.at + DEAL_LATE_MS)
  return state
}

/**
 * The periods the job should load for a deal now (SPEC §12.8): the final periods after its stored track that the walk
 * needs, in order, assuming each unknown one passes (so at most count − passes of them), stopping before any end at a
 * lock (the person left, everyone else left) or a completed Call Off. None while waiting or once ended.
 */
export function dealPeriodsToLoad(deal: Deal, space: Members, nowMs: number, clock: DealClock): string[] {
  const s = dealState(deal, space, nowMs, clock)
  if (deal.ended || s.phase === 'waiting' || s.start === null) return []
  return walk(deal, space, nowMs, clock, s.start, s.parties, s.callOff.completeAt, [], true).toLoad
}

// ---------- Period results ----------

/**
 * One week of a weeks deal for its person `uid` (SPEC §12.2, §12.8), or null before the week's stored deadline
 * (computed without a doc): no doc → skip 'missing'; not in the week's members → miss 'left'; paused → skip 'paused';
 * judging it → miss 'judge'; every task excused → skip 'excused'; else the deal score = the week's score minus
 * latePenalty per friend not reviewed (floor 0, rounded to 1e-9), a pass at the threshold (−1e-9), 'empty' with no
 * tasks.
 */
export function weekDealPeriod(space: Space, uid: UID, data: WeekData, nowMs: number): DealPeriod | null {
  const week = data.week && data.week.id === data.weekId ? data.week : null
  const deadline = boundsFor(space, data.weekId, week).deadlineAt
  if (nowMs < deadline) return null
  const id = data.weekId
  if (!week) return { id, result: 'skip', score: null, why: 'missing' }
  if (!week.members.includes(uid)) return { id, result: 'miss', score: null, why: 'left' }
  if (isWeekPaused(space, id)) return { id, result: 'skip', score: null, why: 'paused' }
  if (judgesOf(week).includes(uid)) return { id, result: 'miss', score: null, why: 'judge' }
  const r = computeWeek(data, space, nowMs).members[uid]
  if (r?.skipped) return { id, result: 'skip', score: null, why: 'excused' }
  if (!r || r.score === null) return { id, result: 'skip', score: null, why: 'no-score' }
  const missed = r.missedReviewsOf.length
  const score = round1e9(Math.max(0, r.score - space.latePenalty * missed))
  const out: DealPeriod = { id, result: score >= space.threshold - SCORE_EPSILON ? 'pass' : 'miss', score }
  if (missed > 0) out.missed = missed
  if (r.taskCount === 0) out.why = 'empty'
  return out
}

/**
 * One month of a months deal for its person `uid` (SPEC §12.8), from computeMonth's result, or null while it isn't
 * complete. `weeks`: the month's loaded weeks (as computeMonth got them). A week doc of the month without `uid` →
 * miss 'left'; no result → skip 'missing'; a score → pass/miss by `passed` (`missed` its missed reviews); no score
 * but a judged week → miss 'judge'; else skip 'no-score' (every week paused or excused, or no week doc).
 */
export function monthDealPeriod(uid: UID, result: MemberMonthResult | undefined, weeks: WeekData[]): DealPeriod | null {
  if (result && !result.complete) return null
  const monthId = result?.monthId ?? (weeks[0] ? monthIdForWeek(weeks[0].weekId) : null)
  if (monthId === null) return null
  const inMonth = new Set(weekIdsInMonth(monthId))
  const id = monthId
  if (weeks.some((w) => inMonth.has(w.weekId) && w.week && w.week.id === w.weekId && !w.week.members.includes(uid))) {
    return { id, result: 'miss', score: null, why: 'left' }
  }
  if (!result) return { id, result: 'skip', score: null, why: 'missing' }
  if (result.finalScore !== null) {
    const out: DealPeriod = { id, result: result.passed ? 'pass' : 'miss', score: result.finalScore }
    if (result.missedReviews > 0) out.missed = result.missedReviews
    return out
  }
  if ((result.judged ?? []).length > 0) return { id, result: 'miss', score: null, why: 'judge' }
  return { id, result: 'skip', score: null, why: 'no-score' }
}

// ---------- Debts and settling ----------

/** One line of what a won or lost deal owes (shaped like stakes' DebtLine, so the month view's helpers work on it). */
export interface DealDebtLine {
  dealId: string
  /** The deal's person. */
  subject: UID
  /** reward: the parties owe the person; penalty: the person owes the parties. */
  kind: 'reward' | 'penalty'
  what: string
  /** A Same-for-everyone line: owed by (or to) every party on it together. */
  together: boolean
  debtors: UID[]
  creditors: UID[]
  /** The parties on the line: what one Settled tap marks (`settled.{key}`). */
  keys: UID[]
}

/** What a deal owes once ended (SPEC §12.2): won → the reward (one together line, or one per party), lost → the
 *  penalty likewise, with `parties` (dealState's); off and withdrawn → nothing. */
export function dealDebtLines(deal: Deal, parties: UID[]): DealDebtLine[] {
  const outcome = deal.ended?.outcome
  if ((outcome !== 'won' && outcome !== 'lost') || parties.length === 0) return []
  const kind = outcome === 'won' ? 'reward' : 'penalty'
  const mode = kind === 'reward' ? deal.rewardMode : deal.penaltyMode
  const line = (what: string, together: boolean, keys: UID[]): DealDebtLine => ({
    dealId: deal.id,
    subject: deal.uid,
    kind,
    what,
    together,
    debtors: kind === 'reward' ? [...keys] : [deal.uid],
    creditors: kind === 'reward' ? [deal.uid] : [...keys],
    keys: [...keys],
  })
  if (mode === 'group') return [line(deal[kind], true, parties)]
  return parties.map((p) => line(has(deal.per, p) ? deal.per[p][kind] : '', false, [p]))
}

/** A line is settled when every key's mark says so; `last` is the newest of those marks (only when settled). */
export function dealLineSettled(deal: Pick<Deal, 'settled'>, line: Pick<DealDebtLine, 'keys'>): { settled: boolean; last?: DealMark } {
  const marks = line.keys.map((k) => (has(deal.settled, k) ? deal.settled[k] : undefined))
  if (marks.length === 0 || !marks.every((m) => m?.settled === true)) return { settled: false }
  const last = (marks as DealMark[]).reduce((a, b) => (b.at > a.at ? b : a))
  return { settled: true, last }
}
