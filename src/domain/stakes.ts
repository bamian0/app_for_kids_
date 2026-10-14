// Per-person stakes, streak rewards and per-pair settling (SPEC §9.7, §9.8). Pure; Node runs it in the
// reminders job. What counts between two people is decided line by line from the agreements' server times, so
// an agreed change counts at once for the month in progress and a finished month never changes.
import type { MemberMonthResult } from './scoring.ts'
import { monthEndsAtFor, spaceJudges } from './scoring.ts'
import { boundsFor } from './schedule.ts'
import { addMonths, monthIdForWeek, weekIdFor, weekIdsInMonth } from './time.ts'
import type {
  AgreedTerms,
  LineInForce,
  MemberStakes,
  MonthId,
  MonthlyList,
  MonthResults,
  MonthResultsEntry,
  MonthStakes,
  PairTerms,
  Settlement,
  SettlementKey,
  Space,
  StakesMode,
  StreakTier,
  TermsInForce,
  UID,
  Week,
} from './types.ts'

export const MAX_TIERS = 5
export const MIN_TIER_MONTHS = 2
export const MAX_TIER_MONTHS = 36
/** The streak lengths the editor offers (the rules take any 2–36). */
export const TIER_CHOICES = [2, 3, 4, 6, 9, 12, 18, 24] as const
/** A pair keeps its current agreement and at most this many earlier ones (6 in all). */
export const MAX_PAST = 5
/** The month batch 2 ships in: month results (streaks) start here, and from here on the previous app's early
 *  freeze of a month's house stakes doesn't bind. Kept equal to the rules' literal '2026-10' (SPEC §9.8, §9.14). */
export const FIRST_RESULTS_MONTH: MonthId = '2026-10'
/** A freeze made this close before a month's completion still counts as made at completion: the rules' hour of
 *  slack plus the anchor's DST hour. */
export const HOUSE_SLACK_MS = 2 * 3_600_000

/** The house stakes of a month (the space's, or the month's binding freeze). */
export interface House {
  reward: string
  penalty: string
}

type Stakes = Record<UID, MemberStakes> | null | undefined
type Line = 'reward' | 'penalty'

// ---------- Terms and agreements ----------

function cleanTiers(tiers: StreakTier[]): StreakTier[] {
  return tiers.map(({ months, reward }) => ({ months, reward }))
}

/** Exactly the five keys of a pair's terms (what the rules compare). */
function cleanTerms(t: PairTerms): PairTerms {
  return { rewardMode: t.rewardMode, penaltyMode: t.penaltyMode, reward: t.reward, penalty: t.penalty, tiers: cleanTiers(t.tiers) }
}

/**
 * A member's current terms for `friend`: each line from its own mode (`group`: the text for everyone; `each`:
 * the friend's own), plus the streak rewards. null ('missing') while a line is per friend and the friend has no
 * entry (e.g. joined after the stakes were saved).
 */
export function pairTerms(stakes: MemberStakes | null | undefined, friend: UID): PairTerms | null {
  if (!stakes) return null
  const entry = stakes.per[friend]
  const perFriend = stakes.rewardMode === 'each' || stakes.penaltyMode === 'each'
  if (perFriend && !entry) return null
  return {
    rewardMode: stakes.rewardMode,
    penaltyMode: stakes.penaltyMode,
    reward: stakes.rewardMode === 'each' ? (entry?.reward ?? '') : stakes.reward,
    penalty: stakes.penaltyMode === 'each' ? (entry?.penalty ?? '') : stakes.penalty,
    tiers: cleanTiers(stakes.tiers),
  }
}

function sameTiers(a: StreakTier[], b: StreakTier[]): boolean {
  return a.length === b.length && a.every((t, i) => t.months === b[i].months && t.reward === b[i].reward)
}

/** Equal modes, texts and streak rewards (in order). */
export function sameTerms(a: PairTerms, b: PairTerms): boolean {
  return a.rewardMode === b.rewardMode && a.penaltyMode === b.penaltyMode && a.reward === b.reward && a.penalty === b.penalty && sameTiers(a.tiers, b.tiers)
}

