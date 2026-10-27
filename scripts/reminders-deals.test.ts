// The deals reminders (SPEC §12.11): the `deal` and `deal-end` pushes, and the month stakes cutover (`dealsFrom`) in the
// verdict, `house` and `stakes`. The sweep against the frozen pre-deals planner (scripts/reminders-predeals-oracle.ts)
// is in scripts/reminders-deals-sweep-*.test.ts.
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SCHEDULE, monthlyBounds, weekBounds, weekIdsInMonth } from '../src/domain/time.ts'
import type { Deal, Mark, MemberStakes, MonthId, MonthlyData, MonthResults, PairTerms, Space, TermsInForce, UID, WeekData, WeekId, WeekSchedule } from '../src/domain/types.ts'
import { planSpace as oraclePlanSpace, type SpaceInput as OracleSpaceInput } from './reminders-predeals-oracle.ts'
import { dealCandidates, planSpace, stakesCandidates, type PlanResult, type Reminder, type SpaceInput } from './reminders-plan.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const PROFILES = { a: { name: 'Lena' }, b: { name: 'Sam' }, c: { name: 'Kim' }, d: { name: 'Ana' } }

function makeSpace(timezone: string, overrides: Partial<Space> = {}): Space {
  return {
    id: 's1',
    name: 'Film Club',
    reward: 'Dinner on me',
    penalty: 'Coffee for a week',
    ownerId: 'a',
    memberIds: ['a', 'b', 'c', 'd'],
    joinedAt: {},
    timezone,
    utcOffsetMin: 60,
    inviteCode: 'ABCD2345',
    threshold: 90,
    latePenalty: 5,
    createdAt: Date.parse('2026-08-01T12:00:00Z'),
    ...overrides,
  }
}

interface PeriodSpec {
  members: UID[]
  submittedBy?: UID[]
  plans?: Record<UID, number>
  done?: Record<UID, string[]>
  reviews?: [UID, UID, Record<string, Mark>][]
  judges?: UID[]
  schedule?: WeekSchedule
}

function fill<T extends WeekData | MonthlyData>(data: T, spec: PeriodSpec, prefix: string, reviewAt: number): T {
  for (const [uid, n] of Object.entries(spec.plans ?? {})) {
    data.plans[uid] = { uid, updatedAt: 0, tasks: Array.from({ length: n }, (_, i) => ({ id: `${uid}${prefix}${i + 1}`, title: `Task ${i + 1}` })) }
  }
  for (const [uid, ids] of Object.entries(spec.done ?? {})) data.progress[uid] = { uid, updatedAt: 0, done: Object.fromEntries(ids.map((id) => [id, true])) }
  data.reviews = (spec.reviews ?? []).map(([reviewerId, revieweeId, marks]) => ({ id: `${reviewerId}_${revieweeId}`, reviewerId, revieweeId, marks, submittedAt: reviewAt }))
  return data
}

function week(tz: string, weekId: WeekId, spec: PeriodSpec | null): WeekData {
  const data: WeekData = { spaceId: 's1', weekId, week: null, plans: {}, progress: {}, reviews: [] }
  if (!spec) return data
  const b = weekBounds(weekId, tz, spec.schedule ?? DEFAULT_SCHEDULE)
  data.week = { id: weekId, spaceId: 's1', ...b, members: spec.members, submittedBy: spec.submittedBy ?? [] }
  if (spec.schedule) data.week.schedule = spec.schedule
  if (spec.judges) data.week.judges = spec.judges
  return fill(data, spec, '', b.reviewOpenAt)
}

function list(tz: string, monthId: MonthId, spec: PeriodSpec | null): MonthlyData {
  const data: MonthlyData = { spaceId: 's1', monthId, monthly: null, plans: {}, progress: {}, reviews: [] }
  if (!spec) return data
  const b = monthlyBounds(monthId, (w) => weekBounds(w, tz))
  data.monthly = { id: monthId, spaceId: 's1', ...b, members: spec.members, submittedBy: spec.submittedBy ?? [], judges: spec.judges ?? [] }
  return fill(data, spec, 'm', b.reviewOpenAt)
}

