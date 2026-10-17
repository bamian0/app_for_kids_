// Batch-2 fields of stored docs → domain types (SPEC §9.10). Pure and defensive: a malformed value decodes as
// absent (or a safe default), never throws. Shared by the data layer and the reminders job (like decodeTasks).
// `toMs` turns a stored time (a Firestore Timestamp, as the caller's SDK gives it) into epoch ms, or null.
import { scheduleProblem } from './schedule.ts'
import type {
  Agreement,
  AgreedTerms,
  LineInForce,
  MemberStakes,
  MonthId,
  MonthResults,
  MonthResultsEntry,
  PairTerms,
  PauseRequest,
  ScheduleNote,
  StakesMode,
  StakesNote,
  StreakTier,
  TermsInForce,
  UID,
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
