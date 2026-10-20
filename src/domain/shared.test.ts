import { describe, expect, it } from 'vitest'
import {
  CHECKIN_NOTE_MAX,
  MAX_GOAL_AMOUNT,
  SHARED_MAX_PEOPLE,
  SHARED_NAME_MAX,
  SHARED_UNITS,
  SHARED_UNIT_MAX,
  amountProblem,
  amountProblemText,
  applyCheckin,
  canCheckIn,
  checkinClosesAt,
  checkinId,
  cleanNote,
  formatGoalAmount,
  formatGoalNumber,
  fromHundredths,
  goalEndsAt,
  goalProblem,
  goalProblemText,
  goalProgress,
  goalShares,
  goalStatus,
  goalWeek,
  isCurrencyUnit,
  isGoalId,
  nextOwner,
  noteProblem,
  noteProblemText,
  openInvites,
  parseGoalAmount,
  progressText,
  toHundredths,
  waitingFor,
  weekProgress,
  type GoalProblem,
} from './shared.ts'
import { addWeeks, momentAt, utcOffsetMinutes } from './time.ts'
import type { Checkin, SharedGoal, UID } from './types.ts'

const H = 3_600_000
const DAY = 86_400_000
const T = Date.parse('2026-10-20T10:00:00Z')
const BERLIN = 'Europe/Berlin'

function goal(patch: Partial<SharedGoal> = {}): SharedGoal {
  return {
    id: 'g1',
    name: 'Run 100 km',
    unit: 'km',
    target: 100,
    endsOn: null,
    timezone: BERLIN,
    utcOffsetMin: 120,
    zones: { ana: BERLIN },
    ownerId: 'ana',
    createdBy: 'ana',
    memberIds: ['ana', 'ben', 'cleo'],
    invited: ['dan'],
    joinedAt: { ana: T - 9 * DAY, ben: T - 5 * DAY, cleo: T - 3 * DAY },
    leftAt: {},
    totals: {},
    total: 0,
    last: null,
    reachedAt: null,
    archivedAt: null,
    createdAt: T - 9 * DAY,
    ...patch,
  }
}

function checkin(uid: UID, weekId: string, amount: number, note = ''): Checkin {
  return { id: checkinId(weekId, uid), uid, weekId, amount, note, at: T }
}

describe('constants', () => {
  it('match §11.7', () => {
    expect([SHARED_MAX_PEOPLE, SHARED_NAME_MAX, SHARED_UNIT_MAX, CHECKIN_NOTE_MAX, MAX_GOAL_AMOUNT]).toEqual([8, 60, 16, 80, 1e9])
    expect(SHARED_UNITS).toEqual(['km', 'books', 'hours', 'times'])
  })
})

describe('toHundredths and fromHundredths', () => {
  it('lands every 2-decimal amount on its own int, float noise shaved', () => {
    expect(toHundredths(0.29)).toBe(29)
    expect(toHundredths(1.005)).toBe(101)
    expect(toHundredths(0.1 + 0.2)).toBe(30)
    expect(toHundredths(12.5)).toBe(1250)
    expect(toHundredths(MAX_GOAL_AMOUNT)).toBe(1e11)
    expect(toHundredths(999_999_999.99)).toBe(99_999_999_999)
    expect(Object.is(toHundredths(-0), 0)).toBe(true)
    expect(toHundredths(-12.34)).toBe(-1234)
    for (let n = 0; n <= 200_000; n += 7) expect(toHundredths(n / 100)).toBe(n)
    for (let n = 99_999_000_000; n <= 1e11; n += 99_991) expect(toHundredths(fromHundredths(n))).toBe(n)
  })
  it('NaN and Infinity stay unusable', () => {
    expect(toHundredths(Number.NaN)).toBeNaN()
    expect(toHundredths(Number.POSITIVE_INFINITY)).toBeNaN()
  })
  it('fromHundredths', () => {
    expect(fromHundredths(29)).toBe(0.29)
    expect(fromHundredths(1e11)).toBe(1e9)
  })
})

