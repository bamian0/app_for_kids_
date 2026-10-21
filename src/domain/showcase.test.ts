import { describe, expect, it } from 'vitest'
import { ringMet } from '../ui/ringMath.ts'
import { computeMonth, type MemberMonthResult } from './scoring.ts'
import {
  DEFAULT_SHOW,
  SHOWCASE_MAX_ACHIEVED,
  SHOWCASE_MAX_GOALS,
  SHOWCASE_NAME_MAX,
  STATS_THRESHOLD,
  earningsBasis,
  lastMoneyMonth,
  playedWeeks,
  ringCaption,
  ringLine,
  ringOf,
  ringView,
  showOf,
  showcaseItems,
  showcasePatch,
  showcaseSummary,
  statsOf,
  statsView,
  switchShowcase,
} from './showcase.ts'
import { monthIdForWeek, weekBounds } from './time.ts'
import type {
  Earning,
  Goal,
  MoneyMove,
  MoneyState,
  Ring,
  RingView,
  ScoreEntry,
  ScoreMonths,
  Showcase,
  ShowcaseItems,
  ShowSwitches,
  Space,
  UID,
  WeekData,
  WeekId,
} from './types.ts'

const DAY = 86_400_000
const H = 3_600_000
const T = Date.parse('2026-10-20T10:00:00Z')
const BERLIN = 'Europe/Berlin'

// ---------- Fixtures ----------

let moveSeq = 0
function bought(note: string, at: number): MoneyMove {
  moveSeq += 1
  return { id: `m${String(moveSeq).padStart(3, '0')}`, kind: 'spend', amount: 10, note, at, goal: true }
}

function goal(id: string, name: string, cost: number, order: number): Goal {
  return { id, name, cost, order, createdAt: 0 }
}

function earning(weekId: WeekId, amount: number, earnedAt: number | null = T - 30 * DAY): Earning {
  return { id: `s1_${weekId}_t${amount}`, spaceId: 's1', weekId, taskId: `t${amount}`, title: 'Gig', amount, earnedAt, updatedAt: 0 }
}

const STATE: MoneyState = { currency: 'USD', baseline: 0, baselineAt: 1, updatedAt: 1 }

function money(patch: Partial<{ moves: MoneyMove[]; goals: Goal[]; earnings: Earning[]; state: MoneyState | null; currency: string }> = {}) {
  return { moves: [], goals: [], earnings: [], state: STATE, currency: 'USD', ...patch }
}

function stored(show: Partial<ShowSwitches>, items: Partial<ShowcaseItems> = {}): Showcase {
  return { uid: 'ana', show: { ...DEFAULT_SHOW, ...show }, ...items, updatedAt: T - DAY }
}

const ITEMS: ShowcaseItems = {
  achieved: [{ name: 'Sony FX3', at: T - 2 * DAY }],
  goals: [{ name: 'Bike', pct: 64 }],
  earnings: { monthId: '2026-09', amount: 420.5, currency: 'USD' },
}

const entry = (score: number | null, final = true, weeks: WeekId[] = []): ScoreEntry => ({ score, weeks, final })

// ---------- Switches ----------

describe('constants and showOf', () => {
  it('match §11.7: stats on, money off', () => {
    expect(DEFAULT_SHOW).toEqual({ stats: true, achieved: false, goals: false, earnings: false })
    expect([SHOWCASE_MAX_ACHIEVED, SHOWCASE_MAX_GOALS, SHOWCASE_NAME_MAX, STATS_THRESHOLD]).toEqual([12, 8, 60, 90])
    expect(Object.isFrozen(DEFAULT_SHOW)).toBe(true)
  })
  it('no doc reads as DEFAULT_SHOW; a doc as its switches (a copy)', () => {
    expect(showOf(null)).toEqual(DEFAULT_SHOW)
    const s = stored({ stats: false, earnings: true }, { earnings: ITEMS.earnings })
    const show = showOf(s)
    expect(show).toEqual({ stats: false, achieved: false, goals: false, earnings: true })
    show.goals = true
    expect(s.show.goals).toBe(false)
  })
})

describe('showcaseSummary', () => {
  it('nothing, one by its short name, or a count', () => {
    const none = { stats: false, achieved: false, goals: false, earnings: false }
    expect(showcaseSummary(none)).toBe('Nothing shown')
    expect(showcaseSummary(DEFAULT_SHOW)).toBe('Stats')
    expect(showcaseSummary({ ...none, achieved: true })).toBe('Achieved goals')
    expect(showcaseSummary({ ...none, goals: true })).toBe('Current goals')
    expect(showcaseSummary({ ...none, earnings: true })).toBe('Earnings')
    expect(showcaseSummary({ ...DEFAULT_SHOW, earnings: true })).toBe('2 items')
    expect(showcaseSummary({ stats: true, achieved: true, goals: true, earnings: true })).toBe('4 items')
  })
})

// ---------- Items ----------

