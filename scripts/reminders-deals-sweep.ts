// The pre-deals oracle sweep (SPEC §12.15), shared by scripts/reminders-deals-sweep-*.test.ts (the zones are split
// over a few test files so they run in parallel): on spaces without deals, every hour of October 2026, with verdicts of
// months up to October and house and stakes notes from before the cutover, the planner decides exactly what the frozen
// pre-deals planner (scripts/reminders-predeals-oracle.ts) decides, with `dealsFrom` absent and '2026-11'; with deals
// loaded beside the same inputs it only adds `deal` / `deal-end` entries. Nothing in the app or the job imports this.
// The sweep's speed-ups (memoized pure time functions) are in scripts/reminders-deals-sweep-memo.ts.
import { DateTime } from 'luxon'
import { DEALS_FROM_MONTH } from '../src/domain/deals.ts'
import { DEFAULT_SCHEDULE, monthlyBounds, weekBounds } from '../src/domain/time.ts'
import type { Deal, Mark, MemberStakes, MonthId, MonthlyData, MonthResults, PairTerms, Space, UID, WeekData, WeekId } from '../src/domain/types.ts'
import {
  dueWindows as oracleDueWindows,
  planSpace as oraclePlanSpace,
  planWindows as oraclePlanWindows,
  type SpaceInput as OracleSpaceInput,
} from './reminders-predeals-oracle.ts'
import { dueWindows, planSpace, planWindows, type PlanResult, type SpaceInput } from './reminders-plan.ts'

const HOUR = 3_600_000
const PROFILES = { a: { name: 'Lena' }, b: { name: 'Sam' }, c: { name: 'Kim' }, d: { name: 'Ana' } }
const MEMBERS = ['a', 'b', 'c', 'd']

/** The zones of the earlier sweeps: DST on either side, half-hour and +14 offsets. */
export const SWEEP_ZONES = ['Europe/Berlin', 'America/Los_Angeles', 'Australia/Sydney', 'Asia/Kolkata', 'America/Santiago', 'Asia/Beirut', 'Australia/Lord_Howe', 'Pacific/Kiritimati']

function week(tz: string, weekId: WeekId, filled: boolean, i: number): WeekData {
  const data: WeekData = { spaceId: 's1', weekId, week: null, plans: {}, progress: {}, reviews: [] }
  if (!filled) return data
  const b = weekBounds(weekId, tz, DEFAULT_SCHEDULE)
  const closed = i < 7
  data.week = { id: weekId, spaceId: 's1', ...b, members: MEMBERS, submittedBy: closed ? ['a', 'b', 'd'] : [], judges: ['d'] }
  const plans: Record<UID, number> = { a: 2, b: 1, c: i % 2 }
  for (const [uid, n] of Object.entries(plans)) data.plans[uid] = { uid, updatedAt: 0, tasks: Array.from({ length: n }, (_, k) => ({ id: `${uid}${k + 1}`, title: `Task ${k + 1}` })) }
  data.progress.a = { uid: 'a', updatedAt: 0, done: { a1: true } }
  if (i % 2) data.progress.b = { uid: 'b', updatedAt: 0, done: { b1: true } }
  if (closed) {
    const marks: Record<UID, Mark> = { a: 1, b: i % 2 ? 1 : 0, c: 0.5 }
    data.reviews = MEMBERS.flatMap((r) =>
      ['a', 'b', 'c'].filter((m) => m !== r).map((m) => ({ id: `${r}_${m}`, reviewerId: r, revieweeId: m, marks: { [`${m}1`]: marks[m] }, submittedAt: b.reviewOpenAt })),
    )
  }
  return data
}