/** A friend's agreements to the member's stakes, oldest first: `past`, then the current one with its time. */
export function agreementsOf(stakes: MemberStakes | null | undefined, friend: UID): AgreedTerms[] {
  const agreement = stakes?.agreed[friend]
  if (!agreement) return []
  return [...agreement.past, { ...agreement.terms, at: agreement.at }]
}

/** 'agreed': the friend's current agreement equals the current terms (by content, so changing back to terms
 *  they agreed to reads as agreed); 'waiting': it doesn't, or they never agreed; 'missing': no terms for them. */
export function agreementStatus(stakes: MemberStakes | null | undefined, friend: UID): 'agreed' | 'waiting' | 'missing' {
  const terms = pairTerms(stakes, friend)
  if (!terms) return 'missing'
  const agreement = stakes?.agreed[friend]
  return agreement && sameTerms(agreement.terms, terms) ? 'agreed' : 'waiting'
}

/** The friends (in that order) whose status is 'waiting'. */
export function waitingFor(stakes: MemberStakes | null | undefined, friends: UID[]): UID[] {
  return friends.filter((f) => agreementStatus(stakes, f) === 'waiting')
}

/** The friends (in that order) with no terms ('missing'). */
export function missingFor(stakes: MemberStakes | null | undefined, friends: UID[]): UID[] {
  return friends.filter((f) => agreementStatus(stakes, f) === 'missing')
}

/**
 * What an Agree to `terms` writes (besides `at`, the server time): exactly what the rules accept. A first Agree:
 * `{ terms, past: [] }`. A re-agree after a change: the current agreement moves to the end of `past`, stamped with
 * its time (`{ ...terms, at }`), dropping the oldest beyond MAX_PAST. null when `terms` equal the current ones
 * (already agreed: nothing to write). Generic in the time's type, so the data layer can pass the stored
 * Timestamps and write them back unchanged (the rules compare them exactly; a server time has microseconds).
 */
export function nextAgreement<T = number>(
  prev: { at: T; terms: PairTerms; past: (PairTerms & { at: T })[] } | null | undefined,
  terms: PairTerms,
): { terms: PairTerms; past: (PairTerms & { at: T })[] } | null {
  const next = cleanTerms(terms)
  if (!prev) return { terms: next, past: [] }
  if (sameTerms(prev.terms, next)) return null
  const past = [...prev.past, { ...cleanTerms(prev.terms), at: prev.at }]
  return { terms: next, past: past.slice(Math.max(0, past.length - MAX_PAST)) }
}

/**
 * Whether `uid` was in the space at `ms`: a current member who joined at or before it (someone who left and
 * rejoined counts from their latest join), or a former member who left after it (their join time is gone, so
 * assumed earlier).
 */
export function wasMemberAt(space: Pick<Space, 'memberIds' | 'joinedAt' | 'leftAt'>, uid: UID, ms: number): boolean {
  if (space.memberIds.includes(uid)) {
    const joined = space.joinedAt[uid]
    return !(typeof joined === 'number' && joined > ms)
  }
  const left = space.leftAt?.[uid]
  return typeof left === 'number' && left > ms
}

// ---------- What counts (memberTerms) ----------

/** When a line was settled, and each agreeing friend's agreement in force then. */
interface Settled {
  at: number
  inForce: Map<UID, AgreedTerms>
}

interface Walk {
  friends: UID[]
  reward: Settled | null
  penalty: Settled | null
  tiers: Settled | null
}

function unique(uids: UID[]): UID[] {
  return [...new Set(uids)]
}

/**
 * The walk back of SPEC §9.7: over the times of the counted agreements (`at < cutoffMs`), latest first, the
 * latest time at which each line (and the streak rewards) is settled.
 */
