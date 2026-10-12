import { describe, expect, it } from 'vitest'
import {
  CURRENCIES,
  MAX_AMOUNT,
  balanceOf,
  currencySymbol,
  defaultCurrency,
  earnedByWeek,
  earnedInMonth,
  earningId,
  editableAmount,
  etaWeeks,
  formatMoney,
  fundGoals,
  inBaseline,
  moneyActivity,
  nextGoalOrder,
  parseAmount,
  pendingIn,
  roundMoney,
  topEarnings,
  totalEarned,
  weeklyPace,
} from './money.ts'
import type { Earning, Goal, MoneyMove, MoneyState } from './types.ts'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 14, 12) // Wednesday 14 October 2026

function earning(taskId: string, amount: number, earnedAt: number | null, weekId = '2026-10-12', spaceId = 's1'): Earning {
  return { id: earningId(spaceId, weekId, taskId), spaceId, weekId, taskId, title: taskId, amount, earnedAt, updatedAt: 0 }
}

function move(id: string, kind: 'add' | 'spend', amount: number, at: number, note = '', goal = false): MoneyMove {
  return goal ? { id, kind, amount, note, at, goal } : { id, kind, amount, note, at }
}

function goal(id: string, cost: number, order: number, createdAt = 0): Goal {
  return { id, name: id, cost, order, createdAt }
}

function state(baseline: number | null, baselineAt: number | null): MoneyState {
  return { currency: 'USD', baseline, baselineAt, updatedAt: 0 }
}

describe('formatMoney', () => {
  it('shows cents only when there are some', () => {
    expect(formatMoney(1250, 'USD')).toBe('$1,250')
    expect(formatMoney(1250.5, 'USD')).toBe('$1,250.50')
    expect(formatMoney(1250.05, 'USD')).toBe('$1,250.05')
    expect(formatMoney(1250.004, 'USD')).toBe('$1,250')
    expect(formatMoney(0, 'USD')).toBe('$0')
    expect(formatMoney(0.5, 'EUR')).toBe('€0.50')
    expect(formatMoney(MAX_AMOUNT, 'USD')).toBe('$1,000,000,000')
  })

  it('never shows minor units for zero-decimal currencies', () => {
    expect(formatMoney(1250.5, 'JPY')).toBe('¥1,251')
    expect(formatMoney(1500, 'KRW')).toBe('₩1,500')
    expect(formatMoney(0.4, 'JPY')).toBe('¥0')
    expect(formatMoney(-0.4, 'JPY')).toBe('¥0')
  })

  it('signed: + for money in, the minus sign for money out, nothing for zero', () => {
    expect(formatMoney(500, 'USD', { signed: true })).toBe('+$500')
    expect(formatMoney(-300, 'USD', { signed: true })).toBe('−$300')
    expect(formatMoney(-300.25, 'USD', { signed: true })).toBe('−$300.25')
    expect(formatMoney(0, 'USD', { signed: true })).toBe('$0')
    expect(formatMoney(-0.001, 'USD', { signed: true })).toBe('$0')
  })

  it('negatives use the minus sign (U+2212), never a hyphen, and −0 reads as 0', () => {
    expect(formatMoney(-300, 'USD')).toBe('−$300')
    expect(formatMoney(-0, 'USD')).toBe('$0')
    expect(formatMoney(-0.004, 'USD')).toBe('$0')
    for (const amount of [-1, -1250.5, -MAX_AMOUNT]) {
      for (const opts of [{}, { signed: true }, { compact: true }, { locale: 'de-DE' }, { locale: 'hy-AM' }]) {
        const text = formatMoney(amount, 'EUR', opts)
        expect(text).not.toContain('-')
        expect(text).toContain('−')
      }
    }
  })

  it('compact', () => {
    expect(formatMoney(1234, 'USD', { compact: true })).toBe('$1.2K')
    expect(formatMoney(12_345, 'USD', { compact: true })).toBe('$12K')
    expect(formatMoney(1_250_000, 'USD', { compact: true })).toBe('$1.3M')
    expect(formatMoney(800, 'USD', { compact: true })).toBe('$800')
    expect(formatMoney(0, 'USD', { compact: true })).toBe('$0')
    expect(formatMoney(1500, 'USD', { compact: true, signed: true })).toBe('+$1.5K')
    expect(formatMoney(-1500, 'USD', { compact: true, signed: true })).toBe('−$1.5K')
    expect(formatMoney(1_234_567, 'JPY', { compact: true })).toBe('¥1.2M')
  })

  it('formats in the given locale (en-US by default)', () => {
    // Locales put no-break spaces around the symbol.
    expect(formatMoney(1250.5, 'EUR', { locale: 'de-DE' })).toMatch(/^1\.250,50\s€$/)
    expect(formatMoney(-1250.5, 'EUR', { locale: 'de-DE' })).toMatch(/^−1\.250,50\s€$/)
    // Five digits: Armenian groups only from 10,000 in newer CLDR data (minimum grouping digits 2).
    expect(formatMoney(12345.5, 'AMD', { locale: 'hy-AM' })).toMatch(/^12\s345,50\s֏$/)
    expect(formatMoney(1250.5, 'AMD')).toBe('֏1,250.50')
    expect(formatMoney(1250, 'GBP', { locale: 'en-GB' })).toBe('£1,250')
  })

  it('treats a missing or broken amount as zero rather than printing NaN', () => {
    expect(formatMoney(Number.NaN, 'USD')).toBe('$0')
  })
})