describe('parseGoalAmount and amountProblem', () => {
  it('reads amounts as money fields do', () => {
    expect(parseGoalAmount('1,250.5')).toBe(1250.5)
    expect(parseGoalAmount('12,5')).toBe(12.5)
    expect(parseGoalAmount('12.50')).toBe(12.5)
    expect(parseGoalAmount(' 7 ')).toBe(7)
    expect(parseGoalAmount('0')).toBe(0)
    expect(parseGoalAmount('$500')).toBe(500)
    expect(parseGoalAmount('1,000,000,000')).toBe(1e9)
    expect(parseGoalAmount('12.')).toBe(12)
  })
  it('null when unreadable, negative, past 2 decimals or over the cap', () => {
    for (const bad of ['', '  ', 'abc', '1e3', '-5', '0.125', '1,000,000,001', '1000000000.01', '12 km', '1.2.3']) expect(parseGoalAmount(bad)).toBeNull()
  })
  it('says why', () => {
    expect(amountProblem('')).toBe('empty')
    expect(amountProblem('   ')).toBe('empty')
    expect(amountProblem('abc')).toBe('format')
    expect(amountProblem('1e3')).toBe('format')
    expect(amountProblem('-5')).toBe('format')
    expect(amountProblem('0.125')).toBe('format')
    expect(amountProblem('1000000000.01')).toBe('big')
    expect(amountProblem('2,000,000,000')).toBe('big')
    expect(amountProblem('12.5')).toBeNull()
    expect(amountProblem('0')).toBeNull()
    expect(amountProblemText('empty')).toBe('Enter 0 or more.')
    expect(amountProblemText('format')).toBe('Use a number, like 12.5.')
    expect(amountProblemText('big')).toBe('That number is too big.')
  })
})

describe('cleanNote and noteProblem', () => {
  it('puts a note on one line', () => {
    expect(cleanNote('Long run\non Sunday')).toBe('Long run on Sunday')
    expect(cleanNote('  a \r\n\r\n b  ')).toBe('a b')
    expect(cleanNote('a\u2028b')).toBe('a b')
    expect(cleanNote('a \u2029 b')).toBe('a b')
    expect(cleanNote('\n\n')).toBe('')
    expect(cleanNote('two  spaces')).toBe('two  spaces')
    expect(cleanNote('x\ny')).not.toMatch(/[\n\r\u2028\u2029]/)
  })
  it('80 UTF-16 units after cleaning', () => {
    expect(noteProblem('x'.repeat(80))).toBeNull()
    expect(noteProblem('x'.repeat(81))).toBe('long')
    expect(noteProblem(`${'x'.repeat(40)}\n\n${'x'.repeat(39)}`)).toBeNull()
    expect(noteProblem(`  ${'x'.repeat(80)}  `)).toBeNull()
    expect(noteProblem('😀'.repeat(41))).toBe('long')
    expect(noteProblemText('long')).toBe('Keep the note to 80 characters.')
  })
})

describe('amount wording', () => {
  it('isCurrencyUnit: one of the app’s currency codes', () => {
    expect(isCurrencyUnit('USD')).toBe(true)
    expect(isCurrencyUnit('EUR')).toBe(true)
    expect(isCurrencyUnit('usd')).toBe(false)
    expect(isCurrencyUnit('km')).toBe(false)
    expect(isCurrencyUnit('XYZ')).toBe(false)
  })
  it('formatGoalNumber: en-US grouping, up to 2 decimals, no trailing zeros', () => {
    expect(formatGoalNumber(1250.5)).toBe('1,250.5')
    expect(formatGoalNumber(12)).toBe('12')
    expect(formatGoalNumber(12.25)).toBe('12.25')
    expect(formatGoalNumber(0.1 + 0.2)).toBe('0.3')
    expect(formatGoalNumber(1e9)).toBe('1,000,000,000')
    expect(formatGoalNumber(-0)).toBe('0')
    expect(formatGoalNumber(Number.NaN)).toBe('0')
  })
  it('formatGoalAmount: a unit after the number, or money', () => {
    expect(formatGoalAmount(1250.5, 'km')).toBe('1,250.5 km')
    expect(formatGoalAmount(20, 'books')).toBe('20 books')
    expect(formatGoalAmount(12.5, 'km')).toBe('12.5 km')
    expect(formatGoalAmount(4200.5, 'USD')).toBe('$4,200.50')
    expect(formatGoalAmount(5000, 'USD')).toBe('$5,000')
    expect(formatGoalAmount(12.5, 'EUR')).toBe('€12.50')
  })
  it('progressText', () => {
    expect(progressText({ total: 64, target: 100, unit: 'km' })).toBe('64 of 100 km')
    expect(progressText({ total: 12.5, target: 100, unit: 'km' })).toBe('12.5 of 100 km')
    expect(progressText({ total: 4200, target: 5000, unit: 'USD' })).toBe('$4,200 of $5,000')
    expect(progressText({ total: 104, target: 100, unit: 'books' })).toBe('104 of 100 books')
  })
})