function walk(space: Pick<Space, 'memberIds' | 'joinedAt' | 'leftAt'>, subject: UID, friends: UID[], stakes: Stakes, cutoffMs: number): Walk {
  const own = stakes?.[subject]
  const pals = unique(friends).filter((f) => f !== subject)
  const history = new Map<UID, AgreedTerms[]>()
  for (const f of pals) {
    const counted = agreementsOf(own, f)
      .filter((a) => Number.isFinite(a.at) && a.at < cutoffMs)
      .sort((a, b) => a.at - b.at)
    if (counted.length > 0) history.set(f, counted)
  }
  const times = [...new Set([...history.values()].flatMap((list) => list.map((a) => a.at)))].sort((a, b) => b - a)
  const out: Walk = { friends: pals, reward: null, penalty: null, tiers: null }
  for (const t of times) {
    const members = pals.filter((f) => wasMemberAt(space, f, t))
    const inForce = new Map<UID, AgreedTerms>()
    for (const f of members) {
      const list = history.get(f) ?? []
      let latest: AgreedTerms | undefined
      for (const a of list) if (a.at <= t) latest = a
      if (latest) inForce.set(f, latest)
    }
    if (inForce.size === 0) continue
    const everyone = inForce.size === members.length
    const agreements = [...inForce.values()]
    const lineSettled = (line: Line): boolean => {
      const mode = (a: AgreedTerms): StakesMode => (line === 'reward' ? a.rewardMode : a.penaltyMode)
      const first = agreements[0]
      if (!agreements.every((a) => mode(a) === mode(first))) return false
      if (mode(first) === 'each') return true
      return everyone && agreements.every((a) => a[line] === first[line])
    }
    if (!out.reward && lineSettled('reward')) out.reward = { at: t, inForce }
    if (!out.penalty && lineSettled('penalty')) out.penalty = { at: t, inForce }
    if (!out.tiers && everyone && agreements.every((a) => sameTiers(a.tiers, agreements[0].tiers))) out.tiers = { at: t, inForce }
    if (out.reward && out.penalty && out.tiers) break
  }
  return out
}

function lineFor(line: Line, settled: Settled | null, friend: UID, house: House): LineInForce {
  const a = settled?.inForce.get(friend)
  if (!a) return { text: house[line], together: true, source: 'house' }
  const mode = line === 'reward' ? a.rewardMode : a.penaltyMode
  return { text: a[line], together: mode === 'group', source: 'agreed', at: a.at }
}

function termsFromWalk(w: Walk, house: House): Record<UID, TermsInForce> {
  const out: Record<UID, TermsInForce> = {}
  for (const f of w.friends) {
    out[f] = {
      reward: lineFor('reward', w.reward, f, house),
      penalty: lineFor('penalty', w.penalty, f, house),
      tiers: cleanTiers(w.tiers?.inForce.get(f)?.tiers ?? []),
    }
  }
  return out
}

/**
 * What counts between `subject` and each of `friends` (SPEC §9.7), from the agreements made before `cutoffMs`
 * (`at < cutoffMs`; Infinity: every agreement so far, what counts now), with `house` for everyone not on agreed
 * terms. Each line on its own: at each agreement time `t` (latest first), the friends in the space at `t` are
 * split into those with an agreement at or before `t` (their latest is in force at `t`) and the rest. The reward
 * (or penalty) line is settled at `t` when the agreements in force share its mode and, for a Same-for-everyone
 * line, everyone has one and they share its text; the streak rewards when everyone has one and they share them.
 * The latest such `t` decides: those friends get the line from their agreement in force then, everyone else the
 * house line (together) and no streak rewards. So a Same-for-everyone change counts once everyone needed agreed,
 * a per-friend change with that friend's Agree, and a switch between the modes waits for everyone who had agreed.
 */
export function memberTerms(
  space: Pick<Space, 'memberIds' | 'joinedAt' | 'leftAt'>,
  subject: UID,
  friends: UID[],
  stakes: Stakes,
  house: House,
  cutoffMs: number,
): Record<UID, TermsInForce> {
  return termsFromWalk(walk(space, subject, friends, stakes, cutoffMs), house)
}