describe('currencies', () => {
  it('lists about 30 distinct ISO codes, each with a name and a symbol', () => {
    const codes = CURRENCIES.map((c) => c.code)
    expect(codes.length).toBeGreaterThanOrEqual(29)
    expect(new Set(codes).size).toBe(codes.length)
    for (const { code, name } of CURRENCIES) {
      expect(code).toMatch(/^[A-Z]{3}$/)
      expect(name.length).toBeGreaterThan(0)
      expect(currencySymbol(code).length).toBeGreaterThan(0)
      expect(formatMoney(1, code)).toMatch(/1/)
    }
    expect(codes.slice(0, 4)).toEqual(['USD', 'EUR', 'GBP', 'AMD'])
  })

  it('currencySymbol gives the narrow symbol', () => {
    expect(currencySymbol('USD')).toBe('$')
    expect(currencySymbol('EUR')).toBe('€')
    expect(currencySymbol('GBP')).toBe('£')
    expect(currencySymbol('AMD')).toBe('֏')
    expect(currencySymbol('RUB')).toBe('₽')
    expect(currencySymbol('GEL')).toBe('₾')
    expect(currencySymbol('JPY')).toBe('¥')
    expect(currencySymbol('KRW')).toBe('₩')
    // Narrow: no "US$" or "CA$" (every amount of a user is in one currency).
    expect(currencySymbol('CAD')).toBe('$')
    expect(currencySymbol('EUR', 'de-DE')).toBe('€')
  })
})

