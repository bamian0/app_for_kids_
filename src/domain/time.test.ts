import { describe, expect, it } from 'vitest'
import {
  addMonths,
  addWeeks,
  formatCountdown,
  formatMonth,
  formatWeekRange,
  localParts,
  monthCompleteAt,
  monthIdFor,
  monthIdForWeek,
  weekBounds,
  weekIdFor,
  weekIdsInMonth,
  weekPhase,
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