/**
 * What `me`'s Agree to `subject`'s current terms would do now (memberTerms with the Agree added at `nowMs`):
 * 'now' when every part of my terms that changes would count at once (or nothing changes), 'later' when none
 * would, else 'partly'. `waitingFor`: the friends (in the space now) holding back the rest: for a
 * Same-for-everyone line, those whose latest agreement doesn't have its text (or who never agreed); for a
 * per-friend line, those whose latest agreement still has it for everyone; for the streak rewards, those whose
 * latest agreement doesn't have them. `friends` as for the stakes card (termsFriends of the subject).
 */
export function agreeOutcome(
  space: Pick<Space, 'memberIds' | 'joinedAt' | 'leftAt'>,
  subject: UID,
  me: UID,
  friends: UID[],
  stakes: Stakes,
  house: House,
  nowMs: number,
): { counts: 'now' | 'partly' | 'later'; waitingFor: UID[] } {
  const own = stakes?.[subject]
  const terms = pairTerms(own, me)
  if (!own || !terms) return { counts: 'later', waitingFor: [] }
  const pals = unique([...friends, me]).filter((f) => f !== subject)
  const before = memberTerms(space, subject, pals, stakes, house, Infinity)[me]
  const latest = Math.max(-Infinity, ...pals.flatMap((f) => agreementsOf(own, f).map((a) => a.at)))
  // The server stamps my Agree after every earlier one and after I joined, whatever this device's clock says.
  const joined = space.joinedAt[me]
  const at = Math.max(nowMs, latest + 1, typeof joined === 'number' ? joined : -Infinity)
  const next = nextAgreement(own.agreed[me], terms)
  const withMine: Record<UID, MemberStakes> = next ? { ...stakes, [subject]: { ...own, agreed: { ...own.agreed, [me]: { at, ...next } } } } : { ...stakes }
  const after = memberTerms(space, subject, pals, withMine, house, Infinity)[me]

  const want = (line: Line) => ({ text: terms[line], together: (line === 'reward' ? terms.rewardMode : terms.penaltyMode) === 'group' })
  const sameLine = (l: LineInForce, w: { text: string; together: boolean }) => l.text === w.text && l.together === w.together
  const others = pals.filter((f) => f !== me && wasMemberAt(space, f, at))
  const latestOf = (f: UID): AgreedTerms | undefined => agreementsOf(own, f).at(-1)
  const blockers = new Set<UID>()
  let changed = 0
  let counting = 0
  for (const line of ['reward', 'penalty'] as const) {
    const w = want(line)
    if (sameLine(before[line], w)) continue
    changed += 1
    if (sameLine(after[line], w)) {
      counting += 1
      continue
    }
    for (const f of others) {
      const a = latestOf(f)
      const mode = a && (line === 'reward' ? a.rewardMode : a.penaltyMode)
      if (w.together ? !a || mode !== 'group' || a[line] !== w.text : !!a && mode !== 'each') blockers.add(f)
    }
  }
  if (!sameTiers(before.tiers, terms.tiers)) {
    changed += 1
    if (sameTiers(after.tiers, terms.tiers)) counting += 1
    else for (const f of others) if (!sameTiers(latestOf(f)?.tiers ?? [], terms.tiers) || !latestOf(f)) blockers.add(f)
  }
  const counts = counting === changed ? 'now' : counting === 0 ? 'later' : 'partly'
  return { counts, waitingFor: counts === 'now' ? [] : others.filter((f) => blockers.has(f)) }
}

/**
 * The month whose terms count now (SPEC §9.7): this week's month (its Friday's), or the next one once that month
 * is complete (monthEndsAt, with this week's stored doc as its last week and the month's list).
 */
export function termsMonth(space: Pick<Space, 'timezone' | 'schedule'>, nowMs: number, thisWeek?: Week | null, monthly?: MonthlyList | null): MonthId {
  const weekId = weekIdFor(nowMs, space.timezone)
  const monthId = monthIdForWeek(weekId)
  const end = monthEndsAtFor(space, monthId, thisWeek && thisWeek.id === weekId ? thisWeek : null, monthly)
  return nowMs >= end ? addMonths(monthId, 1) : monthId
}

/**
 * Whose agreement a month in progress waits for, as near to its `others` as the space doc tells: current members
 * other than `me` who don't judge, plus former members who left at or after the month's first lock
 * (`firstLockAt`: its first week's stored lock, else computed), since they still owe or are owed for it.
 */