describe('defaultCurrency', () => {
  it('follows the locale\'s region', () => {
    expect(defaultCurrency('en-US')).toBe('USD')
    expect(defaultCurrency('de-DE')).toBe('EUR')
    expect(defaultCurrency('hy-AM')).toBe('AMD')
    expect(defaultCurrency('en-GB')).toBe('GBP')
    expect(defaultCurrency('ja-JP')).toBe('JPY')
    expect(defaultCurrency('fr-CA')).toBe('CAD')
    expect(defaultCurrency('en-DE')).toBe('EUR')
    expect(defaultCurrency('ru-AM')).toBe('AMD')
    expect(defaultCurrency('bg-BG')).toBe('EUR')
    expect(defaultCurrency('en_GB')).toBe('GBP')
  })

  it('without a region, uses the language\'s likely one', () => {
    expect(defaultCurrency('de')).toBe('EUR')
    expect(defaultCurrency('hy')).toBe('AMD')
    expect(defaultCurrency('en')).toBe('USD')
  })

  it('falls back to USD', () => {
    expect(defaultCurrency('es-AR')).toBe('USD')
    expect(defaultCurrency('en-419')).toBe('USD')
    expect(defaultCurrency('')).toBe('USD')
    expect(defaultCurrency('not a locale!')).toBe('USD')
  })

  it('reads the device language when no locale is given', () => {
    const device = typeof navigator === 'undefined' ? undefined : navigator.language
    expect(defaultCurrency()).toBe(device ? defaultCurrency(device) : 'USD')
  })

  it('always picks a currency the picker lists', () => {
    const codes = new Set(CURRENCIES.map((c) => c.code))
    for (const locale of ['en-US', 'de', 'zh-Hant-TW', 'ar-EG', 'pt-BR', 'en-IN', 'uk-UA', 'ka-GE', 'he-IL', 'xx-ZZ']) {
      expect(codes.has(defaultCurrency(locale))).toBe(true)
    }
  })
})

describe('parseAmount', () => {
  it.each([
    ['500', 500],
    ['0', 0],
    ['0.00', 0],
    ['1,234.50', 1234.5],
    ['1.234,50', 1234.5],
    ['1 234,5', 1234.5],
    ['1 234', 1234],
    ['1,5', 1.5],
    ['1.5', 1.5],
    ['1,50', 1.5],
    ['1,500', 1500],
    ['1.500', 1500],
    ['1,234,567.89', 1234567.89],
    ['1.234.567,89', 1234567.89],
    ['1,000,000', 1_000_000],
    ['1,23,456.50', 123456.5],
    ["12'345.50", 12345.5],
    ['12’345', 12345],
    ['1 234,56', 1234.56],
    ['1 234,56', 1234.56],
    ['0,500', 0.5],
    ['1234.567', 1234.57],
    ['.5', 0.5],
    ['12.', 12],
    ['12,', 12],
    ['007', 7],
    ['  42  ', 42],
    ['1.005', 1005],
    ['0.125', 0.13],
  ])('%j → %d', (text, value) => {
    expect(parseAmount(text)).toBe(value)
  })

  it.each([
    ['$500', 500],
    ['$ 500', 500],
    ['+$500', 500],
    ['+500', 500],
    ['500 USD', 500],
    ['usd 500', 500],
    ['€ 1.234,50', 1234.5],
    ['1.234,50 €', 1234.5],
    ['֏12,000', 12000],
    ['₽100', 100],
    ['£0.99', 0.99],
  ])('strips a currency symbol or code: %j → %d', (text, value) => {
    expect(parseAmount(text)).toBe(value)
  })

  it.each([
    '',
    '   ',
    '.',
    ',',
    '$',
    'USD',
    'abc',
    '12abc',
    '1e5',
    '0x10',
    'NaN',
    'Infinity',
    '-500',
    '−500',
    '(500)',
    '1.2.3',
    '1,2,3',
    '1.2,3.4',
    '1,234,56',
    '1,000,',
    '12 34',
    '1 234, 5',
    '5 6 7',
    '1/2',
    '500 dollars',
  ])('rejects %j', (text) => {
    expect(parseAmount(text)).toBeNull()
  })

  it('caps at MAX_AMOUNT', () => {
    expect(parseAmount('1000000000')).toBe(MAX_AMOUNT)
    expect(parseAmount('1,000,000,000.004')).toBe(MAX_AMOUNT)
    expect(parseAmount('1,000,000,000.01')).toBeNull()
    expect(parseAmount('99999999999999999999')).toBeNull()
  })
})

