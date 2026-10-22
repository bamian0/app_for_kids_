// Batch-2 fields of stored docs → domain types (SPEC §9.10), batch 2.5's cross-outs and fair votes (§10.3,
// §10.4), and batch 3's new collections (§11.3). Pure and defensive: a malformed value decodes as absent (or a safe default), never throws. Shared by the
// data layer and the reminders job (like decodeTasks). `toMs` turns a stored time (a Firestore Timestamp, as the
// caller's SDK gives it) into epoch ms, or null.
import { IANAZone } from 'luxon'
import { CANCEL_MAX_CHANGES, cleanWhy, whyIsBlank } from './cancel.ts'
import { DEAL_MAX_COUNT, dealId, isPeriodId, parseDealId } from './deals.ts'
import { pairUsers } from './friends.ts'
import { isUid } from './ids.ts'
import { scheduleProblem } from './schedule.ts'
import { checkinId, fromHundredths, isGoalId } from './shared.ts'
import { DEFAULT_SHOW, SHOWCASE_MAX_ACHIEVED, SHOWCASE_MAX_GOALS, SHOWCASE_NAME_MAX } from './showcase.ts'
import type {
  AchievedGoal,
  Agreement,
  AgreedTerms,
  Checkin,
  Deal,
  DealEnd,
  DealMark,
  DealNote,
  DealPeriod,
  DealUnit,
  FriendState,
  Friendship,
  LineInForce,
  MemberStakes,
  MonthId,
  MonthResults,
  MonthResultsEntry,
  PairTerms,
  PauseRequest,
  ReviewMark,
  Ring,
  ScheduleNote,
  ScoreEntry,
  ScoreMonths,
  SharedGoal,
  Showcase,
  ShownEarnings,
  ShownGoal,
  ShowSwitches,
  StakesMode,
  StakesNote,
  StreakTier,
  TaskCancel,
  TermsInForce,
  UID,
  UserStats,
  WeekId,
  WeekSchedule,
} from './types.ts'

export type ToMs = (value: unknown) => number | null | undefined

type Obj = Record<string, unknown>

const WEEK_ID = /^\d{4}-\d{2}-\d{2}$/
const MONTH_ID = /^\d{4}-(0[1-9]|1[0-2])$/

function obj(v: unknown): Obj | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null
}

function uid(v: unknown): UID | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function uids(v: unknown): UID[] | null {
  return Array.isArray(v) ? [...new Set(v.filter((x): x is UID => typeof x === 'string' && x.length > 0))] : null
}

/** A positive, finite time; anything else is malformed. */
function time(v: unknown, toMs: ToMs): number | null {
  let ms: number | null | undefined
  try {
    ms = toMs(v)
  } catch {
    return null
  }
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : null
}

function isWeekId(v: unknown): v is WeekId {
  return typeof v === 'string' && WEEK_ID.test(v)
}

function isMonthId(v: unknown): v is MonthId {
  return typeof v === 'string' && MONTH_ID.test(v)
}

/** A schedule the rules accept, with exactly its three keys; else null (= the usual times). */
export function decodeSchedule(v: unknown): WeekSchedule | null {
  const o = obj(v)
  if (!o || scheduleProblem(o) !== null) return null
  return { lock: o.lock as number, reviewOpen: o.reviewOpen as number, deadline: o.deadline as number }
}

function scheduleNote(v: unknown, toMs: ToMs): ScheduleNote | null {
  const o = obj(v)
  if (!o) return null
  const by = uid(o.by)
  const at = time(o.at, toMs)
  const before = decodeSchedule(o.before)
  if (!by || at === null || !isWeekId(o.fromWeek) || !before) return null
  return { by, at, fromWeek: o.fromWeek, before }
}

function pauseRequest(v: unknown, toMs: ToMs): PauseRequest | null {
  const o = obj(v)
  if (!o) return null
  const by = uid(o.by)
  const at = time(o.at, toMs)
  const oks = uids(o.oks)
  if (!by || at === null || !isWeekId(o.weekId) || !oks) return null
  const request: PauseRequest = { weekId: o.weekId, by, at, oks }
  const declinedBy = uid(o.declinedBy)
  if (declinedBy) request.declinedBy = declinedBy
  return request
}