export function termsFriends(space: Pick<Space, 'memberIds' | 'leftAt' | 'judges'>, me: UID, firstLockAt: number, judges: UID[] = spaceJudges(space)): UID[] {
  const current = space.memberIds.filter((uid) => uid !== me && !judges.includes(uid))
  const left = Object.entries(space.leftAt ?? {}).flatMap(([uid, at]) => (uid !== me && !space.memberIds.includes(uid) && at >= firstLockAt ? [uid] : []))
  return unique([...current, ...left])
}

/**
 * A month's terms, subject → friend (SPEC §9.7): the results doc's stored terms when present; else, once the
 * month is complete, memberTerms from the agreements made before `completeAt` with each player's `others`; before
 * that, every agreement so far with termsFriends ∪ others (what counts now, as on the stakes card). `house` is
 * the month's (monthHouse). Subjects without pairs are left out.
 */
export function monthTerms(
  space: Pick<Space, 'memberIds' | 'joinedAt' | 'leftAt' | 'judges'>,
  _monthId: MonthId,
  month: Record<UID, MemberMonthResult>,
  stakes: Stakes,
  house: House,
  at: { completeAt: number; firstLockAt: number },
  stored?: MonthResults | null,
): Record<UID, Record<UID, TermsInForce>> {
  if (stored?.terms) return stored.terms
  const results = Object.values(month)
  const complete = results.some((r) => r.complete)
  const players = new Set(results.flatMap((r) => r.others))
  const judges = spaceJudges(space)
  const out: Record<UID, Record<UID, TermsInForce>> = {}
  for (const r of results) {
    const friends = complete
      ? players.has(r.uid)
        ? r.others
        : []
      : players.has(r.uid) || (space.memberIds.includes(r.uid) && !judges.includes(r.uid))
        ? unique([...termsFriends(space, r.uid, at.firstLockAt, judges), ...r.others])
        : []
    if (friends.length === 0) continue
    out[r.uid] = memberTerms(space, r.uid, friends, stakes, house, complete ? at.completeAt : Infinity)
  }
  return out
}

/** The streak rewards in force for `subject`: those of any of their pairs whose tiers aren't empty (they all
 *  come from the one time the tiers were settled), else []. */
export function tiersInForce(terms: Record<UID, Record<UID, TermsInForce>> | null | undefined, subject: UID): StreakTier[] {
  for (const pair of Object.values(terms?.[subject] ?? {})) if (pair.tiers.length > 0) return cleanTiers(pair.tiers)
  return []
}

// ---------- House stakes per month ----------

/** A month freeze binds: before FIRST_RESULTS_MONTH any freeze (months the previous app froze at their first
 *  lock keep it); from it on only one made at completion (createdAt missing, or at most HOUSE_SLACK_MS before). */
export function freezeBinds(monthId: MonthId, frozen: Pick<MonthStakes, 'createdAt'>, completeAt: number): boolean {
  if (monthId < FIRST_RESULTS_MONTH) return true
  return frozen.createdAt === undefined || frozen.createdAt >= completeAt - HOUSE_SLACK_MS
}

/** A month's house stakes: its freeze when it binds, else the space's current text. `frozen` as useMonthStakes
 *  gives it (a fallback with `frozen: false` isn't a freeze). */
export function monthHouse(space: Pick<Space, 'reward' | 'penalty'>, monthId: MonthId, frozen: MonthStakes | null | undefined, completeAt: number): House & { frozen: boolean } {
  if (frozen?.frozen && freezeBinds(monthId, frozen, completeAt)) return { reward: frozen.reward, penalty: frozen.penalty, frozen: true }
  return { reward: space.reward, penalty: space.penalty, frozen: false }
}

/**
 * From when the rules accept a month's freeze (and insist on it before an owner's stakes edit): monthEndsAt (the
 * stored last week and list; computed without the doc), except for a space without `utcOffsetMin` and no stored
 * last week: the 5th of the next month, 00:00 UTC (the rules' fallback). A list later than that still decides.
 */