describe('editableAmount', () => {
  it('is digits and a point, cents only when there are some', () => {
    expect(editableAmount(1250)).toBe('1250')
    expect(editableAmount(1250.5)).toBe('1250.50')
    expect(editableAmount(250000)).toBe('250000')
    expect(editableAmount(1_000_000_000)).toBe('1000000000')
    expect(editableAmount(0.07)).toBe('0.07')
  })

  it('reads back as itself, and after the usual edits as what was meant', () => {
    for (const value of [0, 0.5, 12, 1250, 1250.5, 4500, 250000, 1_000_000_000]) expect(parseAmount(editableAmount(value))).toBe(value)
    // One zero missed, one too many, and cents typed on a comma keypad.
    expect(parseAmount(`${editableAmount(1250)}0`)).toBe(12500)
    expect(parseAmount(editableAmount(4500).slice(0, -1))).toBe(450)
    expect(parseAmount(`${editableAmount(250000)}0`)).toBe(2500000)
    expect(parseAmount(`${editableAmount(1250)},50`)).toBe(1250.5)
  })
})

describe('roundMoney', () => {
  it('rounds to cents, half away from zero, without float surprises', () => {
    expect(roundMoney(1.005)).toBe(1.01)
    expect(roundMoney(2.675)).toBe(2.68)
    expect(roundMoney(-1.005)).toBe(-1.01)
    expect(roundMoney(0.1 + 0.2)).toBe(0.3)
    expect(roundMoney(1234.5)).toBe(1234.5)
    expect(roundMoney(MAX_AMOUNT)).toBe(MAX_AMOUNT)
    expect(Object.is(roundMoney(-0.001), 0)).toBe(true)
  })
})

describe('earningId', () => {
  it('joins space, week and task', () => {
    expect(earningId('sp1', '2026-10-12', 'abc123')).toBe('sp1_2026-10-12_abc123')
  })
})

describe('balanceOf', () => {
  const earnings = [earning('t1', 800, NOW - 3 * DAY), earning('t2', 200, null), earning('t3', 50.5, NOW - DAY)]
  const moves = [move('m1', 'add', 100, NOW - 5 * DAY), move('m2', 'spend', 30.25, NOW - 2 * DAY)]

  it('without a baseline, every move and earned task counts', () => {
    expect(balanceOf(null, [], [])).toBe(0)
    expect(balanceOf(null, earnings, moves)).toBe(800 + 50.5 + 100 - 30.25)
    // A state that only holds the currency is the same.
    expect(balanceOf(state(null, null), earnings, moves)).toBe(920.25)
  })

  it('with a baseline, only what came strictly after it', () => {
    const s = state(1000, NOW - 3 * DAY)
    // t1 was earned exactly when the baseline was set: already in it.
    expect(balanceOf(s, earnings, moves)).toBe(1000 + 50.5 - 30.25)
    expect(balanceOf(s, [earning('t4', 10, NOW - 3 * DAY + 1)], [move('m3', 'add', 5, NOW - 3 * DAY)])).toBe(1010)
    expect(balanceOf(state(0, NOW), earnings, moves)).toBe(0)
  })

  it('a baseline still waiting for its server time already holds everything', () => {
    expect(balanceOf(state(1000, null), earnings, moves)).toBe(1000)
  })

  it('can go negative', () => {
    expect(balanceOf(state(100, NOW - DAY), [], [move('m1', 'spend', 250, NOW)])).toBe(-150)
    expect(balanceOf(null, [], [move('m1', 'spend', 0.1, NOW), move('m2', 'spend', 0.2, NOW)])).toBe(-0.3)
  })

  it('adds up in cents, so tenths don\'t drift', () => {
    const adds = Array.from({ length: 10 }, (_, i) => move(`m${i}`, 'add', 0.1, NOW))
    expect(balanceOf(null, [], adds)).toBe(1)
    expect(balanceOf(state(0.1, 0), [earning('t', 0.2, 1)], [])).toBe(0.3)
  })
})