describe('goalProblem', () => {
  const ok = { name: 'Run 100 km', unit: 'km', target: 100 }
  it('null for a goal that can be saved', () => {
    expect(goalProblem(ok)).toBeNull()
    expect(goalProblem({ ...ok, name: 'x'.repeat(60), unit: 'y'.repeat(16), target: MAX_GOAL_AMOUNT })).toBeNull()
    expect(goalProblem({ ...ok, name: `  ${'x'.repeat(60)}  ` })).toBeNull()
    expect(goalProblem({ ...ok, target: 0.01 })).toBeNull()
  })
  it('first problem first', () => {
    const cases: [Partial<Omit<typeof ok, 'target'>> & { target?: number | null }, GoalProblem][] = [
      [{ name: '   ' }, 'name'],
      [{ name: 'x'.repeat(61) }, 'name-long'],
      [{ unit: '' }, 'unit'],
      [{ unit: 'x'.repeat(17) }, 'unit-long'],
      [{ target: null }, 'target'],
      [{ target: 0 }, 'target'],
      [{ target: -3 }, 'target'],
      [{ target: 0.004 }, 'target'],
      [{ target: Number.NaN }, 'target'],
      [{ target: 1e9 + 0.01 }, 'target-big'],
      [{ name: '', unit: '', target: null }, 'name'],
    ]
    for (const [patch, problem] of cases) expect(goalProblem({ ...ok, ...patch })).toBe(problem)
  })
  it('texts', () => {
    expect(goalProblemText('name')).toBe('Give the goal a name.')
    expect(goalProblemText('name-long')).toBe('Keep the name to 60 characters.')
    expect(goalProblemText('unit')).toBe('Add a unit, like km or books.')
    expect(goalProblemText('unit-long')).toBe('Keep the unit to 16 characters.')
    expect(goalProblemText('target')).toBe('Enter a target above 0.')
    expect(goalProblemText('target-big')).toBe('That number is too big.')
  })
})

describe('isGoalId and checkinId', () => {
  it('1–40 letters and digits', () => {
    expect(isGoalId('Xy12AbCdEfGhIjKlMn34')).toBe(true)
    expect(isGoalId('a')).toBe(true)
    expect(isGoalId('a'.repeat(40))).toBe(true)
    for (const bad of ['', 'a'.repeat(41), 'a_b', 'a#b', 'a-b', 'a b', 'a/b', '../x', 'é']) expect(isGoalId(bad)).toBe(false)
    for (const bad of [null, undefined, 12, {}]) expect(isGoalId(bad)).toBe(false)
  })
  it('a check-in id is the week and the uid', () => {
    expect(checkinId('2026-10-19', 'ana')).toBe('2026-10-19_ana')
  })
})

describe('goalWeek: the space week in the goal’s zone, across DST', () => {
  it('fall back (Berlin, Oct 25 2026): Sunday 23:30 is still that week, Monday 00:00 the next', () => {
    expect(goalWeek(goal(), Date.parse('2026-10-25T22:30:00Z'))).toBe('2026-10-19')
    expect(goalWeek(goal(), Date.parse('2026-10-25T22:59:59Z'))).toBe('2026-10-19')
    expect(goalWeek(goal(), Date.parse('2026-10-25T23:00:00Z'))).toBe('2026-10-26')
  })
  it('spring forward (Berlin, Mar 28 2027)', () => {
    expect(goalWeek(goal(), Date.parse('2027-03-28T21:59:59Z'))).toBe('2027-03-22')
    expect(goalWeek(goal(), Date.parse('2027-03-28T22:00:00Z'))).toBe('2027-03-29')
  })
  it('the goal’s zone decides, not the viewer’s', () => {
    const now = Date.parse('2026-10-25T20:00:00Z')
    expect(goalWeek(goal({ timezone: 'Asia/Tokyo' }), now)).toBe('2026-10-26')
    expect(goalWeek(goal({ timezone: 'America/Los_Angeles' }), now)).toBe('2026-10-19')
  })
})