export function houseFreezeAt(space: Pick<Space, 'timezone' | 'schedule' | 'utcOffsetMin'>, monthId: MonthId, lastWeek?: Week | null, monthly?: MonthlyList | null): number {
  const weeks = weekIdsInMonth(monthId)
  const last = weeks[weeks.length - 1]
  const stored = lastWeek && lastWeek.id === last ? lastWeek : null
  const list = monthly && monthly.id === monthId ? monthly : null
  let at: number
  if (!stored && typeof space.utcOffsetMin !== 'number') {
    const [year, month] = addMonths(monthId, 1).split('-').map(Number)
    at = Date.UTC(year, month - 1, 5)
  } else {
    at = boundsFor(space, last, stored).deadlineAt
  }
  return list ? Math.max(at, list.deadlineAt) : at
}

/** The month should be frozen now: its freeze time has passed and it holds no binding freeze. */
export function needsHouseFreeze(monthId: MonthId, frozen: MonthStakes | null | undefined, freezeAt: number, completeAt: number, nowMs: number): boolean {
  if (nowMs < freezeAt) return false
  return !(frozen?.frozen && freezeBinds(monthId, frozen, completeAt))
}

function utcMonth(ms: number): MonthId {
  return new Date(ms).toISOString().slice(0, 7)
}

/** The months the rules check on an owner's stakes edit: the UTC calendar month of `nowMs` and the one before,
 *  oldest first, without months before the UTC month of the space's creation. */
export function houseFreezeMonths(space: Pick<Space, 'createdAt'>, nowMs: number): MonthId[] {
  const current = utcMonth(nowMs)
  const created = Number.isFinite(space.createdAt) && space.createdAt > 0 ? utcMonth(space.createdAt) : null
  return [addMonths(current, -1), current].filter((m) => created === null || m >= created)
}

// ---------- Debts and settling ----------

export interface Debt {
  monthId: MonthId
  /** Whose verdict (or streak) made this debt. */
  subject: UID
  /** The friend on the other side. */
  other: UID
  /** reward and tier: `other` owes `subject`; penalty: `subject` owes `other`. */
  kind: 'reward' | 'penalty' | 'tier'
  what: string
  /** Owed together with everyone else on the same line: a Same-for-everyone line, the house stakes, every tier. */
  together: boolean
  /** A streak reward: its length in months. */
  tier?: number
  source: 'agreed' | 'house'
}

/**
 * Every debt of a month (SPEC §9.7): for each member M with a verdict and each friend F in M's `others`, M passed
 * → F owes M the reward line in force, M missed → M owes F the penalty line in force (both directions appear, from
 * each one's verdict). Plus, when M passed, a streak reward for each friend whose terms carry tier `t` once
 * `tierRuns[M][t.months] === t.months` (the run first reached its length this month); none while `tierRuns` is
 * unknown (null). `terms` is the month's (monthTerms); a pair without terms owes nothing.
 */
export function monthDebts(
  monthId: MonthId,
  results: Record<UID, MemberMonthResult>,
  terms: Record<UID, Record<UID, TermsInForce>>,
  tierRuns: Record<UID, Record<string, number>> | null,
): Debt[] {
  const debts: Debt[] = []
  for (const r of Object.values(results)) {
    if (r.passed === null) continue
    for (const other of r.others) {
      const t = terms[r.uid]?.[other]
      if (!t) continue
      const line = r.passed ? t.reward : t.penalty
      debts.push({ monthId, subject: r.uid, other, kind: r.passed ? 'reward' : 'penalty', what: line.text, together: line.together, source: line.source })
      if (!r.passed || !tierRuns) continue
      for (const tier of t.tiers) {
        if (tierRuns[r.uid]?.[String(tier.months)] === tier.months) {
          debts.push({ monthId, subject: r.uid, other, kind: 'tier', what: tier.reward, together: true, tier: tier.months, source: 'agreed' })
        }
      }
    }
  }
  return debts
}