describe('showcaseItems: achieved', () => {
  it('the 12 newest goals marked Bought, newest first; other moves and blank notes left out', () => {
    const moves: MoneyMove[] = []
    for (let i = 0; i < 14; i++) moves.push(bought(`Goal ${i}`, T - (14 - i) * DAY))
    moves.push(bought('   ', T - H))
    moves.push(bought('​\n', T - 2 * H))
    moves.push({ id: 'plain', kind: 'spend', amount: 5, note: 'Rent', at: T })
    moves.push({ id: 'add', kind: 'add', amount: 5, note: 'Gift', at: T })
    const { achieved } = showcaseItems(money({ moves }), T, BERLIN)
    expect(achieved).toHaveLength(12)
    expect(achieved[0]).toEqual({ name: 'Goal 13', at: T - DAY })
    expect(achieved[11]).toEqual({ name: 'Goal 2', at: T - 12 * DAY })
    expect(achieved.map((a) => a.at)).toEqual([...achieved.map((a) => a.at)].sort((a, b) => b - a))
  })
  it('names on one line, trimmed, cut to 60 without splitting an emoji', () => {
    const long = 'x'.repeat(59) + '😀' + 'tail'
    const moves = [bought('  Trip\nto Lisbon  ', T - DAY), bought('y'.repeat(80), T - 2 * DAY), bought(long, T - 3 * DAY), bought('a\u0007b', T - 4 * DAY)]
    const names = showcaseItems(money({ moves }), T, BERLIN).achieved.map((a) => a.name)
    expect(names[0]).toBe('Trip to Lisbon')
    expect(names[1]).toBe('y'.repeat(60))
    expect(names[2]).toBe('x'.repeat(59))
    expect(names[3]).toBe('ab')
    for (const n of names) expect(n.length).toBeLessThanOrEqual(SHOWCASE_NAME_MAX)
  })
  it('a move without a usable time is left out', () => {
    const moves = [bought('Pending', 0), bought('Odd', Number.NaN), bought('Ok', T)]
    expect(showcaseItems(money({ moves }), T, BERLIN).achieved.map((a) => a.name)).toEqual(['Ok'])
  })
})

describe('showcaseItems: goals', () => {
  it('saving order, at most 8, names and whole percent floored; 100 only when funded', () => {
    const goals = [
      goal('g3', 'Camera', 1000, 3),
      goal('g1', 'Bike', 300, 1),
      goal('g2', 'Lens', 1, 2),
      ...Array.from({ length: 8 }, (_, i) => goal(`z${i}`, `Later ${i}`, 50, 10 + i)),
    ]
    // Balance 300.29: Bike funded, Lens 0.29 of 1.00, Camera nothing.
    const state: MoneyState = { currency: 'USD', baseline: 300.29, baselineAt: T, updatedAt: T }
    const shown = showcaseItems(money({ goals, state }), T, BERLIN).goals
    expect(shown).toHaveLength(SHOWCASE_MAX_GOALS)
    expect(shown.slice(0, 3)).toEqual([
      { name: 'Bike', pct: 100 },
      { name: 'Lens', pct: 29 },
      { name: 'Camera', pct: 0 },
    ])
    expect(shown[7]).toEqual({ name: 'Later 4', pct: 0 })
  })
  it('floors: 2 of 3 is 66, and 99.99% stays 99 until funded', () => {
    const third = showcaseItems(money({ goals: [goal('a', 'A', 3, 1)], state: { ...STATE, baseline: 2, baselineAt: T } }), T, BERLIN).goals
    expect(third).toEqual([{ name: 'A', pct: 66 }])
    const almost = showcaseItems(money({ goals: [goal('a', 'A', 100, 1)], state: { ...STATE, baseline: 99.99, baselineAt: T } }), T, BERLIN).goals
    expect(almost).toEqual([{ name: 'A', pct: 99 }])
    const funded = showcaseItems(money({ goals: [goal('a', 'A', 100, 1)], state: { ...STATE, baseline: 100, baselineAt: T } }), T, BERLIN).goals
    expect(funded).toEqual([{ name: 'A', pct: 100 }])
  })
  it('a negative balance funds nothing; never an amount in the item', () => {
    const shown = showcaseItems(money({ goals: [goal('a', 'Bike', 300, 1)], state: { ...STATE, baseline: -50, baselineAt: T } }), T, BERLIN).goals
    expect(shown).toEqual([{ name: 'Bike', pct: 0 }])
    expect(Object.keys(shown[0]).sort()).toEqual(['name', 'pct'])
  })
})