function pausedMap(v: unknown): Record<MonthId, WeekId> | null {
  const o = obj(v)
  if (!o) return null
  const out: Record<MonthId, WeekId> = {}
  for (const [monthId, weekId] of Object.entries(o)) if (isMonthId(monthId) && isWeekId(weekId)) out[monthId] = weekId
  return Object.keys(out).length > 0 ? out : null
}

function stakesNote(v: unknown, toMs: ToMs): StakesNote | null {
  const o = obj(v)
  if (!o) return null
  const by = uid(o.by)
  const at = time(o.at, toMs)
  return by && at !== null ? { by, at } : null
}

/** The batch-2 fields of a space doc that are valid (§9.2–§9.7); each malformed one is left out (a bad
 *  `schedule`: the usual times). */
export interface SpaceExtras {
  schedule?: WeekSchedule
  scheduleNote?: ScheduleNote
  pause?: PauseRequest
  paused?: Record<MonthId, WeekId>
  judges?: UID[]
  stakesNote?: StakesNote
  formerJoinedAt?: Record<UID, number>
  /** Deals (SPEC §12.4): only when stored exactly `true`. */
  hasDeals?: true
}

/** uid → a valid time; malformed entries left out, null when none is left. */
function timesMap(v: unknown, toMs: ToMs): Record<UID, number> | null {
  const o = obj(v)
  if (!o) return null
  const out: Record<UID, number> = {}
  for (const [key, value] of Object.entries(o)) {
    const at = time(value, toMs)
    if (key.length > 0 && at !== null) out[key] = at
  }
  return Object.keys(out).length > 0 ? out : null
}

export function decodeSpaceExtras(d: unknown, toMs: ToMs): SpaceExtras {
  const o = obj(d) ?? {}
  const out: SpaceExtras = {}
  const schedule = decodeSchedule(o.schedule)
  if (schedule) out.schedule = schedule
  const note = scheduleNote(o.scheduleNote, toMs)
  if (note) out.scheduleNote = note
  const pause = pauseRequest(o.pause, toMs)
  if (pause) out.pause = pause
  const paused = pausedMap(o.paused)
  if (paused) out.paused = paused
  const judges = uids(o.judges)
  if (judges) out.judges = judges
  const house = stakesNote(o.stakesNote, toMs)
  if (house) out.stakesNote = house
  const former = timesMap(o.formerJoinedAt, toMs)
  if (former) out.formerJoinedAt = former
  if (o.hasDeals === true) out.hasDeals = true
  return out
}

/** The batch-2 fields of a week doc (a monthly list's `judges` too): `schedule` when valid, `judges` when a list. */
export function decodeWeekExtras(d: unknown): { schedule?: WeekSchedule; judges?: UID[] } {
  const o = obj(d) ?? {}
  const out: { schedule?: WeekSchedule; judges?: UID[] } = {}
  const schedule = decodeSchedule(o.schedule)
  if (schedule) out.schedule = schedule
  const judges = uids(o.judges)
  if (judges) out.judges = judges
  return out
}