const byId = <T extends { weekId: string } | { monthId: string }>(items: T[]) => Object.fromEntries(items.map((x) => ['weekId' in x ? x.weekId : x.monthId, x]))

// ---------- Deal pushes ----------

const TZ = 'Europe/Berlin'
const local = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toMillis()

function deal(over: Partial<Deal> & Pick<Deal, 'uid' | 'seq'>): Deal {
  return {
    id: `${over.uid}_${over.seq}`,
    spaceId: 's1',
    unit: 'week',
    count: 4,
    rewardMode: 'group',
    penaltyMode: 'group',
    reward: 'Dinner, on us',
    penalty: 'Coffee for a week',
    per: {},
    friends: ['b', 'c'],
    agreed: {},
    off: {},
    settled: {},
    createdAt: local('2026-11-03T12:00'),
    ended: null,
    ...over,
  }
}

const space3 = (over: Partial<Space> = {}) => makeSpace(TZ, { memberIds: ['a', 'b', 'c'], hasDeals: true, ...over })
const plan = (space: Space, nowMs: number, deals: { open?: Deal[]; recent?: Deal[] }, sent: string[] = [], extra: Partial<SpaceInput> = {}) =>
  planSpace({ space, weeks: {}, deals: { open: deals.open ?? [], recent: deals.recent ?? [] }, ...extra }, PROFILES, new Set(sent), nowMs)
const lines = (r: PlanResult) => r.send.map((s) => `${s.uid} | ${s.title} | ${s.body}`)

describe('the deal push', () => {
  const waiting = deal({ uid: 'a', seq: 3 })
  const at = local('2026-11-03T12:17')

  it('asks each friend still to agree, once, with a per-deal tag', () => {
    const r = plan(space3(), at, { open: [waiting] })
    expect(lines(r)).toEqual(
      ['b', 'c'].map((u) => `${u} | New deal from Lena | Lena wants a deal in Film Club: 4 weeks at 90%+. Take a look, and tap Agree if you’re in.`),
    )
    expect(r.send[0]).toEqual<Reminder>({
      key: 's1_a@3_deal_b',
      kind: 'deal',
      spaceId: 's1',
      uid: 'b',
      title: 'New deal from Lena',
      body: 'Lena wants a deal in Film Club: 4 weeks at 90%+. Take a look, and tap Agree if you’re in.',
      url: './?space=s1',
      tag: 'deal-s1-a@3',
      expiresAt: waiting.createdAt + 7 * DAY,
    })
    expect(r.skipped).toEqual([])
    // Once (the key), not to the person.
    expect(plan(space3(), at + HOUR, { open: [waiting] }, ['s1_a@3_deal_b']).send.map((s) => s.uid)).toEqual(['c'])
    expect(dealCandidates(space3(), [waiting], [], at).map((c) => c.to)).toEqual(['b', 'c'])
  })

  it('only 09:00–21:00 local: none at 08:59, at 21:00 or at night', () => {
    for (const iso of ['2026-11-04T08:59', '2026-11-04T21:00', '2026-11-04T03:00', '2026-11-04T00:00', '2026-11-04T07:59']) {
      expect(plan(space3(), local(iso), { open: [waiting] }).send).toEqual([])
    }
    expect(plan(space3(), local('2026-11-04T09:00'), { open: [waiting] }).send).toHaveLength(2)
    expect(plan(space3(), local('2026-11-04T20:59'), { open: [waiting] }).send).toHaveLength(2)
  })

  it('final once a friend agreed or the deal no longer waits; none after 7 days or before it was proposed', () => {
    const one = { ...waiting, agreed: { b: local('2026-11-03T13:00') } }
    const r = plan(space3(), at + 2 * HOUR, { open: [one] })
    expect(r.send.map((s) => s.uid)).toEqual(['c'])
    expect(r.skipped).toEqual(['s1_a@3_deal_b'])
    // Everyone agreed: not waiting any more.
    const all = { ...waiting, agreed: { b: local('2026-11-03T13:00'), c: local('2026-11-03T13:30') } }
    expect(plan(space3(), at + 2 * HOUR, { open: [all] })).toEqual({ send: [], skipped: ['s1_a@3_deal_b', 's1_a@3_deal_c'] })
    // Already logged: nothing more.
    expect(plan(space3(), at + 2 * HOUR, { open: [all] }, ['s1_a@3_deal_b', 's1_a@3_deal_c'])).toEqual({ send: [], skipped: [] })
    expect(plan(space3(), waiting.createdAt + 7 * DAY - HOUR, { open: [waiting] }).send).toHaveLength(2)
    expect(plan(space3(), waiting.createdAt + 7 * DAY + HOUR, { open: [waiting] })).toEqual({ send: [], skipped: [] })
    expect(dealCandidates(space3(), [waiting], [], waiting.createdAt - HOUR)).toEqual([])
  })

  it('none while its person isn’t a member (the job withdraws it); none to a friend who left', () => {
    const gone = space3({ memberIds: ['b', 'c'], leftAt: { a: local('2026-11-03T12:10') } })
    expect(plan(gone, at, { open: [waiting] })).toEqual({ send: [], skipped: ['s1_a@3_deal_b', 's1_a@3_deal_c'] })
    const kimLeft = space3({ memberIds: ['a', 'b'], leftAt: { c: local('2026-11-03T12:10') } })
    expect(plan(kimLeft, at, { open: [waiting] }).send.map((s) => s.uid)).toEqual(['b'])
  })

  it('no deal input, no deal push (the job loads deals only for a space with hasDeals)', () => {
    expect(planSpace({ space: space3(), weeks: {} }, PROFILES, new Set(), at)).toEqual({ send: [], skipped: [] })
  })
})