describe('showcaseItems: last month’s earnings', () => {
  // Monday 03:00 UTC: Berlin is in the week of Nov 2 (money month November), Los Angeles still in the week of Oct 26
  // (its Friday is Oct 30: money month October).
  const now = Date.parse('2026-11-02T03:00:00Z')
  const earnings = [
    earning('2026-09-07', 100), // September
    earning('2026-09-21', 20.5), // September
    earning('2026-09-28', 7), // Friday Oct 2: October
    earning('2026-10-19', 300), // October
    earning('2026-10-26', 40), // Friday Oct 30: October
    earning('2026-10-12', 999, null), // not done: never earned
  ]
  it('the month before the device’s money month, by the device zone', () => {
    expect(lastMoneyMonth(now, BERLIN)).toBe('2026-10')
    expect(lastMoneyMonth(now, 'America/Los_Angeles')).toBe('2026-09')
    expect(showcaseItems(money({ earnings }), now, BERLIN).earnings).toEqual({ monthId: '2026-10', amount: 347, currency: 'USD' })
    expect(showcaseItems(money({ earnings }), now, 'America/Los_Angeles').earnings).toEqual({ monthId: '2026-09', amount: 120.5, currency: 'USD' })
  })
  it('0 when nothing was earned, in the user’s currency', () => {
    expect(showcaseItems(money({ currency: 'EUR' }), now, BERLIN).earnings).toEqual({ monthId: '2026-10', amount: 0, currency: 'EUR' })
  })
})

// ---------- The editor's write and the background sync ----------

describe('switchShowcase', () => {
  it('no stored doc: DEFAULT_SHOW with the one switch changed, and its fresh item', () => {
    expect(switchShowcase(null, 'earnings', true, ITEMS)).toEqual({
      show: { stats: true, achieved: false, goals: false, earnings: true },
      earnings: ITEMS.earnings,
    })
    expect(switchShowcase(null, 'stats', false, ITEMS)).toEqual({ show: { stats: false, achieved: false, goals: false, earnings: false } })
  })
  it('turning one on adds its fresh item, even over an old stored copy', () => {
    const s = stored({ achieved: true }, { achieved: [{ name: 'Old', at: 1 }] })
    const doc = switchShowcase(s, 'achieved', true, ITEMS)
    expect(doc.achieved).toEqual(ITEMS.achieved)
  })
  it('turning one off removes its item; the other items stay as stored', () => {
    const old = { achieved: [{ name: 'Old', at: 1 }], goals: [{ name: 'Old goal', pct: 10 }], earnings: { monthId: '2026-08', amount: 3, currency: 'USD' } }
    const s = stored({ achieved: true, goals: true, earnings: true }, old)
    const doc = switchShowcase(s, 'earnings', false, ITEMS)
    expect(doc).toEqual({ show: { stats: true, achieved: true, goals: true, earnings: false }, achieved: old.achieved, goals: old.goals })
    expect('earnings' in doc).toBe(false)
  })
  it('a switched-on item the stored doc lacks comes from the items', () => {
    const s = stored({ goals: true })
    expect(switchShowcase(s, 'stats', false, ITEMS)).toEqual({ show: { stats: false, achieved: false, goals: true, earnings: false }, goals: ITEMS.goals })
  })
  it('every switched-on item is present, and only those', () => {
    const keys = ['stats', 'achieved', 'goals', 'earnings'] as const
    for (let mask = 0; mask < 16; mask++) {
      const show = Object.fromEntries(keys.map((k, i) => [k, (mask & (1 << i)) !== 0])) as unknown as ShowSwitches
      for (const key of keys) {
        for (const on of [true, false]) {
          const doc = switchShowcase(stored(show), key, on, ITEMS)
          expect(doc.show[key]).toBe(on)
          for (const k of ['achieved', 'goals', 'earnings'] as const) expect(k in doc).toBe(doc.show[k])
        }
      }
    }
  })
  it('copies, never shares the input’s objects', () => {
    const doc = switchShowcase(null, 'achieved', true, ITEMS)
    doc.achieved![0].name = 'Changed'
    expect(ITEMS.achieved[0].name).toBe('Sony FX3')
  })
})

describe('showcasePatch', () => {
  it('null when every switched-on item is current', () => {
    const s = stored({ achieved: true, goals: true, earnings: true }, ITEMS)
    expect(showcasePatch(s, structuredClone(ITEMS))).toBeNull()
    expect(showcasePatch(stored({}), ITEMS)).toBeNull()
  })
  it('only the changed items switched on in the stored doc; never a switch', () => {
    const s = stored({ achieved: true, earnings: true }, { achieved: ITEMS.achieved, earnings: ITEMS.earnings })
    const fresh: ShowcaseItems = { ...ITEMS, goals: [{ name: 'New', pct: 1 }], earnings: { ...ITEMS.earnings, amount: 421 } }
    const patch = showcasePatch(s, fresh)
    expect(patch).toEqual({ earnings: { monthId: '2026-09', amount: 421, currency: 'USD' } })
    expect(patch && 'show' in patch).toBe(false)
    expect(patch && 'goals' in patch).toBe(false)
  })
  it('a switched-on item missing from the stored doc is written; each kind of change is seen', () => {
    expect(showcasePatch(stored({ goals: true }), ITEMS)).toEqual({ goals: ITEMS.goals })
    const s = stored({ achieved: true, goals: true, earnings: true }, ITEMS)
    expect(showcasePatch(s, { ...ITEMS, achieved: [{ name: 'Sony FX3', at: T - 2 * DAY + 1 }] })).toEqual({ achieved: [{ name: 'Sony FX3', at: T - 2 * DAY + 1 }] })
    expect(showcasePatch(s, { ...ITEMS, achieved: [] })).toEqual({ achieved: [] })
    expect(showcasePatch(s, { ...ITEMS, goals: [{ name: 'Bike', pct: 65 }] })).toEqual({ goals: [{ name: 'Bike', pct: 65 }] })
    expect(showcasePatch(s, { ...ITEMS, earnings: { ...ITEMS.earnings, monthId: '2026-10' } })).toEqual({ earnings: { ...ITEMS.earnings, monthId: '2026-10' } })
    expect(showcasePatch(s, { ...ITEMS, earnings: { ...ITEMS.earnings, currency: 'EUR' } })).toEqual({ earnings: { ...ITEMS.earnings, currency: 'EUR' } })
  })
})

