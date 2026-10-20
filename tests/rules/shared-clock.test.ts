// A shared goal's week and end date on fixed calendar dates: goals created in one season and checked
// in in another, DST weeks, zones at both ends of the clock. The emulator's request.time is the real
// clock, so these run the published rules with one change: in inGoalWeek, "now" is the goal doc's
// `testNow` (seeded) instead of request.time. Everything else (the anchor from the stored offset, the
// hour of slack, the end date) is the published code.
import { describe, expect, test } from 'vitest'
import { DateTime } from 'luxon'
import { doc, serverTimestamp, writeBatch, type DocumentData } from 'firebase/firestore'
import { checkinClosesAt } from '../../src/domain/shared.ts'
import { addDays, allowed, anchorOf, DAY, denied, goalDoc, HOUR, profileDoc, PUBLISHED_RULES, ts, useRulesEnv } from './helpers.ts'

/** The published rules with inGoalWeek's request.time replaced by the goal's `testNow`. */
function goalClock(rules: string): string {
  const start = rules.indexOf('function inGoalWeek(')
  const end = rules.indexOf('\n    }\n', start)
  if (start < 0 || end < 0) throw new Error('inGoalWeek not found in firestore.rules')
  const body = rules.slice(start, end)
  const moved = body.replaceAll('request.time', "g.get('testNow', request.time)")
  if (moved === body) throw new Error('inGoalWeek doesn\'t read request.time any more')
  return rules.slice(0, start) + moved + rules.slice(end)
}

const { db, seed, clear } = useRulesEnv(goalClock(PUBLISHED_RULES))

const MIN = 60_000
/** The stored offset of a goal created on `day` in `zone` (createSharedGoal stores the offset of then). */
const offsetOf = (zone: string, day: string) => DateTime.fromISO(day, { zone }).offset
/** 00:00 of `day` on `zone`'s real wall clock. */
const midnight = (zone: string, day: string) => DateTime.fromISO(day, { zone }).toMillis()
/** The Monday of the week holding `day`. */
const mondayOf = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7))

/** Alice checks in 1 km for `weekId` while the goal's clock reads `nowMs`. */
async function checkInAt(zone: string, off: number, weekId: string, nowMs: number, extra: DocumentData = {}) {
  await clear()
  await seed({
    'users/alice': profileDoc('Alice'),
    'sharedGoals/g1': goalDoc({ timezone: zone, utcOffsetMin: off, zones: { alice: zone, bob: zone }, testNow: ts(nowMs), ...extra }),
  })
  const fs = db('alice')
  const b = writeBatch(fs)
  b.set(doc(fs, `sharedGoals/g1/checkins/${weekId}_alice`), { uid: 'alice', weekId, amount100: 100, note: '', at: serverTimestamp() })
  b.update(doc(fs, 'sharedGoals/g1'), { 'totals100.alice': 3100, total100: 5600, last: { by: 'alice', weekId, at: serverTimestamp() } })
  return b.commit()
}

describe('a goal\'s week on its stored offset', () => {
  const WEEKS = [
    { zone: 'Europe/Berlin', created: '2026-07-01', week: '2026-10-19', what: 'a summer goal, the week of the autumn change' },
    { zone: 'Europe/Berlin', created: '2026-12-01', week: '2027-03-22', what: 'a winter goal, the week of the spring change' },
    { zone: 'Europe/Berlin', created: '2026-07-01', week: '2026-11-16', what: 'a summer goal in winter' },
    { zone: 'Europe/Berlin', created: '2026-12-01', week: '2027-06-14', what: 'a winter goal in summer' },
    { zone: 'America/Los_Angeles', created: '2026-07-01', week: '2026-10-26', what: 'a summer goal, the week of the autumn change' },
    { zone: 'Australia/Sydney', created: '2026-07-01', week: '2026-12-07', what: 'a winter goal in summer' },
    { zone: 'Australia/Sydney', created: '2027-01-15', week: '2027-03-29', what: 'a summer goal, the week of the autumn change' },
    { zone: 'Pacific/Kiritimati', created: '2026-07-01', week: '2026-10-19', what: 'UTC+14' },
    { zone: 'Pacific/Pago_Pago', created: '2026-07-01', week: '2026-10-19', what: 'UTC−11' },
  ]

  test.each(WEEKS)('$zone, $what: anchor + 7d + 59m allowed, + 61m refused; the hour before it starts likewise', async ({ zone, created, week }) => {
    const off = offsetOf(zone, created)
    const anchor = anchorOf(week, off)
    const upper = anchor + 7 * DAY + HOUR
    // The app's bound is the rules' bound, and it lies within 2 hours after the week's real end.
    expect(checkinClosesAt({ utcOffsetMin: off }, week)).toBe(upper)
    const realEnd = midnight(zone, addDays(week, 7))
    expect(upper - realEnd).toBeGreaterThanOrEqual(0)
    expect(upper - realEnd).toBeLessThanOrEqual(2 * HOUR)
    await allowed(checkInAt(zone, off, week, upper - MIN))
    await denied(checkInAt(zone, off, week, upper + MIN))
    // From an hour before the anchor: never after the week's real start.
    expect(anchor - HOUR).toBeLessThanOrEqual(midnight(zone, week))
    await allowed(checkInAt(zone, off, week, anchor - HOUR + MIN))
    await denied(checkInAt(zone, off, week, anchor - HOUR - MIN))
  })
})

describe('a goal\'s end date on its stored offset', () => {
  const ENDS = [
    { zone: 'Europe/Berlin', created: '2026-07-01', endsOn: '2026-10-21', what: 'a summer goal, mid-week' },
    { zone: 'Europe/Berlin', created: '2026-07-01', endsOn: '2026-10-24', what: 'a summer goal, the day before the change' },
    { zone: 'Europe/Berlin', created: '2026-12-01', endsOn: '2027-06-16', what: 'a winter goal in summer' },
    { zone: 'Australia/Sydney', created: '2026-07-01', endsOn: '2026-12-09', what: 'a winter goal in summer' },
  ]

  test.each(ENDS)('$zone, $what: endsOn + 1d + 59m allowed, + 61m refused', async ({ zone, created, endsOn }) => {
    const off = offsetOf(zone, created)
    const end = anchorOf(endsOn, off) + DAY + HOUR
    const realEnd = midnight(zone, addDays(endsOn, 1))
    expect(end - realEnd).toBeGreaterThanOrEqual(0)
    expect(end - realEnd).toBeLessThanOrEqual(2 * HOUR)
    const week = mondayOf(endsOn)
    await allowed(checkInAt(zone, off, week, end - MIN, { endsOn }))
    await denied(checkInAt(zone, off, week, end + MIN, { endsOn }))
    // Without the end date, the same moment is fine.
    await allowed(checkInAt(zone, off, week, end + MIN))
  })
})