describe('goalEndsAt', () => {
  it('the start of the day after endsOn, in the goal’s zone across DST', () => {
    expect(goalEndsAt(goal({ endsOn: '2026-10-24' }))).toBe(Date.parse('2026-10-24T22:00:00Z'))
    expect(goalEndsAt(goal({ endsOn: '2026-10-25' }))).toBe(Date.parse('2026-10-25T23:00:00Z'))
    expect(goalEndsAt(goal({ endsOn: '2027-03-27' }))).toBe(Date.parse('2027-03-27T23:00:00Z'))
    expect(goalEndsAt(goal({ endsOn: '2027-03-28' }))).toBe(Date.parse('2027-03-28T22:00:00Z'))
    expect(goalEndsAt(goal({ endsOn: '2026-12-31', timezone: 'America/New_York' }))).toBe(Date.parse('2027-01-01T05:00:00Z'))
  })
  it('a zone whose midnight is skipped: the first instant of the next day', () => {
    // Santiago springs forward at 00:00 on Sunday Sep 6, 2026: the day starts at 01:00 (−03:00).
    expect(goalEndsAt(goal({ endsOn: '2026-09-05', timezone: 'America/Santiago' }))).toBe(Date.parse('2026-09-06T04:00:00Z'))
  })
  it('null without an end date, or with one that isn’t a date', () => {
    expect(goalEndsAt(goal())).toBeNull()
    expect(goalEndsAt(goal({ endsOn: 'soon' }))).toBeNull()
    expect(goalEndsAt(goal({ endsOn: '2026-13-01' }))).toBeNull()
  })
})

/** The rules' anchor: Monday (or any day) 00:00 on the stored offset. */
function dayAnchor(id: string, off: number): number {
  const [y, m, d] = id.split('-').map(Number)
  return Date.UTC(y, m - 1, d) - off * 60_000
}