describe('earningsBasis: every device of one user agrees, so the sync settles', () => {
  // Monday Nov 2, 00:30 UTC: Berlin (01:30) is in the week of Friday Nov 6, money month November; New York (Sunday
  // 19:30) still in the week of Friday Oct 30, money month October. For about 6 hours they disagree on "last month".
  const now = Date.parse('2026-11-02T00:30:00Z')
  const NY = 'America/New_York'
  const earnings = [earning('2026-09-21', 20), earning('2026-10-19', 300), earning('2026-10-26', 40)]
  const shown = (monthId: string, currency = 'USD', amount = 0) => stored({ earnings: true }, { earnings: { monthId, amount, currency } })

  it('the month: this device’s last month, or the stored one when it is the month after (only forward)', () => {
    expect(lastMoneyMonth(now, BERLIN)).toBe('2026-10')
    expect(lastMoneyMonth(now, NY)).toBe('2026-09')
    expect(earningsBasis(null, STATE, now, NY, 'USD').monthId).toBe('2026-09')
    expect(earningsBasis(shown('2026-10'), STATE, now, NY, 'USD').monthId).toBe('2026-10')
    expect(earningsBasis(shown('2026-09'), STATE, now, BERLIN, 'USD').monthId).toBe('2026-10')
    expect(earningsBasis(shown('2026-10'), STATE, now, BERLIN, 'USD').monthId).toBe('2026-10')
    // A month further ahead came from a wrong clock: replaced. So is an older one.
    expect(earningsBasis(shown('2026-11'), STATE, now, NY, 'USD').monthId).toBe('2026-09')
    expect(earningsBasis(shown('2027-03'), STATE, now, BERLIN, 'USD').monthId).toBe('2026-10')
    expect(earningsBasis(shown('2026-06'), STATE, now, BERLIN, 'USD').monthId).toBe('2026-10')
    // Across a year's turn too.
    const feb = Date.parse('2027-02-01T00:30:00Z')
    expect([lastMoneyMonth(feb, NY), lastMoneyMonth(feb, BERLIN)]).toEqual(['2026-12', '2027-01'])
    expect(earningsBasis(shown('2027-01'), STATE, feb, NY, 'USD').monthId).toBe('2027-01')
  })

  it('the currency: the money state’s; without one the stored copy’s, never a locale’s guess; else the fallback', () => {
    expect(earningsBasis(shown('2026-10', 'GBP'), { ...STATE, currency: 'EUR' }, now, BERLIN, 'USD').currency).toBe('EUR')
    expect(earningsBasis(shown('2026-10', 'GBP'), null, now, BERLIN, 'USD').currency).toBe('GBP')
    expect(earningsBasis(stored({ earnings: true }), null, now, BERLIN, 'USD').currency).toBe('USD')
    expect(earningsBasis(null, null, now, BERLIN, 'GBP').currency).toBe('GBP')
  })

  it('the lagging device copies the stored month’s amount, so both write the same copy', () => {
    const basis = earningsBasis(shown('2026-10', 'USD', 0), STATE, now, NY, 'USD')
    expect(showcaseItems(money({ earnings, ...basis }), now, NY).earnings).toEqual({ monthId: '2026-10', amount: 340, currency: 'USD' })
    expect(showcaseItems(money({ earnings }), now, BERLIN).earnings).toEqual({ monthId: '2026-10', amount: 340, currency: 'USD' })
  })

  it('two devices in two zones, with two locales and no money state, stop writing after at most one round', () => {
    const devices = [
      { tz: BERLIN, fallback: 'USD' },
      { tz: NY, fallback: 'GBP' },
    ]
    for (const start of [0, 1]) {
      // One device switched earnings on with its own copy; then each device's sync takes turns on the stored doc.
      const first = devices[start]
      let doc = stored({ earnings: true }, { earnings: showcaseItems(money({ earnings, state: null, currency: first.fallback }), now, first.tz).earnings })
      let writes = 0
      for (let turn = 0; turn < 8; turn++) {
        const d = devices[(start + 1 + turn) % 2]
        const basis = earningsBasis(doc, null, now, d.tz, d.fallback)
        const patch = showcasePatch(doc, showcaseItems(money({ earnings, state: null, ...basis }), now, d.tz))
        if (patch) {
          writes += 1
          doc = { ...doc, ...patch }
        }
      }
      expect(writes).toBeLessThanOrEqual(1)
      expect(doc.earnings).toEqual({ monthId: '2026-10', amount: 340, currency: first.fallback })
    }
  })
})