describe('inBaseline', () => {
  it('is money earned at or before the balance was set', () => {
    const s = state(1500, NOW - DAY)
    expect(inBaseline(s, NOW - 2 * DAY)).toBe(true)
    expect(inBaseline(s, NOW - DAY)).toBe(true)
    expect(inBaseline(s, NOW - DAY + 1)).toBe(false)
    expect(inBaseline(s, null)).toBe(false)
    // No balance set: nothing is in it, whatever the currency doc says.
    expect(inBaseline(null, NOW - 2 * DAY)).toBe(false)
    expect(inBaseline(state(null, null), NOW - 2 * DAY)).toBe(false)
    // Set a moment ago, its server time still on the way: everything so far is in it.
    expect(inBaseline(state(1500, null), NOW)).toBe(true)
  })

  it('keeping such an earning when its task is un-done keeps the balance right', () => {
    // Earned Monday, balance set Tuesday (it holds the 500), task un-ticked and ticked again Wednesday.
    const s = state(1500, NOW - DAY)
    const kept = earning('t1', 500, NOW - 2 * DAY)
    expect(balanceOf(s, [kept], [])).toBe(1500)
    // What clearing and re-earning would have done: the 500 a second time.
    expect(balanceOf(s, [earning('t1', 500, NOW)], [])).toBe(2000)
  })
})

describe('weeklyPace', () => {
  it('is the net money in over the last 28 days, per week', () => {
    const earnings = [earning('t1', 800, NOW - 10 * DAY), earning('t2', 400, null), earning('t3', 1000, NOW - 40 * DAY)]
    const moves = [move('m1', 'add', 200, NOW - DAY), move('m2', 'spend', 100, NOW - 20 * DAY), move('m3', 'add', 5000, NOW - 29 * DAY)]
    expect(weeklyPace(earnings, moves, NOW)).toBe((800 + 200 - 100) / 4)
    expect(weeklyPace([], [], NOW)).toBe(0)
  })

  it('the window starts just after now − 28 days', () => {
    expect(weeklyPace([earning('t', 400, NOW - 28 * DAY)], [], NOW)).toBe(0)
    expect(weeklyPace([earning('t', 400, NOW - 28 * DAY + 1)], [], NOW)).toBe(100)
    expect(weeklyPace([], [move('m', 'add', 400, NOW + 1000)], NOW)).toBe(100)
  })

  it('can be negative when more went out than came in', () => {
    expect(weeklyPace([earning('t', 100, NOW)], [move('m', 'spend', 500, NOW)], NOW)).toBe(-100)
  })

  it('leaves out goals marked as bought: money saved earlier, not a slower pace', () => {
    const earnings = [earning('t1', 500, NOW - 3 * DAY), earning('t2', 500, NOW - 10 * DAY), earning('t3', 500, NOW - 17 * DAY), earning('t4', 500, NOW - 24 * DAY)]
    const bought = move('m1', 'spend', 1500, NOW - DAY, 'FX3', true)
    expect(weeklyPace(earnings, [bought], NOW)).toBe(500)
    // The purchase still comes off the balance.
    expect(balanceOf(state(2000, NOW - 60 * DAY), earnings, [bought])).toBe(2500)
    // A spend recorded by hand still slows the pace, whatever its note says.
    expect(weeklyPace(earnings, [move('m2', 'spend', 1500, NOW - DAY, 'FX3')], NOW)).toBe(125)
  })
})

describe('etaWeeks', () => {
  it('rounds up to whole weeks', () => {
    expect(etaWeeks(1000, 250)).toBe(4)
    expect(etaWeeks(1001, 250)).toBe(5)
    expect(etaWeeks(0.01, 250)).toBe(1)
    expect(etaWeeks(1.1, 0.1)).toBe(11)
  })

  it('is 0 when nothing is needed', () => {
    expect(etaWeeks(0, 0)).toBe(0)
    expect(etaWeeks(-5, 100)).toBe(0)
  })

  it('is null without a positive pace or past two years', () => {
    expect(etaWeeks(100, 0)).toBeNull()
    expect(etaWeeks(100, -10)).toBeNull()
    expect(etaWeeks(100, Number.NaN)).toBeNull()
    expect(etaWeeks(10_400, 100)).toBe(104)
    expect(etaWeeks(10_400.01, 100)).toBeNull()
  })
})