describe('checkinClosesAt: exactly the rules’ upper bound', () => {
  it('a goal created in summer, checked in in winter: the true end of the week', () => {
    const summer = goal({ utcOffsetMin: 120 })
    expect(checkinClosesAt(summer, '2026-11-02')).toBe(Date.parse('2026-11-08T23:00:00Z'))
    expect(checkinClosesAt(summer, '2026-11-02')).toBe(momentAt('2026-11-02', BERLIN, 10080))
  })
  it('a goal created in winter, checked in in summer: 2 hours past the true end', () => {
    const winter = goal({ utcOffsetMin: 60 })
    expect(checkinClosesAt(winter, '2027-06-07')).toBe(Date.parse('2027-06-14T00:00:00Z'))
    expect(checkinClosesAt(winter, '2027-06-07') - momentAt('2027-06-07', BERLIN, 10080)).toBe(2 * H)
  })
  it('NaN for a malformed week', () => {
    expect(checkinClosesAt(goal(), 'next week')).toBeNaN()
  })

  // Two years, every 3 hours and at every week's edges, in zones with 1 h, 30 min and no DST, created in winter and in
  // summer: the week the app saves (goalWeek) is always inside the rules' window, which never closes before the true
  // week ends (nor more than 2 hours after).
  const ZONES = ['Europe/Berlin', 'America/New_York', 'Australia/Sydney', 'Australia/Lord_Howe', 'Asia/Kolkata', 'Pacific/Chatham', 'America/Santiago', 'Pacific/Kiritimati']
  const START = Date.parse('2026-10-05T00:00:00Z')
  const END = START + 2 * 365 * DAY
  for (const tz of ZONES) {
    it(`${tz}: the current week always fits the rules`, () => {
      const offsets = [...new Set([utcOffsetMinutes(tz, Date.parse('2027-01-15T12:00:00Z')), utcOffsetMinutes(tz, Date.parse('2027-07-15T12:00:00Z'))])]
      const bad: string[] = []
      for (const off of offsets) {
        const g = goal({ timezone: tz, utcOffsetMin: off })
        const fits = (now: number) => {
          const weekId = goalWeek(g, now)
          if (!(now >= dayAnchor(weekId, off) - H && now < checkinClosesAt(g, weekId))) bad.push(`${off} ${new Date(now).toISOString()} ${weekId}`)
          return weekId
        }
        for (let now = START; now < END; now += 3 * H) fits(now)
        let weeks = 0
        for (let weekId = '2026-10-05'; weekId < '2028-10-01'; weekId = addWeeks(weekId, 1)) {
          const trueStart = momentAt(weekId, tz, 0)
          const trueEnd = momentAt(weekId, tz, 10080)
          // The week's own edges: its first instant, the next one, and its last.
          for (const now of [trueStart, trueStart + 1, trueEnd - 1]) if (fits(now) !== weekId) bad.push(`${off} ${weekId} edge ${now}`)
          const closes = checkinClosesAt(g, weekId)
          if (!(closes >= trueEnd && closes <= trueEnd + 2 * H)) bad.push(`${off} ${weekId} closes ${closes - trueEnd}`)
          weeks += 1
        }
        // 2026-10-05 … 2028-09-25: 104 Mondays.
        expect(weeks).toBe(104)
      }
      expect(bad).toEqual([])
    })
  }

  it('goalEndsAt never passes the rules’ endsOn bound', () => {
    const bad: string[] = []
    for (const tz of ZONES) {
      for (const off of [utcOffsetMinutes(tz, Date.parse('2027-01-15T12:00:00Z')), utcOffsetMinutes(tz, Date.parse('2027-07-15T12:00:00Z'))]) {
        for (let day = Date.parse('2026-10-01T00:00:00Z'); day < Date.parse('2028-10-01T00:00:00Z'); day += DAY) {
          const endsOn = new Date(day).toISOString().slice(0, 10)
          const endsAt = goalEndsAt(goal({ timezone: tz, utcOffsetMin: off, endsOn }))
          // Never past the rules' bound, and never more than 2 hours (DST) before it.
          if (endsAt === null || endsAt > dayAnchor(endsOn, off) + DAY + H || endsAt < dayAnchor(endsOn, off) + DAY - H) bad.push(`${tz} ${off} ${endsOn}`)
        }
      }
    }
    expect(bad).toEqual([])
  })
})

describe('goalStatus and canCheckIn', () => {
  const endedAt = Date.parse('2026-10-18T22:00:00Z')
  it('finished, then ended, then reached, then active', () => {
    expect(goalStatus(goal(), T)).toBe('active')
    expect(goalStatus(goal({ total: 100 }), T)).toBe('reached')
    expect(goalStatus(goal({ total: 99.99 }), T)).toBe('active')
    expect(goalStatus(goal({ total: 0.1 + 0.2, target: 0.3 }), T)).toBe('reached')
    expect(goalStatus(goal({ total: 120, endsOn: '2026-10-18' }), T)).toBe('ended')
    expect(goalStatus(goal({ total: 120, endsOn: '2026-10-18', archivedAt: T - DAY }), T)).toBe('finished')
    expect(goalStatus(goal({ archivedAt: T - DAY }), T)).toBe('finished')
  })
  it('ends at the start of the day after endsOn', () => {
    const g = goal({ endsOn: '2026-10-18' })
    expect(goalStatus(g, endedAt - 1)).toBe('active')
    expect(goalStatus(g, endedAt)).toBe('ended')
  })
  it('members of goals that are neither finished nor ended (reached ones too)', () => {
    expect(canCheckIn(goal(), 'ben', T)).toBe(true)
    expect(canCheckIn(goal({ total: 140 }), 'ben', T)).toBe(true)
    expect(canCheckIn(goal(), 'dan', T)).toBe(false)
    expect(canCheckIn(goal(), 'stranger', T)).toBe(false)
    expect(canCheckIn(goal({ endsOn: '2026-10-18' }), 'ben', T)).toBe(false)
    expect(canCheckIn(goal({ archivedAt: T - DAY }), 'ben', T)).toBe(false)
  })
})