// ---------- Rings ----------

describe('ringOf', () => {
  it('no months: the empty ring', () => {
    expect(ringOf({})).toEqual({ monthId: null, score: null, final: false, spaces: 0 })
    expect(ringOf({ '2026-10': {} })).toEqual({ monthId: null, score: null, final: false, spaces: 0 })
  })
  it('the newest month wins: the mean of its non-null space scores', () => {
    const months: ScoreMonths = {
      '2026-10': { s1: entry(100), s2: entry(80) },
      '2026-11': { s1: entry(92, false), s2: entry(88, false), judged: entry(null, false) },
    }
    expect(ringOf(months)).toEqual({ monthId: '2026-11', score: 90, final: false, spaces: 2 })
  })
  it('final only when every entry of the month is final', () => {
    expect(ringOf({ '2026-10': { s1: entry(70), s2: entry(80) } })).toEqual({ monthId: '2026-10', score: 75, final: true, spaces: 2 })
    expect(ringOf({ '2026-10': { s1: entry(70), s2: entry(80, false) } }).final).toBe(false)
    expect(ringOf({ '2026-10': { s1: entry(70), judged: entry(null, false) } }).final).toBe(false)
  })
  it('a month someone only judged has no score', () => {
    expect(ringOf({ '2026-10': { s1: entry(95) }, '2026-11': { s1: entry(null, false) } })).toEqual({ monthId: '2026-11', score: null, final: false, spaces: 0 })
  })
  it('a mean that is 90 is exactly 90', () => {
    const r = ringOf({ '2026-10': { a: entry(95 + 1 / 3), b: entry(84 + 2 / 3), c: entry(90) } })
    expect(r.score).toBe(90)
    expect(ringMet(r.score, 90)).toBe(true)
  })
  it('ignores malformed month ids and entries that aren’t entries', () => {
    expect(ringOf({ '2026-13': { s1: entry(50) }, junk: { s1: entry(50) }, '2026-10': { s1: entry(91) } }).monthId).toBe('2026-10')
    const odd = { '2026-10': { s1: entry(91) }, '2026-11': { s1: null }, '2026-12': null } as unknown as ScoreMonths
    expect(ringOf(odd)).toEqual({ monthId: '2026-10', score: 91, final: true, spaces: 1 })
    expect(statsOf(odd)).toMatchObject({ monthsCleared: 1, finishedMonths: 1, since: '2026-10' })
  })
})