export interface DebtLine {
  subject: UID
  kind: Debt['kind']
  what: string
  tier?: number
  together: boolean
  source: 'agreed' | 'house'
  /** reward and tier: the friends who owe; penalty: [subject]. */
  debtors: UID[]
  /** reward and tier: [subject]; penalty: the friends owed. */
  creditors: UID[]
  /** The pairs one "Settled" tap marks. */
  keys: SettlementKey[]
}

const KIND_ORDER: Record<Debt['kind'], number> = { reward: 0, tier: 1, penalty: 2 }

/** Groups `together` debts with the same subject, kind, tier, text and source into one line ("Sam, Kim and Ana owe
 *  you: …"); each per-friend debt is its own line. Per subject (in order of appearance): reward, streak rewards
 *  ascending, penalty. */
export function debtLines(debts: Debt[]): DebtLine[] {
  const lines: DebtLine[] = []
  const grouped = new Map<string, DebtLine>()
  for (const d of debts) {
    const key = d.together ? JSON.stringify([d.subject, d.kind, d.tier ?? null, d.source, d.what]) : null
    let line = key === null ? undefined : grouped.get(key)
    if (!line) {
      line = { subject: d.subject, kind: d.kind, what: d.what, together: d.together, source: d.source, debtors: [], creditors: [], keys: [] }
      if (d.tier !== undefined) line.tier = d.tier
      lines.push(line)
      if (key !== null) grouped.set(key, line)
    }
    if (d.kind === 'penalty') {
      if (line.debtors.length === 0) line.debtors.push(d.subject)
      line.creditors.push(d.other)
    } else {
      if (line.creditors.length === 0) line.creditors.push(d.subject)
      line.debtors.push(d.other)
    }
    line.keys.push(d.tier === undefined ? { uid: d.subject, other: d.other } : { uid: d.subject, other: d.other, tier: d.tier })
  }
  const subjects = unique(lines.map((l) => l.subject))
  return lines
    .map((line, i) => ({ line, i }))
    .sort(
      (a, b) =>
        subjects.indexOf(a.line.subject) - subjects.indexOf(b.line.subject) ||
        KIND_ORDER[a.line.kind] - KIND_ORDER[b.line.kind] ||
        (a.line.tier ?? 0) - (b.line.tier ?? 0) ||
        a.i - b.i,
    )
    .map(({ line }) => line)
}

/** The settlement that decides one pair: its own doc, else (not for a streak reward) the member's doc from before
 *  batch 2. */
export function pairSettlement(settlements: Settlement[], monthId: MonthId, key: SettlementKey): Settlement | undefined {
  const inMonth = settlements.filter((s) => s.monthId === monthId && s.uid === key.uid)
  const pair = inMonth.find((s) => s.other === key.other && s.tier === key.tier)
  if (pair || key.tier !== undefined) return pair
  return inMonth.find((s) => s.other === undefined && s.tier === undefined)
}

/** A line is settled when every pair on it is; `last` is the newest of those marks (only when settled). */
export function lineSettlement(settlements: Settlement[], monthId: MonthId, line: Pick<DebtLine, 'keys'>): { settled: boolean; last?: Settlement } {
  const marks = line.keys.map((key) => pairSettlement(settlements, monthId, key))
  if (marks.length === 0 || !marks.every((s) => s?.settled)) return { settled: false }
  const last = (marks as Settlement[]).reduce((a, b) => (b.settledAt > a.settledAt ? b : a))
  return { settled: true, last }
}

// ---------- Streaks and month results ----------

type Verdict = Pick<MemberMonthResult, 'finalScore' | 'passed' | 'others'>

function skipped(month: Verdict | undefined): boolean {
  return !month || month.finalScore === null || month.passed === null || month.others.length === 0
}

/** The streak after a month: a pass adds one, a miss starts over, and a month with no score (sat out, judged,
 *  every week paused) or with nobody else playing is skipped. */
export function nextStreak(prev: number, month: Verdict | undefined): number {
  if (skipped(month)) return prev
  return month?.passed ? prev + 1 : 0
}