describe('goalProgress', () => {
  it('ratio capped, what’s left, reached and over', () => {
    expect(goalProgress(goal({ total: 64 }))).toEqual({ total: 64, target: 100, ratio: 0.64, left: 36, reached: false, over: 0 })
    expect(goalProgress(goal({ total: 104 }))).toEqual({ total: 104, target: 100, ratio: 1, left: 0, reached: true, over: 4 })
    expect(goalProgress(goal({ total: 0 }))).toEqual({ total: 0, target: 100, ratio: 0, left: 100, reached: false, over: 0 })
    const exact = goalProgress(goal({ total: 0.1 + 0.2, target: 0.3 }))
    expect(exact.reached).toBe(true)
    expect(exact.left).toBe(0)
    expect(exact.over).toBe(0)
    expect(goalProgress(goal({ total: 30.3, target: 100 })).left).toBe(69.7)
  })
})

describe('goalShares', () => {
  it('everyone with a part, largest first, ties by uid; former members flagged; ratios of the target', () => {
    const g = goal({ totals: { ana: 30, ben: 25, cleo: 0, dan: 10, eve: 25 }, total: 90, memberIds: ['ana', 'ben', 'cleo', 'eve'] })
    const shares = goalShares(g)
    expect(shares.map((s) => [s.uid, s.amount, s.former])).toEqual([
      ['ana', 30, false],
      ['ben', 25, false],
      ['eve', 25, false],
      ['dan', 10, true],
    ])
    expect(shares.map((s) => s.ratio)).toEqual([0.3, 0.25, 0.25, 0.1])
    expect(shares.reduce((s, x) => s + x.ratio, 0)).toBeCloseTo(0.9, 12)
  })
  it('past the target the segments fill the bar exactly', () => {
    const g = goal({ totals: { ana: 90, ben: 60 }, total: 150 })
    const shares = goalShares(g)
    expect(shares.map((s) => s.ratio)).toEqual([0.6, 0.4])
    expect(shares.reduce((s, x) => s + x.ratio, 0)).toBeCloseTo(1, 12)
  })
  it('sums to min(1, total / target) for any parts', () => {
    for (let i = 0; i < 200; i++) {
      const totals: Record<UID, number> = {}
      let total100 = 0
      for (const uid of ['a', 'b', 'c', 'd', 'e']) {
        const n = Math.floor(Math.random() * 5000)
        totals[uid] = n / 100
        total100 += n
      }
      const g = goal({ totals, total: total100 / 100, target: (1 + Math.floor(Math.random() * 20000)) / 100 })
      const sum = goalShares(g).reduce((s, x) => s + x.ratio, 0)
      expect(sum).toBeCloseTo(Math.min(1, g.total / g.target), 9)
    }
  })
  it('nothing yet', () => {
    expect(goalShares(goal())).toEqual([])
  })
})

describe('waitingFor', () => {
  it('current members without a check-in that week', () => {
    const list = [checkin('ana', '2026-10-19', 5), checkin('ben', '2026-10-12', 3), checkin('dan', '2026-10-19', 1)]
    expect(waitingFor(goal(), list, '2026-10-19')).toEqual(['ben', 'cleo'])
    expect(waitingFor(goal(), list, '2026-10-12')).toEqual(['ana', 'cleo'])
    expect(waitingFor(goal(), [], '2026-10-19')).toEqual(['ana', 'ben', 'cleo'])
  })
})

describe('weekProgress: the week’s check-ins and its total', () => {
  it('a row per current member in member order, the week’s total exact, how many checked in', () => {
    const list = [
      checkin('ben', '2026-10-19', 0.1, 'Short one'),
      checkin('ana', '2026-10-19', 0.2),
      checkin('cleo', '2026-10-12', 9),
      checkin('gone', '2026-10-19', 50),
    ]
    const w = weekProgress(goal(), list, '2026-10-19')
    expect(w.rows.map((r) => [r.uid, r.checkin?.amount ?? null])).toEqual([
      ['ana', 0.2],
      ['ben', 0.1],
      ['cleo', null],
    ])
    expect(w.rows[1].checkin?.note).toBe('Short one')
    expect(w.total).toBe(0.3)
    expect(w.done).toBe(2)
    expect(w.weekId).toBe('2026-10-19')
  })
  it('nobody yet: every row open, total 0', () => {
    expect(weekProgress(goal(), [], '2026-10-19')).toEqual({
      weekId: '2026-10-19',
      rows: [
        { uid: 'ana', checkin: null },
        { uid: 'ben', checkin: null },
        { uid: 'cleo', checkin: null },
      ],
      total: 0,
      done: 0,
    })
  })
  it('the week’s totals add up to the goal’s running total over the weeks', () => {
    const weeks = ['2026-10-05', '2026-10-12', '2026-10-19']
    const list = [checkin('ana', weeks[0], 12.5), checkin('ben', weeks[0], 7.25), checkin('ana', weeks[1], 0.1), checkin('cleo', weeks[2], 30.15)]
    const sum100 = weeks.reduce((s, w) => s + toHundredths(weekProgress(goal(), list, w).total), 0)
    expect(sum100).toBe(5000)
    expect(goalProgress(goal({ total: sum100 / 100 })).left).toBe(50)
  })
})