function list(tz: string, monthId: MonthId, reviewed: boolean): MonthlyData {
  const b = monthlyBounds(monthId, (w) => weekBounds(w, tz))
  const data: MonthlyData = {
    spaceId: 's1', monthId, plans: {}, progress: {}, reviews: [],
    monthly: { id: monthId, spaceId: 's1', ...b, members: MEMBERS, submittedBy: reviewed ? ['a'] : [], judges: [] },
  }
  data.plans.a = { uid: 'a', updatedAt: 0, tasks: [{ id: 'am1', title: 'Big one' }] }
  if (reviewed) {
    data.plans.b = { uid: 'b', updatedAt: 0, tasks: [{ id: 'bm1', title: 'Big one' }] }
    data.reviews = [{ id: 'a_b', reviewerId: 'a', revieweeId: 'b', marks: { bm1: 1 }, submittedAt: b.reviewOpenAt }]
  }
  return data
}

/**
 * A space in `tz` with what the planner looks at in October 2026, every note from before the cutover: the weeks from
 * September's first to November's first (plans, ticks, reviews, a judge; every third without a doc), the September
 * and October lists, stakes changed in mid- and late October, and per variant a house note (Oct 14 or Oct 29), a
 * pause request, or a change of times.
 */
export function octoberInput(tz: string, variant: number): SpaceInput {
  const local = (iso: string) => DateTime.fromISO(iso, { zone: tz }).toMillis()
  const ids = ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02']
  const weeks = ids.map((id, i) => week(tz, id, i % 3 !== 2, i))
  const terms: PairTerms = { rewardMode: 'group', penaltyMode: 'group', reward: 'Lunch', penalty: 'Coffee', tiers: [{ months: 2, reward: 'Spa day' }] }
  const updatedAt = local('2026-10-13T12:00')
  const memberStakes: Record<UID, MemberStakes> = {
    b: { uid: 'b', ...terms, per: {}, agreed: { c: { at: updatedAt + 1000, terms, past: [] } }, updatedAt },
    a: { uid: 'a', ...terms, reward: 'Pizza', per: {}, agreed: {}, updatedAt: local('2026-10-27T15:00') },
  }
  const space: Space = {
    id: 's1', name: 'Film Club', reward: 'Dinner on me', penalty: 'Coffee for a week', ownerId: 'a', memberIds: MEMBERS, joinedAt: {}, timezone: tz,
    inviteCode: 'ABCD2345', threshold: 90, latePenalty: 5, createdAt: Date.parse('2026-08-01T12:00:00Z'), judges: ['d'],
    stakesNote: { by: 'a', at: local(variant === 0 ? '2026-10-14T10:00' : '2026-10-29T18:00') },
  }
  if (variant === 1) space.pause = { weekId: '2026-10-19', by: 'b', at: local('2026-10-14T21:30'), oks: ['b'] }
  if (variant === 2) {
    space.scheduleNote = { by: 'a', at: local('2026-10-08T10:00'), fromWeek: '2026-10-12', before: DEFAULT_SCHEDULE }
    space.schedule = { lock: 1200, reviewOpen: 5760, deadline: 7920 }
  }
  const results: Record<MonthId, MonthResults | null> = { '2026-09': null, '2026-10': null }
  return {
    space,
    weeks: Object.fromEntries(weeks.map((w) => [w.weekId, w])),
    monthly: { '2026-09': list(tz, '2026-09', false), '2026-10': list(tz, '2026-10', true) },
    memberStakes,
    results,
  }
}

function deal(over: Partial<Deal> & Pick<Deal, 'uid' | 'seq' | 'createdAt'>): Deal {
  return {
    id: `${over.uid}_${over.seq}`, spaceId: 's1', unit: 'week', count: 4, rewardMode: 'group', penaltyMode: 'group', reward: 'Dinner, on us',
    penalty: 'Coffee for a week', per: {}, friends: ['b', 'c'], agreed: {}, off: {}, settled: {}, ended: null, ...over,
  }
}