describe('ringView, ringCaption and ringLine', () => {
  const ring = (monthId: string | null, score: number | null, final = false, spaces = 1): Ring => ({ uid: 'ana', monthId, score, final, spaces, updatedAt: T })
  const oct = Date.parse('2026-10-20T10:00:00Z')

  it('the ring’s numbers this month', () => {
    expect(ringView(ring('2026-10', 92.4, false, 2), oct, BERLIN)).toEqual({ value: 92.4, monthId: '2026-10', final: false, spaces: 2 })
  })
  it('at a month’s start: last month’s final score until the new month’s first week is scored', () => {
    const nov = Date.parse('2026-11-03T10:00:00Z')
    const v = ringView(ring('2026-10', 88, true), nov, BERLIN)
    expect(v).toEqual({ value: 88, monthId: '2026-10', final: true, spaces: 1 })
    expect(ringLine(v)).toBe('88% · October')
  })
  it('a ring older than the viewer’s previous month is empty', () => {
    const nov = Date.parse('2026-11-03T10:00:00Z')
    const empty = { value: null, monthId: null, final: false, spaces: 0 }
    expect(ringView(ring('2026-09', 95, true), nov, BERLIN)).toEqual(empty)
    expect(ringView(null, nov, BERLIN)).toEqual(empty)
    expect(ringView(ring(null, null), nov, BERLIN)).toEqual(empty)
    expect(ringView(ring('2026-13', 95), nov, BERLIN)).toEqual(empty)
  })
  it('the viewer’s zone decides the month: Monday morning in Berlin is still October in Los Angeles', () => {
    const now = Date.parse('2026-11-02T03:00:00Z')
    expect(ringView(ring('2026-09', 91, true), now, 'America/Los_Angeles').value).toBe(91)
    expect(ringView(ring('2026-09', 91, true), now, BERLIN).value).toBeNull()
  })
  it('no score: the track only', () => {
    expect(ringView(ring('2026-10', null, false, 3), oct, BERLIN)).toEqual({ value: null, monthId: '2026-10', final: false, spaces: 0 })
    expect(ringView(ring('2026-10', Number.NaN), oct, BERLIN).value).toBeNull()
  })
  it('≥ 90 turns iridescent through ringMet on the value', () => {
    expect(ringMet(ringView(ring('2026-10', 90), oct, BERLIN).value, 90)).toBe(true)
    expect(ringMet(ringView(ring('2026-10', 89.9), oct, BERLIN).value, 90)).toBe(false)
    expect(ringMet(ringView(ring('2026-10', null), oct, BERLIN).value, 90)).toBe(false)
  })
  it('captions and lines (§11.7)', () => {
    const view = (value: number | null, monthId: string | null, final: boolean): RingView => ({ value, monthId, final, spaces: 1 })
    expect(ringCaption(view(null, null, false))).toBe('No score yet this month')
    expect(ringCaption(view(null, '2026-10', true))).toBe('No score yet this month')
    expect(ringCaption(view(92, '2026-10', false))).toBe('October so far')
    expect(ringCaption(view(88, '2026-09', true))).toBe('September')
    expect(ringLine(view(92, '2026-10', false))).toBe('92% · October so far')
    expect(ringLine(view(88, '2026-09', true))).toBe('88% · September')
    expect(ringLine(view(null, '2026-10', false))).toBe('No score yet this month')
    // Never rounded up past the bar; float noise under a whole number still reads as it.
    expect(ringLine(view(89.99, '2026-10', false))).toBe('89% · October so far')
    expect(ringLine(view(89.9999999999, '2026-10', false))).toBe('90% · October so far')
    expect(ringLine(view(100, '2026-12', true))).toBe('100% · December')
  })
})

// ---------- Stats ----------

describe('statsOf', () => {
  it('nothing yet', () => {
    expect(statsOf({})).toEqual({ monthsCleared: 0, currentStreak: 0, bestStreak: 0, weeksPlayed: 0, finishedMonths: 0, since: null })
  })
  it('a month counts only when every entry is final; this month’s weeks count already', () => {
    const s = statsOf({ '2026-10': { s1: entry(95, true, ['2026-10-05']), s2: entry(92, false, ['2026-10-12']) } })
    expect(s).toEqual({ monthsCleared: 0, currentStreak: 0, bestStreak: 0, weeksPlayed: 2, finishedMonths: 0, since: '2026-10' })
  })
  it('cleared only when every non-null space score is at least 90: 100 and 80 is not; exactly 90 is', () => {
    expect(statsOf({ '2026-10': { s1: entry(100), s2: entry(80) } }).monthsCleared).toBe(0)
    expect(statsOf({ '2026-10': { s1: entry(90), s2: entry(100) } }).monthsCleared).toBe(1)
    expect(statsOf({ '2026-10': { s1: entry(90 - 1e-12) } }).monthsCleared).toBe(1)
    expect(statsOf({ '2026-10': { s1: entry(89.99) } }).monthsCleared).toBe(0)
    // A judge-only space adds nothing.
    expect(statsOf({ '2026-10': { s1: entry(93), judged: entry(null) } }).monthsCleared).toBe(1)
  })
  it('streaks: +1 per cleared month, carry on months without a score and on gaps, reset on a miss', () => {
    const months: ScoreMonths = {
      '2026-10': { s1: entry(95) }, // 1
      '2026-11': { s1: entry(91) }, // 2
      '2026-12': { s1: entry(null) }, // carry (judged or sat out): 2
      // 2027-01 missing from the doc: carry
      '2027-02': { s1: entry(90) }, // 3
      '2027-03': { s1: entry(70) }, // reset: 0
      '2027-04': { s1: entry(99) }, // 1
      '2027-05': { s1: entry(99, false) }, // not counted yet
    }
    expect(statsOf(months)).toEqual({ monthsCleared: 4, currentStreak: 1, bestStreak: 3, weeksPlayed: 0, finishedMonths: 5, since: '2026-10' })
  })
  it('a miss in one space resets, even with 100% in another', () => {
    const s = statsOf({ '2026-10': { a: entry(95) }, '2026-11': { a: entry(100), b: entry(85) } })
    expect(s.currentStreak).toBe(0)
    expect(s.bestStreak).toBe(1)
    expect(s.monthsCleared).toBe(1)
    expect(s.finishedMonths).toBe(2)
  })
  it('a month where every space was paused or judged carries and isn’t a finished month', () => {
    const s = statsOf({ '2026-10': { a: entry(92) }, '2026-11': { a: entry(null), b: entry(null) }, '2026-12': { a: entry(96) } })
    expect(s).toMatchObject({ monthsCleared: 2, currentStreak: 2, bestStreak: 2, finishedMonths: 2 })
  })
  it('weeksPlayed: distinct week ids across every space and month', () => {
    const s = statsOf({
      '2026-10': { a: entry(95, true, ['2026-10-05', '2026-10-12']), b: entry(90, true, ['2026-10-12', '2026-10-19']) },
      '2026-11': { a: entry(50, false, ['2026-11-02']) },
    })
    expect(s.weeksPlayed).toBe(4)
  })
  it('since: the earliest month, never before FIRST_RESULTS_MONTH', () => {
    expect(statsOf({ '2026-12': { a: entry(95) }, '2026-11': { a: entry(95) } }).since).toBe('2026-11')
    expect(statsOf({ '2026-08': { a: entry(95) }, '2026-11': { a: entry(95) } }).since).toBe('2026-10')
  })
  it('ignores malformed month ids and weeks', () => {
    const months = { '2026-13': { a: entry(95) }, '2026-10': { a: { score: 95, weeks: ['2026-10-05', 7, null], final: true } } } as unknown as ScoreMonths
    expect(statsOf(months)).toMatchObject({ monthsCleared: 1, weeksPlayed: 1, since: '2026-10' })
  })
})