// ---------- applyCheckin against the rules' `checksIn` arithmetic ----------

interface Stored {
  totals100: Record<UID, number>
  total100: number
  target100: number
  reachedAt: number | null
}

const NOW = 777

/** The rules (SPEC §11.5, checksIn): would they accept `d` after `e`, for `me` whose check-in went from before to after? */
function rulesAccept(e: Stored, d: Stored, me: UID, before100: number | null, after100: number): boolean {
  const delta = after100 - (before100 ?? 0)
  const keys = new Set([...Object.keys(e.totals100), ...Object.keys(d.totals100)])
  for (const k of keys) if (k !== me && e.totals100[k] !== d.totals100[k]) return false
  if (d.totals100[me] !== (e.totals100[me] ?? 0) + delta) return false
  if (d.total100 !== e.total100 + delta) return false
  if (!Number.isInteger(d.total100) || !Number.isInteger(d.totals100[me])) return false
  return d.total100 >= d.target100 ? (e.reachedAt !== null ? d.reachedAt === e.reachedAt : d.reachedAt === NOW) : d.reachedAt === null
}

/** What the data layer writes from applyCheckin's answer. */
function write(e: Stored, uid: UID, old100: number, new100: number): Stored {
  const r = applyCheckin(e, uid, old100, new100)
  const reachedAt = r.reached === 'now' ? NOW : r.reached === 'keep' ? e.reachedAt : null
  return { totals100: r.totals100, total100: r.total100, target100: e.target100, reachedAt }
}