/** The same input with deals loaded (a waiting one, a running one and one that ended), on a space with `hasDeals`. */
export function withDeals(input: SpaceInput): SpaceInput {
  const local = (iso: string) => DateTime.fromISO(iso, { zone: input.space.timezone }).toMillis()
  const waiting = deal({ uid: 'a', seq: 2, agreed: { b: local('2026-10-20T12:00') }, createdAt: local('2026-10-19T12:00') })
  const running = deal({
    uid: 'c', seq: 1, friends: ['a', 'b'], agreed: { a: local('2026-10-01T12:00'), b: local('2026-10-02T12:00') }, createdAt: local('2026-09-30T12:00'),
    start: '2026-10-05', agreedAt: local('2026-10-02T12:00'),
  })
  const won = deal({
    uid: 'b', seq: 1, friends: ['a', 'c'], agreed: { a: local('2026-10-01T10:00'), c: local('2026-10-01T11:00') }, createdAt: local('2026-10-01T09:00'),
    start: '2026-10-05', count: 1, track: [{ id: '2026-10-05', result: 'pass', score: 100 }], ended: { outcome: 'won', at: local('2026-10-10T00:00'), period: '2026-10-05' },
  })
  return { ...input, space: { ...input.space, hasDeals: true }, deals: { open: [waiting, running], recent: [won] } }
}

const DEAL_KINDS = new Set(['deal', 'deal-end'])
const withoutDeals = (r: PlanResult): PlanResult => ({
  send: r.send.filter((s) => !DEAL_KINDS.has(s.kind)),
  skipped: r.skipped.filter((k) => !/_(deal|deal-end)_[^_]+$/.test(k)),
})

export interface SweepResult {
  mismatches: string[]
  checks: number
  /** Pushes and final no-ops the oracle decided, summed over the hours: the sweep compares real decisions. */
  decided: number
  /** `deal` / `deal-end` entries the deals input added. */
  dealEntries: number
}

/**
 * Every hour of October 2026 (UTC 00:17 to Oct 31 23:17) in each zone, each zone with the three variants in turn: the
 * planner with `dealsFrom` absent, with DEALS_FROM_MONTH, and with deals loaded (deal entries left out) against the
 * oracle's planSpace; planWindows and dueWindows against the oracle's every 4 hours.
 */
export function sweepOctober(zones: string[]): SweepResult {
  const out: SweepResult = { mismatches: [], checks: 0, decided: 0, dealEntries: 0 }
  for (const [z, zone] of zones.entries()) {
    const variant = (SWEEP_ZONES.indexOf(zone) + z) % 3
    const input = octoberInput(zone, variant)
    const oracleInput = input as OracleSpaceInput
    const dealsInput = withDeals(input)
    const first = Date.parse('2026-10-01T00:17:00Z')
    for (let t = first; t <= Date.parse('2026-10-31T23:17:00Z'); t += HOUR) {
      const at = `${zone} v${variant} ${new Date(t).toISOString()}`
      const want = JSON.stringify(oraclePlanSpace(oracleInput, PROFILES, new Set(), t))
      const parsed = JSON.parse(want) as PlanResult
      out.decided += parsed.send.length + parsed.skipped.length
      const withDealsResult = planSpace(dealsInput, PROFILES, new Set(), t)
      out.dealEntries += withDealsResult.send.length + withDealsResult.skipped.length - withoutDeals(withDealsResult).send.length - withoutDeals(withDealsResult).skipped.length
      const got: [string, PlanResult][] = [
        ['absent', planSpace(input, PROFILES, new Set(), t)],
        ['2026-11', planSpace({ ...input, dealsFrom: DEALS_FROM_MONTH }, PROFILES, new Set(), t)],
        ['deals', withoutDeals(withDealsResult)],
      ]
      for (const [name, result] of got) {
        out.checks += 1
        if (JSON.stringify(result) !== want) out.mismatches.push(`${at} planSpace ${name}`)
      }
      if ((t - first) % (4 * HOUR) !== 0) continue
      const windows = JSON.stringify(oraclePlanWindows(oracleInput, t))
      out.checks += 3
      if (JSON.stringify(planWindows(input, t)) !== windows) out.mismatches.push(`${at} planWindows`)
      if (JSON.stringify(planWindows(dealsInput, t).filter((w) => !DEAL_KINDS.has(w.kind))) !== windows) out.mismatches.push(`${at} planWindows with deals`)
      if (JSON.stringify(dueWindows(input.space, t)) !== JSON.stringify(oracleDueWindows(input.space, t))) out.mismatches.push(`${at} dueWindows`)
    }
  }
  return out
}