describe('fundGoals', () => {
  it('fills goals top first and estimates each from the total still needed up to it', () => {
    const goals = [goal('lens', 800, 1), goal('camera', 600, 0), goal('trip', 300, 2)]
    const funded = fundGoals(goals, 1000, 100)
    expect(funded.map((f) => f.goal.id)).toEqual(['camera', 'lens', 'trip'])
    expect(funded.map(({ funded, progress, left, complete, etaWeeks }) => ({ funded, progress, left, complete, etaWeeks }))).toEqual([
      { funded: 600, progress: 1, left: 0, complete: true, etaWeeks: 0 },
      { funded: 400, progress: 0.5, left: 400, complete: false, etaWeeks: 4 },
      // 400 for the lens first, then 300: 7 weeks.
      { funded: 0, progress: 0, left: 300, complete: false, etaWeeks: 7 },
    ])
    // The input is left alone.
    expect(goals.map((g) => g.id)).toEqual(['lens', 'camera', 'trip'])
  })

  it('breaks order ties by createdAt', () => {
    const goals = [goal('newer', 100, 0, 2000), goal('older', 100, 0, 1000), goal('first', 100, -1, 3000)]
    const funded = fundGoals(goals, 150, 0)
    expect(funded.map((f) => [f.goal.id, f.funded])).toEqual([
      ['first', 100],
      ['older', 50],
      ['newer', 0],
    ])
  })

  it('a negative or zero balance funds nothing', () => {
    for (const balance of [0, -500]) {
      expect(fundGoals([goal('a', 100, 0), goal('b', 50, 1)], balance, 50).map((f) => [f.funded, f.left, f.etaWeeks])).toEqual([
        [0, 100, 2],
        [0, 50, 3],
      ])
    }
  })

  it('no estimate without a positive pace or past two years', () => {
    const funded = fundGoals([goal('a', 100, 0), goal('b', 1000, 1), goal('c', 10_000, 2)], 150, 50)
    // b still needs 950 (19 weeks at 50); c needs 950 + 10,000 (219 weeks).
    expect(funded.map((f) => f.etaWeeks)).toEqual([0, 19, null])
    expect(fundGoals([goal('a', 100, 0), goal('b', 100, 1)], 150, 0).map((f) => f.etaWeeks)).toEqual([0, null])
  })

  it('funds exactly in cents', () => {
    const balance = balanceOf(null, [], [move('m1', 'add', 0.1, 0), move('m2', 'add', 0.2, 0)])
    const [g] = fundGoals([goal('a', 0.3, 0)], balance, 0)
    expect(g).toMatchObject({ funded: 0.3, progress: 1, left: 0, complete: true })
    expect(fundGoals([], 100, 10)).toEqual([])
  })
})

describe('nextGoalOrder', () => {
  it('puts a new goal after every existing one', () => {
    expect(nextGoalOrder([])).toBe(0)
    expect(nextGoalOrder([goal('a', 1, 0), goal('b', 1, 3), goal('c', 1, 1)])).toBe(4)
    expect(nextGoalOrder([goal('a', 1, -2)])).toBe(-1)
  })
})