function mode(v: unknown): StakesMode | null {
  return v === 'group' || v === 'each' ? v : null
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Valid streak rewards (months an int 2–36, a text), ascending, each length once. A malformed list → null. */
function tiers(v: unknown): StreakTier[] | null {
  if (!Array.isArray(v)) return null
  const out: StreakTier[] = []
  for (const t of v) {
    const o = obj(t)
    if (!o || !Number.isInteger(o.months) || (o.months as number) < 2 || (o.months as number) > 36 || typeof o.reward !== 'string') return null
    out.push({ months: o.months as number, reward: o.reward })
  }
  out.sort((a, b) => a.months - b.months)
  return out.filter((t, i) => i === 0 || t.months !== out[i - 1].months)
}

function pairTermsOf(v: unknown): PairTerms | null {
  const o = obj(v)
  if (!o) return null
  const rewardMode = mode(o.rewardMode)
  const penaltyMode = mode(o.penaltyMode)
  const list = tiers(o.tiers)
  if (!rewardMode || !penaltyMode || typeof o.reward !== 'string' || typeof o.penalty !== 'string' || !list) return null
  return { rewardMode, penaltyMode, reward: o.reward, penalty: o.penalty, tiers: list }
}

function agreement(v: unknown, toMs: ToMs): Agreement | null {
  const o = obj(v)
  if (!o) return null
  const at = time(o.at, toMs)
  const terms = pairTermsOf(o.terms)
  if (at === null || !terms) return null
  const past: AgreedTerms[] = []
  for (const entry of Array.isArray(o.past) ? o.past : []) {
    const e = obj(entry)
    const t = pairTermsOf(e)
    const when = e ? time(e.at, toMs) : null
    // Earlier agreements only, oldest first.
    if (t && when !== null && when < at && (past.length === 0 || when > past[past.length - 1].at)) past.push({ ...t, at: when })
  }
  return { at, terms, past }
}

/**
 * spaces/{id}/stakes/{uid} (§9.7). A bad mode reads as 'group', a missing text as ''; `per` entries of the owner
 * or with no texts are dropped; malformed streak rewards read as none; a malformed `past` entry is dropped, and a
 * whole agreement when its `at` or `terms` is malformed.
 */
export function decodeMemberStakes(owner: UID, d: unknown, toMs: ToMs): MemberStakes {
  const o = obj(d) ?? {}
  const per: MemberStakes['per'] = {}
  for (const [friend, entry] of Object.entries(obj(o.per) ?? {})) {
    const e = obj(entry)
    if (friend === owner || !e || (typeof e.reward !== 'string' && typeof e.penalty !== 'string')) continue
    per[friend] = { reward: text(e.reward), penalty: text(e.penalty) }
  }
  const agreed: MemberStakes['agreed'] = {}
  for (const [friend, entry] of Object.entries(obj(o.agreed) ?? {})) {
    const a = friend === owner ? null : agreement(entry, toMs)
    if (a) agreed[friend] = a
  }
  return {
    uid: owner,
    rewardMode: mode(o.rewardMode) ?? 'group',
    penaltyMode: mode(o.penaltyMode) ?? 'group',
    reward: text(o.reward),
    penalty: text(o.penalty),
    per,
    tiers: tiers(o.tiers) ?? [],
    agreed,
    updatedAt: time(o.updatedAt, toMs) ?? 0,
  }
}

function line(v: unknown, toMs: ToMs): LineInForce | null {
  const o = obj(v)
  if (!o || typeof o.text !== 'string' || typeof o.together !== 'boolean' || (o.source !== 'agreed' && o.source !== 'house')) return null
  const out: LineInForce = { text: o.text, together: o.together, source: o.source }
  const at = o.at === undefined ? null : time(o.at, toMs)
  if (at !== null) out.at = at
  return out
}

function termsInForce(v: unknown, toMs: ToMs): TermsInForce | null {
  const o = obj(v)
  if (!o) return null
  const reward = line(o.reward, toMs)
  const penalty = line(o.penalty, toMs)
  const list = o.tiers === undefined ? [] : tiers(o.tiers)
  return reward && penalty && list ? { reward, penalty, tiers: list } : null
}

function entry(v: unknown): MonthResultsEntry | null {
  const o = obj(v)
  if (!o) return null
  const score = typeof o.score === 'number' && Number.isFinite(o.score) ? o.score : null
  const passed = typeof o.passed === 'boolean' ? o.passed : null
  const streak = Number.isInteger(o.streak) && (o.streak as number) >= 0 ? (o.streak as number) : 0
  const out: MonthResultsEntry = { score, passed, streak }
  const runs = obj(o.tierRuns)
  if (runs) {
    const tierRuns: Record<string, number> = {}
    for (const [months, run] of Object.entries(runs)) {
      if (/^\d+$/.test(months) && Number.isInteger(run) && (run as number) >= 0) tierRuns[months] = run as number
    }
    if (Object.keys(tierRuns).length > 0) out.tierRuns = tierRuns
  }
  return out
}

/**
 * spaces/{id}/results/{monthId} (§9.8): null when it isn't a results doc (no valid `monthId`, from the doc or
 * `id`). A non-int `streak` reads as 0; a malformed `tierRuns` entry, member or `terms` pair is dropped.
 */
export function decodeMonthResults(d: unknown, toMs: ToMs, id?: string): MonthResults | null {
  const o = obj(d)
  if (!o) return null
  const monthId = isMonthId(o.monthId) ? o.monthId : isMonthId(id) ? id : null
  if (!monthId) return null
  const members: Record<UID, MonthResultsEntry> = {}
  for (const [member, value] of Object.entries(obj(o.members) ?? {})) {
    const e = entry(value)
    if (e) members[member] = e
  }
  const out: MonthResults = { monthId, completeAt: time(o.completeAt, toMs) ?? 0, members, createdAt: time(o.createdAt, toMs) ?? 0 }
  const stored = obj(o.terms)
  if (stored) {
    const terms: Record<UID, Record<UID, TermsInForce>> = {}
    for (const [subject, pairs] of Object.entries(stored)) {
      const kept: Record<UID, TermsInForce> = {}
      for (const [other, value] of Object.entries(obj(pairs) ?? {})) {
        const t = termsInForce(value, toMs)
        if (t) kept[other] = t
      }
      if (Object.keys(kept).length > 0) terms[subject] = kept
    }
    if (Object.keys(terms).length > 0) out.terms = terms
  }
  return out
}

// ---------- Batch 2.5 (SPEC §10.3, §10.4): cross-outs and the fair vote ----------

/** A `cancels` key: the change number (1–5, one digit), then the task id as the rules check it. */
const CANCEL_KEY = /^([1-9]):([A-Za-z0-9_-]{1,64})$/

/** A review's mark the app understands: Done (1), Half (0.5), Not done (0), or Fair, Skip It ('fair'). */
export function isReviewMark(v: unknown): v is ReviewMark {
  return v === 0 || v === 0.5 || v === 1 || v === 'fair'
}

/**
 * A plan's `cancels` log (§10.3) → each task's state, by task id: `changes` = the largest n with entries 1…n all
 * present and well formed (a valid time `at`; odd n also a reason that isn't blank: whyIsBlank, the rules' own
 * test, so an entry the rules accepted is never dropped), crossed out when it is odd,
 * `at` = entry n's, `why` = the latest odd entry's. Malformed keys (n outside 1–5, a bad id), values, times and
 * reasons are dropped, and so is everything after the first gap; an even entry may carry extra fields. Tasks with
 * no valid entry 1 are absent. Ids not on the list are kept here (decodeTasks ignores them). Never throws.
 */
export function decodeCancels(v: unknown, toMs: ToMs): Record<string, TaskCancel> {
  const o = obj(v)
  if (!o) return {}
  const byTask = new Map<string, Map<number, { at: number; why?: string }>>()
  for (const [key, value] of Object.entries(o)) {
    const match = CANCEL_KEY.exec(key)
    if (!match) continue
    const n = Number(match[1])
    if (n > CANCEL_MAX_CHANGES) continue
    const e = obj(value)
    const at = e ? time(e.at, toMs) : null
    if (!e || at === null) continue
    const entry: { at: number; why?: string } = { at }
    if (n % 2 === 1) {
      const why = typeof e.why === 'string' ? cleanWhy(e.why) : ''
      if (whyIsBlank(why)) continue
      entry.why = why
    }
    const id = match[2]
    let entries = byTask.get(id)
    if (!entries) byTask.set(id, (entries = new Map()))
    entries.set(n, entry)
  }
  const out: [string, TaskCancel][] = []
  for (const [id, entries] of byTask) {
    let changes = 0
    let why = ''
    while (entries.has(changes + 1)) {
      changes += 1
      why = entries.get(changes)?.why ?? why
    }
    if (changes === 0) continue
    out.push([id, { cancelled: changes % 2 === 1, changes, at: entries.get(changes)?.at ?? 0, why }])
  }
  // fromEntries makes every id an own property (even one like "__proto__").
  return Object.fromEntries(out)
}

// ---------- Batch 3 (SPEC §11.3): friends, showcases, rings, stats, scores, shared goals and check-ins ----------
// Each decoder drops what the rules would never have written: a malformed doc decodes to null (or, for a ring, the
// empty ring), a malformed item or map entry is left out. Never throws.

const FRIEND_STATES: readonly FriendState[] = ['asked', 'declined', 'withdrawn', 'friends']
const CURRENCY = /^[A-Z]{3}$/
/** 10¹¹ hundredths: a target or check-in of 1,000,000,000. */
const MAX_HUNDREDTHS = 1e11

function isInt(v: unknown, min: number, max: number): v is number {
  return Number.isInteger(v) && (v as number) >= min && (v as number) <= max
}

/** Text the rules' text(v, max) accepts: 1..max UTF-16 units, not blank. */
function shownText(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length >= 1 && v.length <= max && v.trim() !== '' ? v : null
}

/**
 * friends/{pairId} as seen by `me` (SPEC §11.3): null unless the id is a sorted pair of uids that includes `me`, `users`
 * (when present) names the same two, `by` is one of them, the state is known and `at` is a time.
 */
export function decodeFriendship(id: string, d: unknown, me: UID, toMs: ToMs): Friendship | null {
  const users = pairUsers(id)
  const o = obj(d)
  if (!users || !o || !users.includes(me)) return null
  if (o.users !== undefined && !(Array.isArray(o.users) && o.users.length === 2 && o.users[0] === users[0] && o.users[1] === users[1])) return null
  const state = FRIEND_STATES.find((s) => s === o.state)
  const by = typeof o.by === 'string' && users.includes(o.by) ? o.by : null
  const at = time(o.at, toMs)
  if (!state || !by || at === null) return null
  return { id, uid: users[0] === me ? users[1] : users[0], by, state, at }
}

function achievedList(v: unknown, toMs: ToMs): AchievedGoal[] | null {
  if (!Array.isArray(v)) return null
  const out: AchievedGoal[] = []
  for (const item of v) {
    const o = obj(item)
    const name = o ? shownText(o.name, SHOWCASE_NAME_MAX) : null
    const at = o ? time(o.at, toMs) : null
    if (name !== null && at !== null) out.push({ name, at })
  }
  return out.slice(0, SHOWCASE_MAX_ACHIEVED)
}

function shownGoals(v: unknown): ShownGoal[] | null {
  if (!Array.isArray(v)) return null
  const out: ShownGoal[] = []
  for (const item of v) {
    const o = obj(item)
    const name = o ? shownText(o.name, SHOWCASE_NAME_MAX) : null
    if (o && name !== null && isInt(o.pct, 0, 100)) out.push({ name, pct: o.pct })
  }
  return out.slice(0, SHOWCASE_MAX_GOALS)
}

function shownEarnings(v: unknown): ShownEarnings | null {
  const o = obj(v)
  if (!o || !isMonthId(o.monthId) || typeof o.amount !== 'number' || !(o.amount >= 0 && o.amount <= 1e9)) return null
  return typeof o.currency === 'string' && CURRENCY.test(o.currency) ? { monthId: o.monthId, amount: o.amount, currency: o.currency } : null
}

/**
 * showcases/{uid} (anyone signed in reads it): null when there is no doc. A switch that isn't a boolean reads as its
 * DEFAULT_SHOW value; an item is kept only while its switch is on, and its malformed entries (a bad name, `pct` or
 * time) are dropped.
 */
export function decodeShowcase(owner: UID, d: unknown, toMs: ToMs): Showcase | null {
  const o = obj(d)
  if (!o) return null
  const s = obj(o.show) ?? {}
  const flag = (k: keyof ShowSwitches) => (typeof s[k] === 'boolean' ? (s[k] as boolean) : DEFAULT_SHOW[k])
  const show: ShowSwitches = { stats: flag('stats'), achieved: flag('achieved'), goals: flag('goals'), earnings: flag('earnings') }
  const out: Showcase = { uid: owner, show, updatedAt: time(o.updatedAt, toMs) ?? 0 }
  const achieved = show.achieved ? achievedList(o.achieved, toMs) : null
  if (achieved) out.achieved = achieved
  const goals = show.goals ? shownGoals(o.goals) : null
  if (goals) out.goals = goals
  const earnings = show.earnings ? shownEarnings(o.earnings) : null
  if (earnings) out.earnings = earnings
  return out
}

/** A space score as the job stores it: a finite number, kept within 0–100; anything else is none. */
function score(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null
}

/** rings/{uid} (the owner and their friends read it): null without a doc; a bad month reads as the empty ring. */
export function decodeRing(owner: UID, d: unknown, toMs: ToMs): Ring | null {
  const o = obj(d)
  if (!o) return null
  const updatedAt = time(o.updatedAt, toMs) ?? 0
  if (!isMonthId(o.monthId)) return { uid: owner, monthId: null, score: null, final: false, spaces: 0, updatedAt }
  const value = score(o.score)
  const spaces = isInt(o.spaces, 0, 1e6) ? o.spaces : value === null ? 0 : 1
  return { uid: owner, monthId: o.monthId, score: value, final: o.final === true, spaces: value === null ? 0 : spaces, updatedAt }
}

function count(v: unknown): number {
  return isInt(v, 0, 1e6) ? v : 0
}

/** stats/{uid} (readable per the showcase switch): null without a doc; a malformed count reads 0, a bad `since` null. */
export function decodeStats(owner: UID, d: unknown, toMs: ToMs): UserStats | null {
  const o = obj(d)
  if (!o) return null
  return {
    uid: owner,
    monthsCleared: count(o.monthsCleared),
    currentStreak: count(o.currentStreak),
    bestStreak: count(o.bestStreak),
    weeksPlayed: count(o.weeksPlayed),
    finishedMonths: count(o.finishedMonths),
    since: isMonthId(o.since) ? o.since : null,
    updatedAt: time(o.updatedAt, toMs) ?? 0,
  }
}

/**
 * scores/{uid}.months (the reminders job's own copy; no client reads it): malformed months, space entries and week
 * ids are dropped; `weeks` deduplicated; a score that isn't a finite number is none; `final` only when true.
 */
export function decodeScores(d: unknown, _toMs: ToMs): ScoreMonths {
  const out: ScoreMonths = {}
  for (const [monthId, spaces] of Object.entries(obj(obj(d)?.months) ?? {})) {
    if (!isMonthId(monthId)) continue
    const entries: Record<string, ScoreEntry> = {}
    for (const [spaceId, value] of Object.entries(obj(spaces) ?? {})) {
      const e = obj(value)
      if (!e || spaceId === '' || !Array.isArray(e.weeks)) continue
      entries[spaceId] = { score: score(e.score), weeks: [...new Set(e.weeks.filter(isWeekId))].sort(), final: e.final === true }
    }
    if (Object.keys(entries).length > 0) out[monthId] = entries
  }
  return out
}

/** A valid IANA zone in the shape the rules accept for a space's or goal's timezone. */
function zone(v: unknown): string | null {
  return typeof v === 'string' && v.length <= 64 && /^[A-Za-z0-9_+/-]+$/.test(v) && IANAZone.isValidZone(v) ? v : null
}

/** A fixed zone for an offset in minutes ("UTC+5:30"): the rules' own anchor, used when a goal's zone is unusable. */
function fixedZone(offsetMin: number): string {
  if (offsetMin === 0) return 'UTC'
  const abs = Math.abs(offsetMin)
  return `UTC${offsetMin < 0 ? '-' : '+'}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`
}

/** A real calendar date 'YYYY-MM-DD'. */
function isDate(v: unknown): v is string {
  if (typeof v !== 'string' || !WEEK_ID.test(v)) return false
  const [y, m, day] = v.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, day))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === day
}