describe('applyCheckin', () => {
  const start: Stored = { totals100: {}, total100: 0, target100: 10000, reachedAt: null }

  it('a first check-in', () => {
    const r = applyCheckin(start, 'ana', 0, 3000)
    expect(r).toEqual({ totals100: { ana: 3000 }, total100: 3000, reached: 'none' })
    expect(rulesAccept(start, write(start, 'ana', 0, 3000), 'ana', null, 3000)).toBe(true)
  })
  it('an edit up and an edit down move the total by the difference', () => {
    const e: Stored = { totals100: { ana: 3000, ben: 2500 }, total100: 5500, target100: 10000, reachedAt: null }
    expect(applyCheckin(e, 'ana', 3000, 4000)).toEqual({ totals100: { ana: 4000, ben: 2500 }, total100: 6500, reached: 'none' })
    expect(applyCheckin(e, 'ana', 3000, 1250)).toEqual({ totals100: { ana: 1250, ben: 2500 }, total100: 3750, reached: 'none' })
    expect(rulesAccept(e, write(e, 'ana', 3000, 1250), 'ana', 3000, 1250)).toBe(true)
  })
  it('crossing the target sets reachedAt now; staying reached keeps it', () => {
    const e: Stored = { totals100: { ana: 6000, ben: 2500 }, total100: 8500, target100: 10000, reachedAt: null }
    expect(applyCheckin(e, 'ben', 0, 1500).reached).toBe('now')
    const reached = write(e, 'ben', 0, 1500)
    expect(reached.reachedAt).toBe(NOW)
    expect(rulesAccept(e, reached, 'ben', null, 1500)).toBe(true)
    const stay = { ...reached, reachedAt: 5 }
    expect(applyCheckin(stay, 'cleo', 0, 500).reached).toBe('keep')
    expect(rulesAccept(stay, write(stay, 'cleo', 0, 500), 'cleo', null, 500)).toBe(true)
  })
  it('an edit back below the target clears it', () => {
    const e: Stored = { totals100: { ana: 6000, ben: 4000 }, total100: 10000, target100: 10000, reachedAt: 5 }
    expect(applyCheckin(e, 'ben', 4000, 3999)).toEqual({ totals100: { ana: 6000, ben: 3999 }, total100: 9999, reached: 'none' })
    const d = write(e, 'ben', 4000, 3999)
    expect(d.reachedAt).toBeNull()
    expect(rulesAccept(e, d, 'ben', 4000, 3999)).toBe(true)
  })
  it('a former member’s part stays untouched; an int never drifts', () => {
    const e: Stored = { totals100: { gone: 1010 }, total100: 1010, target100: 10000, reachedAt: null }
    let s = e
    let mine = 0
    for (const amount of [0.1, 0.2, 0.3, 12.5, 0.07]) {
      const n = toHundredths(amount)
      s = write(s, 'ana', mine, mine + n)
      mine += n
    }
    expect(s.totals100).toEqual({ gone: 1010, ana: 1317 })
    expect(s.total100).toBe(2327)
  })
  it('does not change its input', () => {
    const e: Stored = { totals100: { ana: 1 }, total100: 1, target100: 2, reachedAt: null }
    applyCheckin(e, 'ana', 1, 5)
    expect(e).toEqual({ totals100: { ana: 1 }, total100: 1, target100: 2, reachedAt: null })
  })
  it('random weeks of check-ins and edits: every write passes the rules, and the total is the sum of the parts', () => {
    const members = ['ana', 'ben', 'cleo', 'dan']
    for (let run = 0; run < 100; run++) {
      let s: Stored = { totals100: {}, total100: 0, target100: 1 + Math.floor(Math.random() * 20000), reachedAt: null }
      const weekOf: Record<string, number> = {}
      for (let step = 0; step < 40; step++) {
        const uid = members[Math.floor(Math.random() * members.length)]
        const week = Math.floor(step / 10)
        const key = `${week}_${uid}`
        const before = Object.hasOwn(weekOf, key) ? weekOf[key] : null
        const after = Math.floor(Math.random() * 3000)
        const d = write(s, uid, before ?? 0, after)
        expect(rulesAccept(s, d, uid, before, after)).toBe(true)
        weekOf[key] = after
        s = d
        expect(s.total100).toBe(Object.values(s.totals100).reduce((a, b) => a + b, 0))
        expect(s.reachedAt !== null).toBe(s.total100 >= s.target100)
      }
    }
  })
})

describe('openInvites', () => {
  it('invitations to goals that are neither finished nor ended (reached ones count)', () => {
    const invites = [goal({ id: 'a' }), goal({ id: 'b', total: 200 }), goal({ id: 'c', endsOn: '2026-10-18' }), goal({ id: 'd', archivedAt: T - DAY })]
    expect(openInvites({ goals: [], invites }, T).map((g) => g.id)).toEqual(['a', 'b'])
    expect(openInvites({ goals: [goal()], invites: [] }, T)).toEqual([])
  })
})

describe('nextOwner', () => {
  it('the earliest-joined other member; ties by uid; null when nobody remains', () => {
    expect(nextOwner(goal(), 'ana')).toBe('ben')
    expect(nextOwner(goal(), 'ben')).toBe('ana')
    expect(nextOwner(goal({ joinedAt: { ana: 1, ben: 5, cleo: 5 } }), 'ana')).toBe('ben')
    expect(nextOwner(goal({ joinedAt: { ana: 1, ben: 5, cleo: 5 }, memberIds: ['ana', 'cleo', 'ben'] }), 'ana')).toBe('ben')
    expect(nextOwner(goal({ memberIds: ['ana'] }), 'ana')).toBeNull()
    expect(nextOwner(goal({ memberIds: [] }), 'ana')).toBeNull()
  })
  it('a member without a join time comes last', () => {
    expect(nextOwner(goal({ joinedAt: { ana: 1, cleo: 9 } }), 'ana')).toBe('cleo')
    expect(nextOwner(goal({ joinedAt: {}, memberIds: ['ana', 'cleo', 'ben'] }), 'ana')).toBe('ben')
  })
})