/**
 * Each streak reward's own run after a month (SPEC §9.8), keyed by its length: for the tiers in force this month,
 * a pass adds one and a miss resets it to 0; a tier not in force drops its run; a skipped month carries every run.
 */
export function nextTierRuns(prev: Record<string, number> | null | undefined, month: Verdict | undefined, tiers: StreakTier[]): Record<string, number> {
  if (skipped(month)) return { ...(prev ?? {}) }
  const out: Record<string, number> = {}
  for (const tier of tiers) {
    const key = String(tier.months)
    out[key] = month?.passed ? (prev?.[key] ?? 0) + 1 : 0
  }
  return out
}

function entryFor(prev: MonthResultsEntry | undefined, month: MemberMonthResult | undefined, tiers: StreakTier[]): MonthResultsEntry {
  const tierRuns = nextTierRuns(prev?.tierRuns, month, tiers)
  const entry: MonthResultsEntry = { score: month?.finalScore ?? null, passed: month?.passed ?? null, streak: nextStreak(prev?.streak ?? 0, month) }
  if (Object.keys(tierRuns).length > 0) entry.tierRuns = tierRuns
  return entry
}

/**
 * The results doc of a complete month (without `createdAt`): every roster member and everyone in the previous
 * month's doc (streaks and runs carry while someone sits out), streaks, tier runs from tiersInForce(terms), and
 * `terms` (subjects with pairs only; absent when there are none).
 */
export function buildMonthResults(
  monthId: MonthId,
  completeAt: number,
  month: Record<UID, MemberMonthResult>,
  prev: MonthResults | null | undefined,
  terms: Record<UID, Record<UID, TermsInForce>>,
): Omit<MonthResults, 'createdAt'> {
  const members: Record<UID, MonthResultsEntry> = {}
  for (const uid of unique([...Object.keys(month), ...Object.keys(prev?.members ?? {})])) {
    members[uid] = entryFor(prev?.members[uid], month[uid], tiersInForce(terms, uid))
  }
  const kept = Object.fromEntries(Object.entries(terms).filter(([, pairs]) => Object.keys(pairs).length > 0))
  const out: Omit<MonthResults, 'createdAt'> = { monthId, completeAt, members }
  if (Object.keys(kept).length > 0) out.terms = kept
  return out
}

export interface Streaks {
  streaks: Record<UID, number>
  tierRuns: Record<UID, Record<string, number>>
}

function streaksOf(members: Record<UID, MonthResultsEntry>): Streaks {
  const streaks: Record<UID, number> = {}
  const tierRuns: Record<UID, Record<string, number>> = {}
  for (const [uid, entry] of Object.entries(members)) {
    streaks[uid] = entry.streak
    tierRuns[uid] = { ...(entry.tierRuns ?? {}) }
  }
  return { streaks, tierRuns }
}

/**
 * Streaks and runs after `monthId` before the job wrote its results: from the previous month's doc, or from 0 in
 * the space's first month or in FIRST_RESULTS_MONTH; else null (unknown: tier debts aren't shown yet). Nothing
 * before FIRST_RESULTS_MONTH.
 */
export function provisionalStreaks(
  monthId: MonthId,
  firstMonthId: MonthId | null,
  prev: MonthResults | null | undefined,
  month: Record<UID, MemberMonthResult>,
  terms: Record<UID, Record<UID, TermsInForce>>,
): Streaks | null {
  if (monthId < FIRST_RESULTS_MONTH) return null
  if (!prev && monthId !== FIRST_RESULTS_MONTH && monthId !== firstMonthId) return null
  return streaksOf(buildMonthResults(monthId, 0, month, prev ?? null, terms).members)
}

/** The streaks and runs to use for a month: its own results doc, else provisionalStreaks. */
export function streaksFor(
  monthId: MonthId,
  firstMonthId: MonthId | null,
  own: MonthResults | null | undefined,
  prev: MonthResults | null | undefined,
  month: Record<UID, MemberMonthResult>,
  terms: Record<UID, Record<UID, TermsInForce>>,
): Streaks | null {
  if (own) return streaksOf(own.members)
  return provisionalStreaks(monthId, firstMonthId, prev, month, terms)
}