describe('earnings by week and month', () => {
  // 2026-09-28's Friday is 2 October and 2026-10-26's is 30 October; 2026-11-02 belongs to November.
  const earnings = [
    earning('a', 800, NOW, '2026-10-12'),
    earning('b', 200.5, NOW, '2026-10-12', 's2'),
    earning('c', 300, null, '2026-10-12'),
    earning('d', 150, NOW, '2026-09-28'),
    earning('e', 1000, NOW, '2026-10-26'),
    earning('f', 99, null, '2026-10-19'),
    earning('g', 400, NOW, '2026-11-02'),
    earning('h', 70, NOW, '2026-09-21'),
    earning('i', 0, NOW, '2026-10-05'),
  ]

  it('earnedByWeek counts done tasks only and lists every requested week', () => {
    expect(earnedByWeek(earnings, ['2026-10-05', '2026-10-12', '2026-10-19'])).toEqual({ '2026-10-05': 0, '2026-10-12': 1000.5, '2026-10-19': 0 })
    expect(earnedByWeek([], ['2026-10-12'])).toEqual({ '2026-10-12': 0 })
  })

  it('earnedInMonth groups by the month of each week\'s Friday', () => {
    expect(earnedInMonth(earnings, '2026-10')).toBe(150 + 800 + 200.5 + 1000)
    expect(earnedInMonth(earnings, '2026-11')).toBe(400)
    expect(earnedInMonth(earnings, '2026-09')).toBe(70)
    expect(earnedInMonth(earnings, '2026-12')).toBe(0)
  })

  it('pendingIn counts revenue tasks not done yet', () => {
    expect(pendingIn(earnings, ['2026-10-12', '2026-10-19'])).toBe(399)
    expect(pendingIn(earnings, ['2026-10-26'])).toBe(0)
  })

  it('totalEarned', () => {
    expect(totalEarned(earnings)).toBe(800 + 200.5 + 150 + 1000 + 400 + 70)
    expect(totalEarned([])).toBe(0)
  })

  it('topEarnings: the month\'s earned tasks, largest first, without empty amounts', () => {
    expect(topEarnings(earnings, '2026-10', 3).map((e) => e.taskId)).toEqual(['e', 'a', 'b'])
    expect(topEarnings(earnings, '2026-10', 10).map((e) => e.taskId)).toEqual(['e', 'a', 'b', 'd'])
    expect(topEarnings(earnings, '2026-10', 0)).toEqual([])
    const tie = [earning('old', 100, NOW - DAY), earning('new', 100, NOW)]
    expect(topEarnings(tie, '2026-10', 2).map((e) => e.taskId)).toEqual(['new', 'old'])
  })

  it('a malformed week id is skipped, not thrown on', () => {
    const bad = [earning('x', 100, NOW, '2026-13-45'), earning('y', 5, NOW, '2026-10-12')]
    expect(earnedInMonth(bad, '2026-10')).toBe(5)
    expect(topEarnings(bad, '2026-10', 5).map((e) => e.taskId)).toEqual(['y'])
  })
})

describe('moneyActivity', () => {
  it('lists earnings once earned, moves and the balance, newest first', () => {
    const earnings = [earning('t1', 800, NOW - 3 * DAY), earning('t2', 200, null)]
    const moves = [move('m1', 'add', 100, NOW - 5 * DAY, 'Gift'), move('m2', 'spend', 30, NOW - DAY, 'Rent')]
    const feed = moneyActivity(state(500, NOW - 4 * DAY), earnings, moves)
    expect(feed.map((a) => [a.kind, a.id, a.at, a.amount])).toEqual([
      ['spend', 'm2', NOW - DAY, 30],
      ['earning', 's1_2026-10-12_t1', NOW - 3 * DAY, 800],
      ['baseline', 'baseline', NOW - 4 * DAY, 500],
      ['add', 'm1', NOW - 5 * DAY, 100],
    ])
    const [spend, earned] = feed
    expect(spend.kind === 'spend' && spend.move.note).toBe('Rent')
    expect(earned.kind === 'earning' && earned.earning.title).toBe('t1')
  })

  it('shows the balance above anything at the same moment (that is already in it)', () => {
    const feed = moneyActivity(state(500, NOW), [earning('t', 10, NOW)], [move('m', 'add', 5, NOW)])
    expect(feed.map((a) => a.kind)).toEqual(['baseline', 'add', 'earning'])
  })

  it('has no balance entry until one is set', () => {
    expect(moneyActivity(null, [], [])).toEqual([])
    expect(moneyActivity(state(null, null), [], [move('m', 'add', 5, NOW)]).map((a) => a.kind)).toEqual(['add'])
  })
})