/** uid → a value `ok` accepts (uids as the rules check them); others dropped. */
function uidMap<T>(v: unknown, ok: (x: unknown) => T | null): Record<UID, T> {
  const out: [UID, T][] = []
  for (const [key, value] of Object.entries(obj(v) ?? {})) {
    const x = isUid(key) ? ok(value) : null
    if (x !== null) out.push([key, x])
  }
  return Object.fromEntries(out)
}

function strictUids(v: unknown): UID[] {
  return Array.isArray(v) ? [...new Set(v.filter(isUid))] : []
}

/**
 * sharedGoals/{goalId} in real units (hundredths ÷ 100). null when the id fails isGoalId, or the name, unit, target100,
 * utcOffsetMin, ownerId or memberIds is malformed. A zone that isn't a valid IANA zone becomes the fixed zone of
 * utcOffsetMin (the rules' anchor); a bad `zones` entry, a non-int part, a bad `last` or `endsOn` is left out (null);
 * invitees who are members are dropped; `total` falls back to the sum of the parts when `total100` is malformed. Parts
 * and the total are any safe ints (the rules bound each check-in, never the sum).
 */
export function decodeSharedGoal(id: string, d: unknown, toMs: ToMs): SharedGoal | null {
  const o = obj(d)
  if (!o || !isGoalId(id)) return null
  const name = typeof o.name === 'string' && o.name.trim() !== '' ? o.name : null
  const unit = typeof o.unit === 'string' && o.unit.trim() !== '' ? o.unit : null
  const ownerId = isUid(o.ownerId) ? o.ownerId : null
  if (name === null || unit === null || ownerId === null || !Array.isArray(o.memberIds)) return null
  if (!isInt(o.target100, 1, MAX_HUNDREDTHS) || !isInt(o.utcOffsetMin, -720, 840)) return null
  const memberIds = strictUids(o.memberIds)
  // Parts and the total grow by up to 10¹¹ a week per member with no upper bound in the rules: any safe int is
  // theirs (a cap here would drop a big part, and the bar and the reached state with it, while the rules took it).
  const totals100 = uidMap(o.totals100, (v) => (Number.isSafeInteger(v) ? (v as number) : null))
  const sum100 = Object.values(totals100).reduce((a, b) => a + b, 0)
  const total100 = Number.isSafeInteger(o.total100) ? (o.total100 as number) : sum100
  const last = obj(o.last)
  const lastAt = last ? time(last.at, toMs) : null
  return {
    id,
    name,
    unit,
    target: fromHundredths(o.target100),
    endsOn: isDate(o.endsOn) ? o.endsOn : null,
    timezone: zone(o.timezone) ?? fixedZone(o.utcOffsetMin),
    utcOffsetMin: o.utcOffsetMin,
    zones: uidMap(o.zones, zone),
    ownerId,
    createdBy: isUid(o.createdBy) ? o.createdBy : ownerId,
    memberIds,
    invited: strictUids(o.invited).filter((u) => !memberIds.includes(u)),
    joinedAt: uidMap(o.joinedAt, (v) => time(v, toMs)),
    leftAt: uidMap(o.leftAt, (v) => time(v, toMs)),
    totals: Object.fromEntries(Object.entries(totals100).map(([u, n]) => [u, fromHundredths(n)])),
    total: fromHundredths(total100),
    last: last && isUid(last.by) && isWeekId(last.weekId) && lastAt !== null ? { by: last.by, weekId: last.weekId, at: lastAt } : null,
    reachedAt: time(o.reachedAt, toMs),
    archivedAt: time(o.archivedAt, toMs),
    createdAt: time(o.createdAt, toMs) ?? 0,
  }
}