describe('statsView', () => {
  it('zeros and since null without a stats doc; else exactly the facts', () => {
    expect(statsView(null)).toEqual({ monthsCleared: 0, currentStreak: 0, bestStreak: 0, weeksPlayed: 0, finishedMonths: 0, since: null })
    const stats = { uid: 'ana', monthsCleared: 3, currentStreak: 2, bestStreak: 3, weeksPlayed: 14, finishedMonths: 4, since: '2026-10', updatedAt: T }
    expect(statsView(stats)).toEqual({ monthsCleared: 3, currentStreak: 2, bestStreak: 3, weeksPlayed: 14, finishedMonths: 4, since: '2026-10' })
  })
})

// ---------- playedWeeks ----------

function result(weeks: MemberMonthResult['weeks']): MemberMonthResult {
  return { uid: 'ana', monthId: '2026-10', former: false, others: [], weeks, average: null, missedReviews: 0, penaltyPoints: 0, finalScore: null, complete: false, passed: null }
}

describe('playedWeeks', () => {
  it('closed and scored, not paused or skipped', () => {
    const r = result([
      { weekId: '2026-09-28', score: 80, closed: true },
      { weekId: '2026-10-05', score: 0, closed: true },
      { weekId: '2026-10-12', score: null, closed: true, paused: true },
      { weekId: '2026-10-19', score: null, closed: true, skipped: true },
      { weekId: '2026-10-26', score: 100, closed: false },
    ])
    expect(playedWeeks(r)).toEqual(['2026-09-28', '2026-10-05'])
  })

  it('from computeMonth, as the job uses it: judged and paused weeks aren’t played', () => {
    const TZ = 'Europe/Paris'
    const space: Space = {
      id: 's1',
      name: 'Studio',
      reward: 'Dinner',
      penalty: 'Coffee',
      ownerId: 'ana',
      memberIds: ['ana', 'ben'],
      joinedAt: { ana: 0, ben: 0 },
      timezone: TZ,
      inviteCode: 'ABCD2345',
      threshold: 90,
      latePenalty: 5,
      createdAt: 0,
      paused: { '2026-10': '2026-10-12' },
    }
    const week = (weekId: WeekId, judges: UID[] = []): WeekData => ({
      spaceId: 's1',
      weekId,
      week: { id: weekId, spaceId: 's1', ...weekBounds(weekId, TZ), members: ['ana', 'ben'], submittedBy: ['ana', 'ben'], judges },
      plans: {
        ana: { uid: 'ana', tasks: [{ id: 'a1', title: 'Run' }], updatedAt: 0 },
        ben: { uid: 'ben', tasks: [{ id: 'b1', title: 'Read' }], updatedAt: 0 },
      },
      progress: {},
      reviews: [
        { id: 'ana_ben', reviewerId: 'ana', revieweeId: 'ben', marks: { b1: 1 }, submittedAt: 0 },
        { id: 'ben_ana', reviewerId: 'ben', revieweeId: 'ana', marks: { a1: 1 }, submittedAt: 0 },
      ],
    })
    const weeks = [week('2026-09-28'), week('2026-10-05', ['ben']), week('2026-10-12'), week('2026-10-19'), week('2026-10-26')]
    const now = weekBounds('2026-10-19', TZ).deadlineAt + H
    const month = computeMonth(space, '2026-10', weeks, now)
    expect(playedWeeks(month.ana)).toEqual(['2026-09-28', '2026-10-05', '2026-10-19'])
    expect(playedWeeks(month.ben)).toEqual(['2026-09-28', '2026-10-19'])
  })
})

// ---------- From computeMonth to the ring and stats, as the job publishes them ----------

