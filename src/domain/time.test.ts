import { describe, expect, it } from 'vitest'
import { DateTime } from 'luxon'
import {
  addMonths,
  addWeeks,
  boundsDiffer,
  DEFAULT_SCHEDULE,
  firstMonthOf,
  formatCountdown,
  formatMonth,
  formatWeekRange,
  isMonthlyReviewWeek,
  lastCompleteMonthCandidate,
  localParts,
  momentAt,
  monthCompleteAt,
  monthIdFor,
  monthIdForWeek,
  monthlyBounds,
  monthlyWeeks,
  utcOffsetMinutes,
  WEEK_MINUTES,
  weekBounds,
  weekIdFor,
  weekIdsInMonth,
  weekPhase,
  type WeekBounds,
} from './time.ts'

const at = (iso: string) => Date.parse(iso)
const H = 3_600_000
const D = 24 * H

function isoBounds(weekId: string, tz: string) {
  const b = weekBounds(weekId, tz)
  return {
    startAt: new Date(b.startAt).toISOString(),
    lockAt: new Date(b.lockAt).toISOString(),
    reviewOpenAt: new Date(b.reviewOpenAt).toISOString(),
    deadlineAt: new Date(b.deadlineAt).toISOString(),
  }
}

describe('weekBounds', () => {
  it('uses local midnights in the space timezone', () => {
    expect(isoBounds('2026-10-12', 'Europe/Paris')).toEqual({
      startAt: '2026-10-11T22:00:00.000Z',
      lockAt: '2026-10-12T22:00:00.000Z',
      reviewOpenAt: '2026-10-15T22:00:00.000Z',
      deadlineAt: '2026-10-16T22:00:00.000Z',
    })
    expect(isoBounds('2026-10-12', 'UTC')).toEqual({
      startAt: '2026-10-12T00:00:00.000Z',
      lockAt: '2026-10-13T00:00:00.000Z',
      reviewOpenAt: '2026-10-16T00:00:00.000Z',
      deadlineAt: '2026-10-17T00:00:00.000Z',
    })
  })

  it('handles half-hour and extreme offsets', () => {
    expect(isoBounds('2026-10-12', 'Asia/Kolkata')).toEqual({
      startAt: '2026-10-11T18:30:00.000Z',
      lockAt: '2026-10-12T18:30:00.000Z',
      reviewOpenAt: '2026-10-15T18:30:00.000Z',
      deadlineAt: '2026-10-16T18:30:00.000Z',
    })
    expect(isoBounds('2026-10-12', 'Pacific/Kiritimati')).toEqual({
      startAt: '2026-10-11T10:00:00.000Z',
      lockAt: '2026-10-12T10:00:00.000Z',
      reviewOpenAt: '2026-10-15T10:00:00.000Z',
      deadlineAt: '2026-10-16T10:00:00.000Z',
    })
    expect(isoBounds('2026-10-12', 'Pacific/Pago_Pago')).toEqual({
      startAt: '2026-10-12T11:00:00.000Z',
      lockAt: '2026-10-13T11:00:00.000Z',
      reviewOpenAt: '2026-10-16T11:00:00.000Z',
      deadlineAt: '2026-10-17T11:00:00.000Z',
    })
  })

  it('America/New_York: DST ends Sunday 2026-11-01, so the next week starts 7d + 1h later', () => {
    expect(isoBounds('2026-10-26', 'America/New_York')).toEqual({
      startAt: '2026-10-26T04:00:00.000Z',
      lockAt: '2026-10-27T04:00:00.000Z',
      reviewOpenAt: '2026-10-30T04:00:00.000Z',
      deadlineAt: '2026-10-31T04:00:00.000Z',
    })
    expect(isoBounds('2026-11-02', 'America/New_York').startAt).toBe('2026-11-02T05:00:00.000Z')
    const gap = weekBounds('2026-11-02', 'America/New_York').startAt - weekBounds('2026-10-26', 'America/New_York').startAt
    expect(gap).toBe(7 * D + H)
  })

  it('Europe/London: DST ends Sunday 2026-10-25', () => {
    expect(isoBounds('2026-10-19', 'Europe/London')).toEqual({
      startAt: '2026-10-18T23:00:00.000Z',
      lockAt: '2026-10-19T23:00:00.000Z',
      reviewOpenAt: '2026-10-22T23:00:00.000Z',
      deadlineAt: '2026-10-23T23:00:00.000Z',
    })
    expect(isoBounds('2026-10-26', 'Europe/London')).toEqual({
      startAt: '2026-10-26T00:00:00.000Z',
      lockAt: '2026-10-27T00:00:00.000Z',
      reviewOpenAt: '2026-10-30T00:00:00.000Z',
      deadlineAt: '2026-10-31T00:00:00.000Z',
    })
  })

  it('Australia/Sydney: DST starts Sunday 2026-10-04, so the next week starts 7d − 1h later', () => {
    expect(isoBounds('2026-09-28', 'Australia/Sydney')).toEqual({
      startAt: '2026-09-27T14:00:00.000Z',
      lockAt: '2026-09-28T14:00:00.000Z',
      reviewOpenAt: '2026-10-01T14:00:00.000Z',
      deadlineAt: '2026-10-02T14:00:00.000Z',
    })
    expect(isoBounds('2026-10-05', 'Australia/Sydney').startAt).toBe('2026-10-04T13:00:00.000Z')
    const gap = weekBounds('2026-10-05', 'Australia/Sydney').startAt - weekBounds('2026-09-28', 'Australia/Sydney').startAt
    expect(gap).toBe(7 * D - H)
  })

  it('Africa/Cairo: DST starts at Friday 00:00, so the review window opens at the first instant of Friday', () => {
    // 2026-04-24 00:00 local does not exist (clocks jump to 01:00); that day is only 23h long.
    const b = weekBounds('2026-04-20', 'Africa/Cairo')
    expect(new Date(b.reviewOpenAt).toISOString()).toBe('2026-04-23T22:00:00.000Z')
    expect(new Date(b.deadlineAt).toISOString()).toBe('2026-04-24T21:00:00.000Z')
    expect(b.deadlineAt - b.reviewOpenAt).toBe(23 * H)
    expect(b.reviewOpenAt - b.startAt).toBe(4 * D)
  })

  it('stays inside the envelope the Firestore rules accept', () => {
    const zones = ['UTC', 'Europe/Paris', 'Asia/Kolkata', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/New_York', 'Australia/Sydney', 'Europe/London', 'Africa/Cairo', 'Australia/Lord_Howe']
    for (const tz of zones) {
      for (let weekId = '2026-01-05'; weekId < '2028-01-01'; weekId = addWeeks(weekId, 1)) {
        const b = weekBounds(weekId, tz)
        expect(Math.abs(b.startAt - at(`${weekId}T00:00:00Z`))).toBeLessThanOrEqual(14 * H)
        expect(Math.abs(b.lockAt - b.startAt - D)).toBeLessThanOrEqual(2 * H)
        expect(Math.abs(b.reviewOpenAt - b.startAt - 4 * D)).toBeLessThanOrEqual(2 * H)
        expect(Math.abs(b.deadlineAt - b.startAt - 5 * D)).toBeLessThanOrEqual(2 * H)
        expect(weekIdFor(b.startAt, tz)).toBe(weekId)
        expect(weekIdFor(b.startAt - 1, tz)).toBe(addWeeks(weekId, -1))
        expect(weekIdFor(b.deadlineAt, tz)).toBe(weekId)
      }
    }
  })

  it('rejects malformed ids and unknown zones', () => {
    expect(() => weekBounds('2026-13-01', 'UTC')).toThrow(RangeError)
    expect(() => weekBounds('2026-10-12T00:00', 'UTC')).toThrow(RangeError)
    expect(() => weekBounds('2026-10-12', 'Mars/Olympus')).toThrow(RangeError)
    expect(() => weekIdFor(0, 'Mars/Olympus')).toThrow(RangeError)
  })
})

describe('utcOffsetMinutes and boundsDiffer', () => {
  it('reads the zone offset at an instant, DST included', () => {
    expect(utcOffsetMinutes('Europe/Berlin', at('2026-07-01T12:00Z'))).toBe(120)
    expect(utcOffsetMinutes('Europe/Berlin', at('2026-12-01T12:00Z'))).toBe(60)
    expect(utcOffsetMinutes('America/Los_Angeles', at('2026-07-01T12:00Z'))).toBe(-420)
    expect(utcOffsetMinutes('Asia/Kolkata', at('2026-07-01T12:00Z'))).toBe(330)
    expect(utcOffsetMinutes('Pacific/Kiritimati', at('2026-07-01T12:00Z'))).toBe(840)
  })

  it('flags bounds more than an hour apart', () => {
    const b = weekBounds('2026-10-12', 'Europe/Berlin')
    expect(boundsDiffer(b, b)).toBe(false)
    expect(boundsDiffer(b, { ...b, deadlineAt: b.deadlineAt + H })).toBe(false)
    expect(boundsDiffer(b, { ...b, lockAt: b.lockAt - H - 1 })).toBe(true)
    expect(boundsDiffer(b, weekBounds('2026-10-12', 'America/Los_Angeles'))).toBe(true)
  })
})

// Mirrors validNewWeek in firestore.rules: startAt within 1h of Monday 00:00 UTC minus the space's
// stored offset, every other bound within 1h of whole days after startAt.
function rulesAccept(weekId: string, b: ReturnType<typeof weekBounds>, utcOffsetMin: number): boolean {
  const near = (t: number, target: number) => Math.abs(t - target) <= H
  const anchor = at(`${weekId}T00:00:00Z`) - utcOffsetMin * 60_000
  return near(b.startAt, anchor) && near(b.lockAt, b.startAt + D) && near(b.reviewOpenAt, b.startAt + 4 * D) && near(b.deadlineAt, b.startAt + 5 * D)
}

describe('week bounds vs the rules anchor', () => {
  // Zones with DST on a weekday (Cairo, Santiago, Asuncion), half-hour DST (Lord Howe), :45 offsets
  // (Chatham), the extremes (Kiritimati +14, Pago Pago −11) and the usual suspects.
  const zones = [
    'America/Los_Angeles', 'America/New_York', 'Europe/Berlin', 'Europe/London', 'Australia/Sydney', 'Australia/Lord_Howe',
    'Asia/Kolkata', 'Asia/Kathmandu', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Pacific/Chatham', 'Africa/Cairo',
    'America/Santiago', 'America/Asuncion', 'Asia/Tehran', 'UTC',
  ]
  const weeks: string[] = []
  for (let w = '2026-01-05'; w < '2029-01-01'; w = addWeeks(w, 1)) weeks.push(w)

  it.each(zones)('accepts every real week of 2026-2028 in %s, whichever offset the space was created with', (zone) => {
    // Every offset the zone has over the period is a possible creation offset.
    const offsets = [...new Set(weeks.map((w) => utcOffsetMinutes(zone, at(`${w}T12:00:00Z`))))]
    const rejected = weeks.flatMap((w) => offsets.filter((off) => !rulesAccept(w, weekBounds(w, zone), off)).map((off) => `${w}@${off}`))
    expect(rejected).toEqual([])
  })

  it('rejects the skews the old ±14h window allowed', () => {
    const w = '2026-10-12'
    const la = weekBounds(w, 'America/Los_Angeles')
    const shift = (b: typeof la, ms: number) => ({ startAt: b.startAt + ms, lockAt: b.lockAt + ms, reviewOpenAt: b.reviewOpenAt + ms, deadlineAt: b.deadlineAt + ms })
    expect(rulesAccept(w, la, -420)).toBe(true)
    // UTC midnight − 14h with every bound − 2h: the lock lands 23h early in Los Angeles.
    const utcMinus14 = at(`${w}T00:00:00Z`) - 14 * H
    expect(rulesAccept(w, { startAt: utcMinus14, lockAt: utcMinus14 + D - 2 * H, reviewOpenAt: utcMinus14 + 4 * D - 2 * H, deadlineAt: utcMinus14 + 5 * D - 2 * H }, -420)).toBe(false)
    expect(rulesAccept(w, shift(la, -2 * H), -420)).toBe(false)
    expect(rulesAccept(w, shift(la, H + 60_000), -420)).toBe(false)
    expect(rulesAccept(w, { ...la, deadlineAt: la.deadlineAt - 2 * H }, -420)).toBe(false)
  })
})

describe('weekIdFor', () => {
  it('is Monday-based on the local date', () => {
    expect(weekIdFor(at('2026-10-12T00:00:00Z'), 'UTC')).toBe('2026-10-12')
    expect(weekIdFor(at('2026-10-16T12:00:00Z'), 'UTC')).toBe('2026-10-12')
    expect(weekIdFor(at('2026-10-18T23:59:59.999Z'), 'UTC')).toBe('2026-10-12')
    expect(weekIdFor(at('2026-10-19T00:00:00Z'), 'UTC')).toBe('2026-10-19')
  })

  it('uses the local date, not the UTC date', () => {
    // Sunday 12:00 UTC is already Monday 02:00 in Kiritimati and still Sunday 01:00 in Pago Pago.
    const sundayNoon = at('2026-10-11T12:00:00Z')
    expect(weekIdFor(sundayNoon, 'UTC')).toBe('2026-10-05')
    expect(weekIdFor(sundayNoon, 'Pacific/Kiritimati')).toBe('2026-10-12')
    expect(weekIdFor(sundayNoon, 'Pacific/Pago_Pago')).toBe('2026-10-05')
    expect(weekIdFor(at('2026-10-11T18:29:59.999Z'), 'Asia/Kolkata')).toBe('2026-10-05')
    expect(weekIdFor(at('2026-10-11T18:30:00Z'), 'Asia/Kolkata')).toBe('2026-10-12')
    expect(weekIdFor(at('2026-10-12T10:59:59.999Z'), 'Pacific/Pago_Pago')).toBe('2026-10-05')
    expect(weekIdFor(at('2026-10-12T11:00:00Z'), 'Pacific/Pago_Pago')).toBe('2026-10-12')
  })

  it('handles the repeated hour when DST ends', () => {
    // Sunday 2026-11-01 01:30 happens twice in New York; both belong to the week of Oct 26.
    expect(weekIdFor(at('2026-11-01T05:30:00Z'), 'America/New_York')).toBe('2026-10-26')
    expect(weekIdFor(at('2026-11-01T06:30:00Z'), 'America/New_York')).toBe('2026-10-26')
    expect(weekIdFor(at('2026-11-02T04:59:59.999Z'), 'America/New_York')).toBe('2026-10-26')
    expect(weekIdFor(at('2026-11-02T05:00:00Z'), 'America/New_York')).toBe('2026-11-02')
    expect(weekIdFor(at('2026-10-25T23:59:59.999Z'), 'Europe/London')).toBe('2026-10-19')
    expect(weekIdFor(at('2026-10-26T00:00:00Z'), 'Europe/London')).toBe('2026-10-26')
  })

  it('crosses years', () => {
    expect(weekIdFor(at('2027-01-01T12:00:00Z'), 'UTC')).toBe('2026-12-28')
    expect(weekIdFor(at('2027-01-03T23:00:00Z'), 'UTC')).toBe('2026-12-28')
  })
})

describe('weekPhase', () => {
  const b = weekBounds('2026-10-12', 'Europe/Paris')
  it('switches exactly at each boundary', () => {
    expect(weekPhase(b, b.startAt - 7 * D)).toBe('planning')
    expect(weekPhase(b, b.startAt)).toBe('planning')
    expect(weekPhase(b, b.lockAt - 1)).toBe('planning')
    expect(weekPhase(b, b.lockAt)).toBe('active')
    expect(weekPhase(b, b.reviewOpenAt - 1)).toBe('active')
    expect(weekPhase(b, b.reviewOpenAt)).toBe('review')
    expect(weekPhase(b, b.deadlineAt - 1)).toBe('review')
    expect(weekPhase(b, b.deadlineAt)).toBe('closed')
    expect(weekPhase(b, b.deadlineAt + 30 * D)).toBe('closed')
  })
  it('follows local midnight in the space zone', () => {
    // Paris is UTC+2 in October: the list locks at Monday 22:00 UTC.
    expect(weekPhase(b, at('2026-10-12T21:59:59.999Z'))).toBe('planning')
    expect(weekPhase(b, at('2026-10-12T22:00:00Z'))).toBe('active')
  })
})

describe('calendar math', () => {
  it('addWeeks is pure date arithmetic', () => {
    expect(addWeeks('2026-10-12', 1)).toBe('2026-10-19')
    expect(addWeeks('2026-10-26', 1)).toBe('2026-11-02')
    expect(addWeeks('2026-12-28', 1)).toBe('2027-01-04')
    expect(addWeeks('2026-10-12', -2)).toBe('2026-09-28')
    expect(addWeeks('2026-10-12', 0)).toBe('2026-10-12')
    expect(addWeeks('2026-03-23', 2)).toBe('2026-04-06')
  })

  it('a week belongs to the month of its Friday', () => {
    expect(monthIdForWeek('2026-09-28')).toBe('2026-10')
    expect(monthIdForWeek('2026-10-26')).toBe('2026-10')
    expect(monthIdForWeek('2026-11-30')).toBe('2026-12')
    expect(monthIdForWeek('2026-12-28')).toBe('2027-01')
    expect(monthIdForWeek('2027-01-25')).toBe('2027-01')
  })

  it('monthIdFor uses the local date', () => {
    const instant = at('2026-11-01T03:30:00Z')
    expect(monthIdFor(instant, 'America/New_York')).toBe('2026-10')
    expect(monthIdFor(instant, 'Europe/London')).toBe('2026-11')
    expect(monthIdFor(at('2026-12-31T10:00:00Z'), 'Pacific/Kiritimati')).toBe('2027-01')
    expect(monthIdFor(at('2027-01-01T10:00:00Z'), 'Pacific/Pago_Pago')).toBe('2026-12')
  })

  it('addMonths wraps years', () => {
    expect(addMonths('2026-10', 1)).toBe('2026-11')
    expect(addMonths('2026-12', 1)).toBe('2027-01')
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(addMonths('2026-10', -10)).toBe('2025-12')
    expect(addMonths('2026-10', 15)).toBe('2028-01')
    expect(addMonths('2026-10', 0)).toBe('2026-10')
    expect(() => addMonths('2026-1', 1)).toThrow(RangeError)
  })

  it('weekIdsInMonth lists every Monday whose Friday is in the month', () => {
    expect(weekIdsInMonth('2026-10')).toEqual(['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'])
    expect(weekIdsInMonth('2026-11')).toEqual(['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23'])
    expect(weekIdsInMonth('2026-12')).toEqual(['2026-11-30', '2026-12-07', '2026-12-14', '2026-12-21'])
    expect(weekIdsInMonth('2027-01')).toEqual(['2026-12-28', '2027-01-04', '2027-01-11', '2027-01-18', '2027-01-25'])
    expect(weekIdsInMonth('2028-02')).toEqual(['2028-01-31', '2028-02-07', '2028-02-14', '2028-02-21'])
  })

  it('months partition the weeks with no gaps or overlaps', () => {
    let expected = weekIdsInMonth('2025-12')[0]
    for (let month = '2025-12'; month <= '2029-12'; month = addMonths(month, 1)) {
      const ids = weekIdsInMonth(month)
      expect(ids.length === 4 || ids.length === 5).toBe(true)
      for (const id of ids) {
        expect(id).toBe(expected)
        expect(monthIdForWeek(id)).toBe(month)
        expected = addWeeks(id, 1)
      }
    }
  })

  it('monthCompleteAt is the deadline of the last week', () => {
    expect(new Date(monthCompleteAt('2026-10', 'America/New_York')).toISOString()).toBe('2026-10-31T04:00:00.000Z')
    expect(new Date(monthCompleteAt('2026-12', 'Europe/Paris')).toISOString()).toBe('2026-12-25T23:00:00.000Z')
    expect(new Date(monthCompleteAt('2027-01', 'Pacific/Kiritimati')).toISOString()).toBe('2027-01-29T10:00:00.000Z')
    expect(monthCompleteAt('2026-10', 'Asia/Kolkata')).toBe(weekBounds('2026-10-26', 'Asia/Kolkata').deadlineAt)
  })
})

describe('localParts', () => {
  it('returns local wall-clock parts with Monday = 1', () => {
    expect(localParts(at('2026-10-11T10:00:00Z'), 'Pacific/Kiritimati')).toEqual({ weekday: 1, hour: 0, day: 12, month: 10, year: 2026 })
    expect(localParts(at('2026-10-11T10:00:00Z'), 'Pacific/Pago_Pago')).toEqual({ weekday: 6, hour: 23, day: 10, month: 10, year: 2026 })
    expect(localParts(at('2026-10-18T12:00:00Z'), 'UTC').weekday).toBe(7)
    expect(localParts(at('2026-10-16T14:30:00Z'), 'Asia/Kolkata')).toEqual({ weekday: 5, hour: 20, day: 16, month: 10, year: 2026 })
  })
  it('reports the repeated hour twice when DST ends', () => {
    expect(localParts(at('2026-11-01T05:30:00Z'), 'America/New_York').hour).toBe(1)
    expect(localParts(at('2026-11-01T06:30:00Z'), 'America/New_York').hour).toBe(1)
  })
})

describe('formatCountdown', () => {
  const M = 60_000
  it('formats compact durations, rounding down', () => {
    expect(formatCountdown(2 * D + 4 * H)).toBe('2d 4h')
    expect(formatCountdown(2 * D + 4 * H + 59 * M + 59_000)).toBe('2d 4h')
    expect(formatCountdown(5 * H + 12 * M)).toBe('5h 12m')
    expect(formatCountdown(12 * M)).toBe('12m')
    expect(formatCountdown(12 * M + 59_999)).toBe('12m')
    expect(formatCountdown(M)).toBe('1m')
  })
  it('drops zero second units', () => {
    expect(formatCountdown(2 * D)).toBe('2d')
    expect(formatCountdown(D + 30 * M)).toBe('1d')
    expect(formatCountdown(5 * H)).toBe('5h')
  })
  it('handles the last minute and the past', () => {
    expect(formatCountdown(59_999)).toBe('<1m')
    expect(formatCountdown(1)).toBe('<1m')
    expect(formatCountdown(0)).toBe('0m')
    expect(formatCountdown(-5 * M)).toBe('0m')
    expect(formatCountdown(Number.NaN)).toBe('0m')
  })
})

describe('formatting', () => {
  it('formatWeekRange shows Monday to Friday', () => {
    expect(formatWeekRange('2026-10-12')).toBe('Oct 12 – 16')
    expect(formatWeekRange('2026-09-28')).toBe('Sep 28 – Oct 2')
    expect(formatWeekRange('2026-12-28')).toBe('Dec 28 – Jan 1')
    expect(formatWeekRange('2026-10-12', 'en-US')).toBe('Oct 12 – 16')
  })
  it('formatWeekRange localizes other locales', () => {
    expect(formatWeekRange('2026-10-12', 'en-GB')).toMatch(/12.*16.*Oct/)
  })
  it('formatMonth', () => {
    expect(formatMonth('2026-10')).toBe('October 2026')
    expect(formatMonth('2027-01')).toBe('January 2027')
  })
})

// ---------- Batch 2 (SPEC §9.2, §9.5, §9.8) ----------

/** weekBounds exactly as it was before batch 2: whole local days through startOf('day'). The usual schedule must
 *  give this, byte for byte, in every zone. */
function legacyWeekBounds(weekId: string, tz: string): WeekBounds {
  const date = DateTime.fromISO(weekId, { zone: 'utc' })
  const monday = DateTime.fromObject({ year: date.year, month: date.month, day: date.day }, { zone: tz })
  const dayStart = (days: number) => monday.plus({ days }).startOf('day').toMillis()
  return { startAt: dayStart(0), lockAt: dayStart(1), reviewOpenAt: dayStart(4), deadlineAt: dayStart(5) }
}

const iso = (ms: number) => new Date(ms).toISOString()

describe('the usual schedule is unchanged', () => {
  const zones = [
    'Europe/Berlin', 'America/Los_Angeles', 'Australia/Sydney', 'Asia/Kolkata', 'America/Santiago', 'Asia/Beirut', 'Australia/Lord_Howe',
    'Pacific/Kiritimati', 'Pacific/Chatham', 'Africa/Cairo', 'America/Asuncion', 'Asia/Tehran', 'America/New_York', 'Europe/London', 'UTC',
  ]

  it('DEFAULT_SCHEDULE and WEEK_MINUTES', () => {
    expect(DEFAULT_SCHEDULE).toEqual({ lock: 1440, reviewOpen: 5760, deadline: 7200 })
    expect(Object.isFrozen(DEFAULT_SCHEDULE)).toBe(true)
    expect(WEEK_MINUTES).toBe(7 * 1440)
  })

  it.each(zones)('weekBounds with and without the usual schedule equals the pre-batch-2 output in %s (2026–2027)', (tz) => {
    for (let w = '2026-01-05'; w < '2028-01-01'; w = addWeeks(w, 1)) {
      const legacy = legacyWeekBounds(w, tz)
      expect(weekBounds(w, tz)).toEqual(legacy)
      expect(weekBounds(w, tz, DEFAULT_SCHEDULE)).toEqual(legacy)
      expect(weekBounds(w, tz, { lock: 1440, reviewOpen: 5760, deadline: 7200 })).toEqual(legacy)
      // Whole days of momentAt are those same local day starts, the next Monday included.
      expect(momentAt(w, tz, 0)).toBe(legacy.startAt)
      expect(momentAt(w, tz, WEEK_MINUTES)).toBe(legacyWeekBounds(addWeeks(w, 1), tz).startAt)
    }
  })

  it.each(zones)('monthCompleteAt without a schedule or a stored week equals the pre-batch-2 output in %s', (tz) => {
    for (let m = '2026-01'; m < '2028-01'; m = addMonths(m, 1)) {
      const ids = weekIdsInMonth(m)
      expect(monthCompleteAt(m, tz)).toBe(legacyWeekBounds(ids[ids.length - 1], tz).deadlineAt)
    }
  })
})

describe('momentAt (wall-clock minutes after Monday 00:00)', () => {
  it('times of day on the space clock', () => {
    // Monday at 8:00 PM, Friday at 6:00 PM, Saturday at noon (Berlin, summer time until Oct 25).
    expect(iso(momentAt('2026-10-12', 'Europe/Berlin', 1200))).toBe('2026-10-12T18:00:00.000Z')
    expect(iso(momentAt('2026-10-12', 'Europe/Berlin', 4 * 1440 + 1080))).toBe('2026-10-16T16:00:00.000Z')
    expect(iso(momentAt('2026-10-12', 'Europe/Berlin', 5 * 1440 + 720))).toBe('2026-10-17T10:00:00.000Z')
    // After the change to winter time inside the week (Sunday Oct 25), the same wall clock is an hour later in UTC.
    expect(iso(momentAt('2026-10-19', 'Europe/Berlin', 6 * 1440 + 720))).toBe('2026-10-25T11:00:00.000Z')
    expect(iso(momentAt('2026-10-12', 'Asia/Kolkata', 30))).toBe('2026-10-11T19:00:00.000Z')
    expect(iso(momentAt('2026-10-12', 'Australia/Lord_Howe', 1470))).toBe(iso(DateTime.fromISO('2026-10-13T00:30', { zone: 'Australia/Lord_Howe' }).toMillis()))
  })

  it('a time in a spring-forward gap moves forward (New York, 2026-03-08 02:30 → 03:30)', () => {
    // Sunday of the week of Monday 2026-03-02, 02:30 local doesn't exist.
    expect(iso(momentAt('2026-03-02', 'America/New_York', 6 * 1440 + 150))).toBe('2026-03-08T07:30:00.000Z')
    // 01:30 is still before the gap (EST); 03:30 after it (EDT): the gap time lands on 03:30 too.
    expect(iso(momentAt('2026-03-02', 'America/New_York', 6 * 1440 + 90))).toBe('2026-03-08T06:30:00.000Z')
    expect(iso(momentAt('2026-03-02', 'America/New_York', 6 * 1440 + 210))).toBe('2026-03-08T07:30:00.000Z')
  })

  it('an ambiguous fall-back time takes its first occurrence (New York, 2026-11-01 01:30 → −04:00)', () => {
    expect(iso(momentAt('2026-10-26', 'America/New_York', 6 * 1440 + 90))).toBe('2026-11-01T05:30:00.000Z')
    // 02:30 is after the repeat (EST).
    expect(iso(momentAt('2026-10-26', 'America/New_York', 6 * 1440 + 150))).toBe('2026-11-01T07:30:00.000Z')
  })

  it('a skipped midnight (Santiago, 2026-09-06 starts at 01:00): the end of Saturday is the first instant of Sunday', () => {
    // Clocks jump from Saturday 24:00 (−04) to Sunday 01:00 (−03).
    const saturdayMidnight = momentAt('2026-08-31', 'America/Santiago', 6 * 1440)
    expect(iso(saturdayMidnight)).toBe('2026-09-06T04:00:00.000Z')
    expect(saturdayMidnight).toBe(DateTime.fromISO('2026-09-06', { zone: 'America/Santiago' }).startOf('day').toMillis())
    // Sunday 00:30 is in the gap: it moves forward to 01:30.
    expect(iso(momentAt('2026-08-31', 'America/Santiago', 6 * 1440 + 30))).toBe('2026-09-06T04:30:00.000Z')
    // A schedule whose reviews are due Saturday at midnight that week: due at that first instant of Sunday.
    expect(weekBounds('2026-08-31', 'America/Santiago', { lock: 1440, reviewOpen: 5760, deadline: 6 * 1440 }).deadlineAt).toBe(saturdayMidnight)
  })

  it('minutes below 0 and from WEEK_MINUTES on roll into the neighbouring weeks', () => {
    expect(iso(momentAt('2026-10-12', 'UTC', -60))).toBe('2026-10-11T23:00:00.000Z')
    expect(momentAt('2026-10-12', 'Europe/Berlin', -1440)).toBe(momentAt('2026-10-05', 'Europe/Berlin', 6 * 1440))
    expect(momentAt('2026-10-12', 'Europe/Berlin', -30)).toBe(momentAt('2026-10-05', 'Europe/Berlin', WEEK_MINUTES - 30))
    expect(momentAt('2026-10-12', 'Europe/Berlin', WEEK_MINUTES)).toBe(weekBounds('2026-10-19', 'Europe/Berlin').startAt)
    expect(momentAt('2026-10-12', 'Europe/Berlin', WEEK_MINUTES + 1440)).toBe(weekBounds('2026-10-19', 'Europe/Berlin').lockAt)
    expect(momentAt('2026-10-12', 'Europe/Berlin', WEEK_MINUTES + 90)).toBe(momentAt('2026-10-19', 'Europe/Berlin', 90))
  })

  it('rejects minutes that aren’t a number', () => {
    expect(() => momentAt('2026-10-12', 'UTC', Number.NaN)).toThrow(RangeError)
    expect(() => momentAt('2026-10-12', 'UTC', Infinity)).toThrow(RangeError)
    expect(() => momentAt('2026-13-12', 'UTC', 0)).toThrow(RangeError)
  })

  it('weekBounds on a custom schedule', () => {
    // Lists lock Monday at 8:00 PM, reviews open Thursday at midnight and are due Saturday at noon.
    const b = weekBounds('2026-10-12', 'Europe/Berlin', { lock: 1200, reviewOpen: 5760, deadline: 7920 })
    expect(iso(b.startAt)).toBe('2026-10-11T22:00:00.000Z')
    expect(iso(b.lockAt)).toBe('2026-10-12T18:00:00.000Z')
    expect(iso(b.reviewOpenAt)).toBe('2026-10-15T22:00:00.000Z')
    expect(iso(b.deadlineAt)).toBe('2026-10-17T10:00:00.000Z')
    // The earliest lock (Sunday at midnight, m = 0) is the week's start; the latest deadline the next Monday.
    const edge = weekBounds('2026-10-12', 'Europe/Berlin', { lock: 0, reviewOpen: 5760, deadline: WEEK_MINUTES })
    expect(edge.lockAt).toBe(edge.startAt)
    expect(edge.deadlineAt).toBe(weekBounds('2026-10-19', 'Europe/Berlin').startAt)
  })
})

describe('monthCompleteAt with a schedule and a stored week', () => {
  it('computed on the schedule without a doc; the stored deadline when given', () => {
    const saturdayNoon = { lock: 1440, reviewOpen: 5760, deadline: 7920 }
    expect(iso(monthCompleteAt('2026-10', 'Europe/Berlin', saturdayNoon))).toBe('2026-10-31T11:00:00.000Z')
    const stored = { deadlineAt: Date.parse('2026-10-31T09:30:00Z') }
    expect(monthCompleteAt('2026-10', 'Europe/Berlin', saturdayNoon, stored)).toBe(stored.deadlineAt)
    expect(monthCompleteAt('2026-10', 'Europe/Berlin', undefined, stored)).toBe(stored.deadlineAt)
    expect(monthCompleteAt('2026-10', 'Europe/Berlin', DEFAULT_SCHEDULE, null)).toBe(weekBounds('2026-10-26', 'Europe/Berlin').deadlineAt)
  })
})

describe('monthly lists: monthlyWeeks, monthlyBounds, isMonthlyReviewWeek', () => {
  it('the first week, the second (its lock) and the last, for months starting on any day', () => {
    // The 1st on a Thursday (5 weeks), a Monday, a Friday, a Saturday, a Sunday; across New Year; a 4-week February.
    expect(monthlyWeeks('2026-10')).toEqual({ first: '2026-09-28', lock: '2026-10-05', last: '2026-10-26' })
    expect(monthlyWeeks('2026-06')).toEqual({ first: '2026-06-01', lock: '2026-06-08', last: '2026-06-22' })
    expect(monthlyWeeks('2026-05')).toEqual({ first: '2026-04-27', lock: '2026-05-04', last: '2026-05-25' })
    expect(monthlyWeeks('2026-08')).toEqual({ first: '2026-08-03', lock: '2026-08-10', last: '2026-08-24' })
    expect(monthlyWeeks('2026-11')).toEqual({ first: '2026-11-02', lock: '2026-11-09', last: '2026-11-23' })
    expect(monthlyWeeks('2027-01')).toEqual({ first: '2026-12-28', lock: '2027-01-04', last: '2027-01-25' })
    expect(monthlyWeeks('2027-02')).toEqual({ first: '2027-02-01', lock: '2027-02-08', last: '2027-02-22' })
    expect(weekIdsInMonth('2027-02')).toHaveLength(4)
    expect(weekIdsInMonth('2026-10')).toHaveLength(5)
  })

  it('usual times, October 2026 in Berlin: Mon Sep 28 00:00; Tue Oct 6 00:00; Fri Oct 30 00:00 → Sat Oct 31 00:00', () => {
    const b = monthlyBounds('2026-10', (w) => weekBounds(w, 'Europe/Berlin'))
    expect({ startAt: iso(b.startAt), lockAt: iso(b.lockAt), reviewOpenAt: iso(b.reviewOpenAt), deadlineAt: iso(b.deadlineAt) }).toEqual({
      startAt: '2026-09-27T22:00:00.000Z',
      lockAt: '2026-10-05T22:00:00.000Z',
      // Winter time from Oct 25.
      reviewOpenAt: '2026-10-29T23:00:00.000Z',
      deadlineAt: '2026-10-30T23:00:00.000Z',
    })
  })

  it('Los Angeles in November (DST ended Nov 1) and Berlin in March, on a custom schedule', () => {
    const la = monthlyBounds('2026-11', (w) => weekBounds(w, 'America/Los_Angeles'))
    expect([iso(la.startAt), iso(la.lockAt), iso(la.reviewOpenAt), iso(la.deadlineAt)]).toEqual([
      '2026-11-02T08:00:00.000Z',
      '2026-11-10T08:00:00.000Z',
      '2026-11-27T08:00:00.000Z',
      '2026-11-28T08:00:00.000Z',
    ])
    const s = { lock: 1200, reviewOpen: 4 * 1440 + 1080, deadline: 6 * 1440 }
    const berlin = monthlyBounds('2027-03', (w) => weekBounds(w, 'Europe/Berlin', s))
    expect([iso(berlin.startAt), iso(berlin.lockAt), iso(berlin.reviewOpenAt), iso(berlin.deadlineAt)]).toEqual([
      '2027-02-28T23:00:00.000Z',
      '2027-03-08T19:00:00.000Z',
      '2027-03-26T17:00:00.000Z',
      '2027-03-27T23:00:00.000Z',
    ])
  })

  it('takes each week’s bounds from the given function (stored when the doc exists)', () => {
    const stored: Record<string, WeekBounds> = { '2026-10-05': { startAt: 1, lockAt: 2, reviewOpenAt: 3, deadlineAt: 4 }, '2026-10-26': { startAt: 5, lockAt: 6, reviewOpenAt: 7, deadlineAt: 8 } }
    const b = monthlyBounds('2026-10', (w) => stored[w] ?? weekBounds(w, 'UTC'))
    expect(b).toEqual({ startAt: weekBounds('2026-09-28', 'UTC').startAt, lockAt: 2, reviewOpenAt: 7, deadlineAt: 8 })
  })

  it('isMonthlyReviewWeek: only the month’s last week', () => {
    expect(isMonthlyReviewWeek('2026-10-26')).toBe(true)
    expect(isMonthlyReviewWeek('2026-10-19')).toBe(false)
    expect(isMonthlyReviewWeek('2026-11-23')).toBe(true)
    expect(isMonthlyReviewWeek('2026-11-30')).toBe(false)
    expect(isMonthlyReviewWeek('2026-12-21')).toBe(true)
    expect(isMonthlyReviewWeek('2026-12-28')).toBe(false)
  })
})

describe('lastCompleteMonthCandidate', () => {
  it('the latest month whose last week is before this week', () => {
    // Mid-October: September (its last week is Sep 21).
    expect(lastCompleteMonthCandidate(at('2026-10-14T12:00:00Z'), 'Europe/Berlin')).toBe('2026-09')
    // October's last week is Oct 26: still September on the Saturday and Sunday after it, October from Monday.
    expect(lastCompleteMonthCandidate(at('2026-10-31T12:00:00Z'), 'Europe/Berlin')).toBe('2026-09')
    expect(lastCompleteMonthCandidate(at('2026-11-01T22:00:00Z'), 'Europe/Berlin')).toBe('2026-09')
    expect(lastCompleteMonthCandidate(at('2026-11-01T23:00:00Z'), 'Europe/Berlin')).toBe('2026-10')
    expect(lastCompleteMonthCandidate(at('2026-11-20T12:00:00Z'), 'Europe/Berlin')).toBe('2026-10')
  })

  it('around New Year (the week of Dec 28 is January’s)', () => {
    expect(lastCompleteMonthCandidate(at('2026-12-27T12:00:00Z'), 'Europe/Berlin')).toBe('2026-11')
    expect(lastCompleteMonthCandidate(at('2027-01-01T12:00:00Z'), 'Europe/Berlin')).toBe('2026-12')
    expect(lastCompleteMonthCandidate(at('2027-01-04T12:00:00Z'), 'Europe/Berlin')).toBe('2026-12')
    expect(lastCompleteMonthCandidate(at('2027-02-01T12:00:00Z'), 'Europe/Berlin')).toBe('2027-01')
  })

  it('in the space’s zone, across a DST change', () => {
    // Monday Nov 2 00:30 in Berlin (winter time) is still Sunday Nov 1 in UTC and in Los Angeles.
    const ms = at('2026-11-01T23:30:00Z')
    expect(lastCompleteMonthCandidate(ms, 'Europe/Berlin')).toBe('2026-10')
    expect(lastCompleteMonthCandidate(ms, 'UTC')).toBe('2026-09')
    expect(lastCompleteMonthCandidate(ms, 'America/Los_Angeles')).toBe('2026-09')
    // Every result's last week ends before the week holding `now`.
    for (let ms2 = at('2026-01-01T00:00:00Z'); ms2 < at('2028-01-01T00:00:00Z'); ms2 += 13 * H) {
      for (const tz of ['Europe/Berlin', 'Pacific/Kiritimati', 'America/Santiago']) {
        const m = lastCompleteMonthCandidate(ms2, tz)
        const ids = weekIdsInMonth(m)
        expect(ids[ids.length - 1] < weekIdFor(ms2, tz)).toBe(true)
        const next = weekIdsInMonth(addMonths(m, 1))
        expect(next[next.length - 1] >= weekIdFor(ms2, tz)).toBe(true)
        expect(weekBounds(ids[ids.length - 1], tz).deadlineAt).toBeLessThanOrEqual(ms2)
      }
    }
  })
})

describe('firstMonthOf', () => {
  it('the month of the creation week’s Friday, in the space’s zone', () => {
    const created = at('2026-09-27T23:00:00Z')
    // Monday Sep 28 01:00 in Berlin: the week of Sep 28, whose Friday is Oct 2.
    expect(firstMonthOf({ timezone: 'Europe/Berlin', createdAt: created })).toBe('2026-10')
    // Sunday Sep 27 in New York: the week of Sep 21.
    expect(firstMonthOf({ timezone: 'America/New_York', createdAt: created })).toBe('2026-09')
  })

  it('null without a usable createdAt or zone', () => {
    expect(firstMonthOf({ timezone: 'Europe/Berlin', createdAt: 0 })).toBeNull()
    expect(firstMonthOf({ timezone: 'Europe/Berlin', createdAt: Number.NaN })).toBeNull()
    expect(firstMonthOf({ timezone: 'Mars/Olympus', createdAt: at('2026-10-01T00:00:00Z') })).toBeNull()
  })
})