describe('the deal-end push', () => {
  const agreed = { b: local('2026-10-28T12:00'), c: local('2026-10-29T12:00') }
  const base = { uid: 'a', seq: 3, agreed, agreedAt: agreed.c, start: '2026-11-02', createdAt: local('2026-10-27T12:00') }
  const passes = ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23'].map((id) => ({ id, result: 'pass' as const, score: 95 }))
  const won = deal({ ...base, track: passes, ended: { outcome: 'won', at: local('2026-11-28T00:00'), period: '2026-11-23' } })
  const lostAt = local('2026-11-21T00:00')
  const lost = (score: number | null, extra: { missed?: number; why?: 'judge' | 'left' } = {}, over: Partial<Deal> = {}) =>
    deal({
      ...base,
      track: [passes[0], passes[1], { id: '2026-11-16', result: 'miss', score, ...extra }],
      ended: { outcome: 'lost', at: lostAt, period: '2026-11-16', score },
      ...over,
    })
  const sat = local('2026-11-28T10:17')
  const after = (d: Deal, nowMs: number, space = space3(), extra: Partial<SpaceInput> = {}) => lines(plan(space, nowMs, { recent: [d] }, [], extra))
  const perFriend = { b: { reward: 'Lunch', penalty: 'A coffee' }, c: { reward: 'A movie', penalty: 'A beer' } }

  it('won: the person collects, each party owes (together or their own)', () => {
    expect(after(won, sat)).toEqual([
      'a | You made it: 4 weeks at 90%+ | Your deal in Film Club is done. Collect from Sam and Kim: Dinner, on us.',
      'b | Lena made it | 4 weeks at 90%+ in Film Club. You owe Lena: Dinner, on us.',
      'c | Lena made it | 4 weeks at 90%+ in Film Club. You owe Lena: Dinner, on us.',
    ])
    expect(after({ ...won, rewardMode: 'each', reward: '', per: perFriend }, sat)).toEqual([
      'a | You made it: 4 weeks at 90%+ | Your deal in Film Club is done. Collect from Sam and Kim.',
      'b | Lena made it | 4 weeks at 90%+ in Film Club. You owe Lena: Lunch.',
      'c | Lena made it | 4 weeks at 90%+ in Film Club. You owe Lena: A movie.',
    ])
    const r = plan(space3(), sat, { recent: [won] })
    expect(r.send[0]).toMatchObject({ key: 's1_a@3_deal-end_a', kind: 'deal-end', tag: 'deal-s1-a@3', url: './?space=s1', expiresAt: won.ended!.at + 3 * DAY })
  })

  it('lost: the week’s deal score, the missed reviews, judged, left (parties only), months', () => {
    const at = local('2026-11-21T10:17')
    expect(after(lost(84), at)).toEqual([
      'a | Your deal ended | The week of Nov 16 in Film Club was 84%. Pay up to Sam and Kim: Coffee for a week.',
      'b | Lena’s deal ended | Lena’s week of Nov 16 in Film Club was 84%. Lena owes you: Coffee for a week.',
      'c | Lena’s deal ended | Lena’s week of Nov 16 in Film Club was 84%. Lena owes you: Coffee for a week.',
    ])
    expect(after(lost(84, {}, { penaltyMode: 'each', penalty: '', per: perFriend }), at)).toEqual([
      'a | Your deal ended | The week of Nov 16 in Film Club was 84%. Pay up to Sam and Kim.',
      'b | Lena’s deal ended | Lena’s week of Nov 16 in Film Club was 84%. Lena owes you: A coffee.',
      'c | Lena’s deal ended | Lena’s week of Nov 16 in Film Club was 84%. Lena owes you: A beer.',
    ])
    expect(after(lost(87, { missed: 1 }), at)[0]).toBe(
      'a | Your deal ended | The week of Nov 16 in Film Club was 87% for your deal (92%, minus 5 for a missed review). Pay up to Sam and Kim: Coffee for a week.',
    )
    expect(after(lost(82, { missed: 2 }), at)[0]).toBe(
      'a | Your deal ended | The week of Nov 16 in Film Club was 82% for your deal (92%, minus 10 for 2 missed reviews). Pay up to Sam and Kim: Coffee for a week.',
    )
    expect(after(lost(null, { why: 'judge' }), at)).toEqual([
      'a | Your deal ended | You judged the week of Nov 16 in Film Club, so it counts as a miss. Pay up to Sam and Kim: Coffee for a week.',
      'b | Lena’s deal ended | Lena judged the week of Nov 16 in Film Club, so it counts as a miss. Lena owes you: Coffee for a week.',
      'c | Lena’s deal ended | Lena judged the week of Nov 16 in Film Club, so it counts as a miss. Lena owes you: Coffee for a week.',
    ])
    // Left: lost at the lock of the week she wasn't in; the person isn't a member, so only the parties hear.
    const lockAt = local('2026-11-16T00:00')
    const left = lost(null, { why: 'left' }, { ended: { outcome: 'lost', at: lockAt, period: '2026-11-16', score: null } })
    const gone = space3({ memberIds: ['b', 'c'], leftAt: { a: local('2026-11-14T12:00') } })
    const leftLines = [
      'b | Lena’s deal ended | Lena left Film Club during the deal, so it counts as a miss. Lena owes you: Coffee for a week.',
      'c | Lena’s deal ended | Lena left Film Club during the deal, so it counts as a miss. Lena owes you: Coffee for a week.',
    ]
    expect(after(left, local('2026-11-16T10:17'), gone)).toEqual(leftLines)
    // A deleted account: no profile.
    const noLena = lines(planSpace({ space: gone, weeks: {}, deals: { open: [], recent: [left] } }, { b: { name: 'Sam' }, c: { name: 'Kim' } }, new Set(), local('2026-11-16T10:17')))
    expect(noLena[0]).toBe('b | A former member’s deal ended | A former member left Film Club during the deal, so it counts as a miss. A former member owes you: Coffee for a week.')
    // Months: the month's name.
    const month = deal({
      ...base, unit: 'month', count: 3, start: '2026-11', track: [{ id: '2026-11', result: 'miss', score: 84 }],
      ended: { outcome: 'lost', at: local('2026-11-28T00:00'), period: '2026-11', score: 84 },
    })
    expect(after(month, sat)).toEqual([
      'a | Your deal ended | November in Film Club was 84%. Pay up to Sam and Kim: Coffee for a week.',
      'b | Lena’s deal ended | Lena’s November in Film Club was 84%. Lena owes you: Coffee for a week.',
      'c | Lena’s deal ended | Lena’s November in Film Club was 84%. Lena owes you: Coffee for a week.',
    ])
  })

  it('off: called off (person and parties), alone (the person only); nothing for a withdrawn deal', () => {
    const offAt = local('2026-11-10T15:00')
    const calledOff = deal({ ...base, off: { a: offAt - HOUR, b: offAt - 1000, c: offAt }, ended: { outcome: 'off', at: offAt, reason: 'called-off' } })
    expect(after(calledOff, offAt + 17 * 60_000)).toEqual([
      'a | Your deal is off | Everyone in Film Club called it off. Nothing’s owed.',
      'b | Lena’s deal is off | Everyone called it off. Nothing’s owed.',
      'c | Lena’s deal is off | Everyone called it off. Nothing’s owed.',
    ])
    const lockAt = local('2026-11-09T00:00')
    const alone = deal({ ...base, track: [passes[0]], ended: { outcome: 'off', at: lockAt, reason: 'alone' } })
    const left = space3({ memberIds: ['a'], leftAt: { b: local('2026-11-05T12:00'), c: local('2026-11-06T12:00') } })
    expect(after(alone, local('2026-11-09T10:17'), left)).toEqual(['a | Your deal is off | Everyone in your deal left Film Club, so nothing’s owed.'])
    const withdrawn = deal({ uid: 'a', seq: 3, ended: { outcome: 'withdrawn', at: local('2026-11-03T13:00'), by: 'a' } })
    expect(dealCandidates(space3(), [], [withdrawn], local('2026-11-03T14:00'))).toEqual([])
  })

  it('from laterAwakeAt(ended.at) until 3 days after the end', () => {
    const lateEnd = deal({ ...base, track: passes, ended: { outcome: 'won', at: local('2026-11-25T22:00'), period: '2026-11-23' } })
    expect(dealCandidates(space3(), [], [lateEnd], local('2026-11-26T08:00'))).toEqual([])
    expect(dealCandidates(space3(), [], [lateEnd], local('2026-11-26T09:00')).map((c) => [c.to, c.opensAt, c.expiresAt])).toEqual(
      ['a', 'b', 'c'].map((u) => [u, local('2026-11-26T09:00'), local('2026-11-28T22:00')]),
    )
    expect(dealCandidates(space3(), [], [lateEnd], local('2026-11-28T21:59'))).toHaveLength(3)
    expect(dealCandidates(space3(), [], [lateEnd], local('2026-11-28T22:00'))).toEqual([])
    // Event hours: the planner sends only 09:00–21:00.
    expect(plan(space3(), local('2026-11-27T21:30'), { recent: [lateEnd] }).send).toEqual([])
  })

  it('has its own tag, beside a `stakes` push in the same space', () => {
    const terms: PairTerms = { rewardMode: 'group', penaltyMode: 'group', reward: 'Lunch', penalty: 'Coffee', tiers: [{ months: 2, reward: 'Spa day' }] }
    const ben: MemberStakes = { uid: 'b', ...terms, per: {}, agreed: {}, updatedAt: local('2026-11-27T12:00') }
    const r = plan(space3(), sat, { recent: [won] }, [], { memberStakes: { b: ben } })
    const tags = new Set(r.send.map((s) => `${s.kind}:${s.tag}`))
    expect(tags).toEqual(new Set(['deal-end:deal-s1-a@3', 'stakes:stakes-s1']))
  })
})