describe('ringOf and statsOf from computeMonth (the job’s chain)', () => {
  // Ana plays in s1 (Paris; one October week paused) and only judges in s2 (New York). The job stores, per space and
  // month, { score: finalScore, weeks: playedWeeks, final: complete } and publishes ringOf / statsOf of the months.
  const PARIS = 'Europe/Paris'
  const NY = 'America/New_York'
  const space = (id: string, tz: string, memberIds: UID[], paused?: Record<string, WeekId>): Space => ({
    id,
    name: id,
    reward: 'Dinner',
    penalty: 'Coffee',
    ownerId: memberIds[0],
    memberIds,
    joinedAt: Object.fromEntries(memberIds.map((u) => [u, 0])),
    timezone: tz,
    inviteCode: 'ABCD2345',
    threshold: 90,
    latePenalty: 5,
    createdAt: 0,
    ...(paused ? { paused } : {}),
  })
  const s1 = space('s1', PARIS, ['ana', 'ben'], { '2026-10': '2026-10-12' })
  const s2 = space('s2', NY, ['ana', 'cleo'])
  /** Everyone with a list marks every other list Done, except `half`: the reviewer → reviewee pairs marked Half. */
  const week = (sp: Space, weekId: WeekId, players: UID[], judges: UID[] = [], half: [UID, UID][] = []): WeekData => ({
    spaceId: sp.id,
    weekId,
    week: { id: weekId, spaceId: sp.id, ...weekBounds(weekId, sp.timezone), members: sp.memberIds, submittedBy: players, judges },
    plans: Object.fromEntries(players.map((u) => [u, { uid: u, tasks: [{ id: `${u}1`, title: 'Task' }], updatedAt: 0 }])),
    progress: {},
    reviews: sp.memberIds.flatMap((r) =>
      players
        .filter((p) => p !== r)
        .map((p) => ({ id: `${r}_${p}`, reviewerId: r, revieweeId: p, marks: { [`${p}1`]: half.some(([a, b]) => a === r && b === p) ? 0.5 : 1 }, submittedAt: 0 })),
    ),
  })
  const OCT = ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']
  const s1Weeks = [...OCT.map((w) => week(s1, w, ['ana', 'ben'])), week(s1, '2026-11-02', ['ana', 'ben'], [], [['ben', 'ana']])]
  const s2Weeks = [...OCT, '2026-11-02'].map((w) => week(s2, w, ['cleo'], ['ana']))

  function scoresAt(nowMs: number): ScoreMonths {
    const months: ScoreMonths = {}
    for (const monthId of ['2026-10', '2026-11']) {
      for (const [sp, weeks] of [[s1, s1Weeks], [s2, s2Weeks]] as const) {
        // The job writes a space's month once one of its weeks has closed (its deadline passed).
        if (!weeks.some((w) => monthIdForWeek(w.weekId) === monthId && w.week !== null && nowMs >= w.week.deadlineAt)) continue
        const ana = computeMonth(sp, monthId, weeks, nowMs).ana
        months[monthId] = { ...months[monthId], [sp.id]: { score: ana.finalScore, weeks: playedWeeks(ana), final: ana.complete } }
      }
    }
    return months
  }

  it('early November, before its first week is scored: last month’s final score', () => {
    const now = Date.parse('2026-11-03T12:00:00Z')
    const months = scoresAt(now)
    expect(months['2026-10']).toEqual({
      s1: { score: 100, weeks: ['2026-09-28', '2026-10-05', '2026-10-19', '2026-10-26'], final: true },
      s2: { score: null, weeks: [], final: true },
    })
    expect(months['2026-11']).toBeUndefined()
    const ring = ringOf(months)
    // The judge-only space adds nothing: one space averaged.
    expect(ring).toEqual({ monthId: '2026-10', score: 100, final: true, spaces: 1 })
    expect(ringLine(ringView({ uid: 'ana', ...ring, updatedAt: now }, now, BERLIN))).toBe('100% · October')
    // The paused week isn't played; October is cleared.
    expect(statsOf(months)).toEqual({ monthsCleared: 1, currentStreak: 1, bestStreak: 1, weeksPlayed: 4, finishedMonths: 1, since: '2026-10' })
  })

  it('once November’s first week is scored: November so far; its weeks count, the month doesn’t yet', () => {
    const now = weekBounds('2026-11-02', NY).deadlineAt + H
    const months = scoresAt(now)
    expect(months['2026-11']).toEqual({
      s1: { score: 50, weeks: ['2026-11-02'], final: false },
      s2: { score: null, weeks: [], final: false },
    })
    const ring = ringOf(months)
    expect(ring).toEqual({ monthId: '2026-11', score: 50, final: false, spaces: 1 })
    expect(ringLine(ringView({ uid: 'ana', ...ring, updatedAt: now }, now, BERLIN))).toBe('50% · November so far')
    expect(statsOf(months)).toEqual({ monthsCleared: 1, currentStreak: 1, bestStreak: 1, weeksPlayed: 5, finishedMonths: 1, since: '2026-10' })
  })
})