/**
 * sharedGoals/{goalId}/checkins/{weekId}_{uid}: null unless the id matches its `weekId` and `uid` and `amount100` is an
 * int 0…10¹¹. A note that isn't text reads as ''; a bad time as 0.
 */
export function decodeCheckin(id: string, d: unknown, toMs: ToMs): Checkin | null {
  const o = obj(d)
  if (!o || !isUid(o.uid) || !isWeekId(o.weekId) || id !== checkinId(o.weekId, o.uid) || !isInt(o.amount100, 0, MAX_HUNDREDTHS)) return null
  return { id, uid: o.uid, weekId: o.weekId, amount: fromHundredths(o.amount100), note: typeof o.note === 'string' ? o.note : '', at: time(o.at, toMs) ?? 0 }
}

// ---------- Deals (SPEC §12.4, §12.8) ----------
// spaces/{spaceId}/deals/{uid}_{seq}. Shared by the data layer and the reminders job: a malformed field is dropped or
// read as a safe default, a doc that can't be a deal is null, and nothing throws.

const DEAL_NOTES: readonly DealNote[] = ['paused', 'excused', 'missing', 'judge', 'left', 'no-score', 'empty']

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** A deal's `ended`: null when absent or null; a valid withdrawn / won / lost / off shape as itself (an off `reason`
 *  other than 'called-off' or 'alone' reads 'called-off'); anything else is over with nothing owed (off at `createdAt`),
 *  so the seq chain still reads as ended. */