// ---------- The cutover (SPEC §12.11, from dealsFrom) ----------

describe('from the cutover', () => {
  const space = makeSpace(TZ, { memberIds: ['a', 'b', 'c'] })
  const NOV = weekIdsInMonth('2026-11')
  const DEC = weekIdsInMonth('2026-12')
  const reviews = (marks: Record<string, Mark>): [UID, UID, Record<string, Mark>][] =>
    ['a', 'b', 'c'].flatMap((r) => ['a', 'b', 'c'].filter((m) => m !== r).map((m): [UID, UID, Record<string, Mark>] => [r, m, { [`${m}1`]: marks[m] ?? 1 }]))
  const monthWeeks = (ids: WeekId[]) => ids.map((id, i) => week(TZ, id, i === 0 ? { members: ['a', 'b', 'c'], plans: { a: 1, b: 1, c: 1 }, submittedBy: ['a', 'b', 'c'], reviews: reviews({ c: 0 }) } : null))
  const line = (text: string) => ({ text, together: true, source: 'agreed' as const })
  const pair = (tiers: TermsInForce['tiers'] = []): TermsInForce => ({ reward: line('Dinner'), penalty: line('Coffee'), tiers })
  const verdictOf = (monthId: MonthId, nowMs: number, extra: Partial<SpaceInput> = {}) => {
    const ids = weekIdsInMonth(monthId)
    const r = planSpace({ space, weeks: byId(monthWeeks(ids)), monthly: byId([list(TZ, monthId, null)]), ...extra }, PROFILES, new Set(), nowMs)
    return r.send.filter((s) => s.kind === 'verdict').map((s) => `${s.uid} | ${s.title} | ${s.body}`)
  }
  const resultsDoc = (members: MonthResults['members'], terms: MonthResults['terms']): MonthResults => ({
    monthId: '2026-11', completeAt: local('2026-11-28T00:00'), members, terms, createdAt: local('2026-11-28T03:00'),
  })
  const dec1 = local('2026-12-01T10:17')

  it('November’s verdict says how it went and names only streak rewards', () => {
    expect(verdictOf('2026-11', dec1)).toEqual([
      'a | You made it: 100% | November in Film Club is done.',
      'b | You made it: 100% | November in Film Club is done.',
      'c | You fell short: 0% | November in Film Club is done.',
    ])
    const spa = [{ months: 2, reward: 'Spa day' }]
    const two = [{ months: 2, reward: 'Spa day' }, { months: 4, reward: 'Weekend away' }]
    const terms = { a: { b: pair(two), c: pair(two) }, b: { a: pair(spa), c: pair(spa) }, c: { a: pair(spa), b: pair(spa) } }
    const members = {
      a: { score: 100, passed: true, streak: 4, tierRuns: { '2': 2, '4': 4 } },
      b: { score: 100, passed: true, streak: 2, tierRuns: { '2': 2 } },
      c: { score: 0, passed: false, streak: 0, tierRuns: { '2': 0 } },
    }
    expect(verdictOf('2026-11', dec1, { results: { '2026-11': resultsDoc(members, terms) } })).toEqual([
      'a | 4 months in a row: 100% | November in Film Club is done. Collect your streak rewards: Spa day and Weekend away.',
      'b | 2 months in a row: 100% | November in Film Club is done. Collect your streak reward: Spa day.',
      'c | You fell short: 0% | November in Film Club is done.',
    ])
  })

  it('October’s verdict is the pre-deals planner’s', () => {
    const ids = weekIdsInMonth('2026-10')
    const input: SpaceInput = { space, weeks: byId(monthWeeks(ids)), monthly: byId([list(TZ, '2026-10', null)]) }
    const nov1 = local('2026-11-01T10:17')
    const want = oraclePlanSpace(input as OracleSpaceInput, PROFILES, new Set(), nov1)
    expect(planSpace(input, PROFILES, new Set(), nov1)).toEqual(want)
    expect(want.send.filter((s) => s.kind === 'verdict').map((s) => s.body)).toEqual([
      'October in Film Club is done. Collect: Dinner on me',
      'October in Film Club is done. Collect: Dinner on me',
      'October in Film Club is done. Pay up: Coffee for a week',
    ])
  })

  it('with dealsFrom December, November keeps its stakes and December has none', () => {
    expect(verdictOf('2026-11', dec1, { dealsFrom: '2026-12' })).toEqual([
      'a | You made it: 100% | November in Film Club is done. Collect: Dinner on me',
      'b | You made it: 100% | November in Film Club is done. Collect: Dinner on me',
      'c | You fell short: 0% | November in Film Club is done. Pay up: Coffee for a week',
    ])
    const jan1 = local('2027-01-01T10:17')
    expect(DEC).toHaveLength(4)
    expect(verdictOf('2026-12', jan1, { dealsFrom: '2026-12' })).toEqual([
      'a | You made it: 100% | December in Film Club is done.',
      'b | You made it: 100% | December in Film Club is done.',
      'c | You fell short: 0% | December in Film Club is done.',
    ])
    expect(NOV).toEqual(['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23'])
  })

  it('a house note from Saturday Oct 31 (October complete) is final for everyone', () => {
    const at = local('2026-10-31T10:00')
    const r = planSpace({ space: makeSpace(TZ, { stakesNote: { by: 'a', at } }), weeks: {} }, PROFILES, new Set(), local('2026-10-31T10:17'))
    expect(r.send).toEqual([])
    expect(r.skipped.sort()).toEqual(['a', 'b', 'c', 'd'].map((u) => `s1_house@${at}_house_${u}`))
  })

  it('a stakes change in November is about streak rewards: only friends whose agreed tiers differ', () => {
    const tiers = [{ months: 2, reward: 'Spa day' }]
    const terms: PairTerms = { rewardMode: 'group', penaltyMode: 'group', reward: 'Dinner on me', penalty: 'Coffee for a week', tiers }
    const updatedAt = local('2026-11-10T12:00')
    const four = makeSpace(TZ, { judges: ['e'], memberIds: ['a', 'b', 'c', 'd', 'e'] })
    // Kim agreed to these tiers; Lena agreed to none; Ana never agreed; Eve judges.
    const ben: MemberStakes = {
      uid: 'b', ...terms, per: {}, updatedAt,
      agreed: { c: { at: updatedAt + 1000, terms, past: [] }, a: { at: updatedAt - DAY, terms: { ...terms, tiers: [] }, past: [] } },
    }
    const at = local('2026-11-10T12:17')
    expect(stakesCandidates(four, { b: ben }, at).map((c) => [c.friend, c.tiers])).toEqual([['a', true], ['d', true]])
    const r = planSpace({ space: four, weeks: {}, memberStakes: { b: ben } }, { ...PROFILES, b: { name: 'Ben' } }, new Set(), at)
    expect(lines(r)).toEqual(['a', 'd'].map((u) => `${u} | New streak rewards from Ben | Ben has new streak rewards in Film Club. Take a look, and tap Agree if you’re in.`))
    expect(r.send[0]).toMatchObject({ key: `s1_b@${updatedAt}_stakes_a`, tag: 'stakes-s1' })
    // Only the lines changed (no streak rewards anywhere): nobody is asked.
    const lines2: MemberStakes = { uid: 'b', ...terms, tiers: [], reward: 'Pizza', per: {}, updatedAt, agreed: { a: { at: updatedAt - DAY, terms: { ...terms, tiers: [] }, past: [] } } }
    expect(stakesCandidates(four, { b: lines2 }, at)).toEqual([])
    // With dealsFrom December, November's changes are stakes as before.
    expect(stakesCandidates(four, { b: lines2 }, at, '2026-12').map((c) => [c.friend, c.tiers])).toEqual([['a', undefined], ['c', undefined], ['d', undefined]])
  })
})