function dealEnd(v: unknown, unit: DealUnit, createdAt: number, toMs: ToMs): DealEnd | null {
  if (v === null || v === undefined) return null
  const fallback: DealEnd = { outcome: 'off', at: createdAt, reason: 'called-off' }
  const o = obj(v)
  const at = o ? time(o.at, toMs) : null
  if (!o || at === null) return fallback
  switch (o.outcome) {
    case 'withdrawn':
      return isUid(o.by) ? { outcome: 'withdrawn', at, by: o.by } : fallback
    case 'won':
    case 'lost': {
      const end: DealEnd = { outcome: o.outcome, at }
      if (isPeriodId(unit, o.period)) end.period = o.period
      if (o.outcome === 'lost' && (o.score === null || isFiniteNumber(o.score))) end.score = o.score
      return end
    }
    case 'off':
      return { outcome: 'off', at, reason: o.reason === 'alone' ? 'alone' : 'called-off' }
    default:
      return fallback
  }
}

/** The job's `track`: entries with a period id of the deal's unit, a known result and a number-or-null score, each id
 *  once (the first); `missed` (an int ≥ 0) and `why` (a known note) kept when valid. */
function dealTrack(v: unknown, unit: DealUnit): DealPeriod[] {
  const out: DealPeriod[] = []
  const seen = new Set<string>()
  for (const item of v as unknown[]) {
    const e = obj(item)
    if (!e || !isPeriodId(unit, e.id) || seen.has(e.id)) continue
    if (e.result !== 'pass' && e.result !== 'miss' && e.result !== 'skip') continue
    if (!(e.score === null || isFiniteNumber(e.score))) continue
    const entry: DealPeriod = { id: e.id, result: e.result, score: e.score }
    if (isInt(e.missed, 0, 1e6)) entry.missed = e.missed
    const why = DEAL_NOTES.find((n) => n === e.why)
    if (why) entry.why = why
    seen.add(e.id)
    out.push(entry)
  }
  return out
}

function dealMark(v: unknown, toMs: ToMs): DealMark | null {
  const o = obj(v)
  const at = o ? time(o.at, toMs) : null
  return o && typeof o.settled === 'boolean' && typeof o.by === 'string' && o.by.length > 0 && at !== null ? { settled: o.settled, by: o.by, at } : null
}

/**
 * spaces/{spaceId}/deals/{id} (SPEC §12.4, §12.8): null when `id` isn't `${uid}_${seq}` of the doc's own `uid` and
 * `seq`, or `unit`, `count` (1–12), either mode or `createdAt` is malformed. Texts that aren't strings read ''; `per`
 * entries without both strings, `friends` that aren't uids (or are its person, or repeat), and `agreed` / `off`
 * entries without a time are dropped; a `settled` entry needs `{ settled: boolean, by: string, at: time }`; `ended` as
 * dealEnd; `agreedAt` and `checkedAt` a time, `start` a period id of the unit, `track` as dealTrack (each left out when
 * malformed). Never throws.
 */
export function decodeDeal(id: string, d: unknown, spaceId: string, toMs: ToMs): Deal | null {
  try {
    const o = obj(d)
    const parsed = parseDealId(id)
    if (!o || !parsed || o.uid !== parsed.uid || o.seq !== parsed.seq || dealId(parsed.uid, parsed.seq) !== id) return null
    const unit = o.unit === 'week' || o.unit === 'month' ? o.unit : null
    const rewardMode = mode(o.rewardMode)
    const penaltyMode = mode(o.penaltyMode)
    const createdAt = time(o.createdAt, toMs)
    if (!unit || !isInt(o.count, 1, DEAL_MAX_COUNT) || !rewardMode || !penaltyMode || createdAt === null) return null
    const owner = parsed.uid
    const per = uidMap(o.per, (v) => {
      const e = obj(v)
      return e && typeof e.reward === 'string' && typeof e.penalty === 'string' ? { reward: e.reward, penalty: e.penalty } : null
    })
    delete per[owner]
    const deal: Deal = {
      id,
      spaceId,
      uid: owner,
      seq: parsed.seq,
      unit,
      count: o.count,
      rewardMode,
      penaltyMode,
      reward: text(o.reward),
      penalty: text(o.penalty),
      per,
      friends: strictUids(o.friends).filter((f) => f !== owner),
      agreed: uidMap(o.agreed, (v) => time(v, toMs)),
      off: uidMap(o.off, (v) => time(v, toMs)),
      settled: uidMap(o.settled, (v) => dealMark(v, toMs)),
      createdAt,
      ended: dealEnd(o.ended, unit, createdAt, toMs),
    }
    const agreedAt = time(o.agreedAt, toMs)
    if (agreedAt !== null) deal.agreedAt = agreedAt
    if (isPeriodId(unit, o.start)) deal.start = o.start
    if (Array.isArray(o.track)) deal.track = dealTrack(o.track, unit)
    const checkedAt = time(o.checkedAt, toMs)
    if (checkedAt !== null) deal.checkedAt = checkedAt
    return deal
  } catch {
    return null
  }
}
