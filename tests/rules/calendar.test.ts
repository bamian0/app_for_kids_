// Week and monthly-list bounds on fixed calendar dates: DST gaps and repeats, months that start on
// every weekday, a change of times late on a Sunday. The emulator's request.time is the real clock, so
// these run the published rules with one change: in validNewWeek, retimesWeek, validNewMonthly and
// retimesMonthly, "now" is the space doc's `testNow` (seeded) instead of request.time. Everything else
// those functions check (anchors, schedules, notice, members, judges) is the published code.
import { describe, expect, test } from 'vitest'
import { DateTime } from 'luxon'
import { doc, setDoc, Timestamp, updateDoc, type DocumentData, type Firestore } from 'firebase/firestore'
import {
  allDenied, allowed, CUSTOM, denied, HOUR, legacySpaceDoc, momentAt, monthlyOn, monthWeeks, movedClock, PUBLISHED_RULES, spaceDoc,
  ts, useRulesEnv, USUAL, weekOn, type Schedule,
} from './helpers.ts'

const { db, seed } = useRulesEnv(movedClock(PUBLISHED_RULES))

const AB = ['alice', 'bob']
const at = (iso: string, zone: string) => DateTime.fromISO(iso, { zone }).toMillis()
const weekRef = (fs: Firestore, weekId: string, space = 's1') => doc(fs, `spaces/${space}/weeks/${weekId}`)
const listRef = (fs: Firestore, monthId: string, space = 's1') => doc(fs, `spaces/${space}/monthly/${monthId}`)
/** A space in `zone` with the given offset and schedule, whose clock reads `nowMs`. */
const spaceAt = (zone: string, utcOffsetMin: number, nowMs: number, extra: DocumentData = {}) =>
  spaceDoc(AB, { timezone: zone, utcOffsetMin, testNow: ts(nowMs), ...extra })

describe('week docs on DST weekends', () => {
  test('Berlin, a deadline in the spring-forward gap (Sunday 2027-03-28 02:30)', async () => {
    // Sunday 02:30 doesn't exist; the wall clock jumps to 03:30, an hour less after Monday's start.
    const gap: Schedule = { lock: 1440, reviewOpen: 5760, deadline: 6 * 1440 + 150 }
    const week = weekOn(AB, '2027-03-22', 'Europe/Berlin', gap)
    expect(new Date((week.deadlineAt as Timestamp).toMillis()).toISOString()).toBe('2027-03-28T01:30:00.000Z')
    const now = at('2027-03-19T12:00', 'Europe/Berlin')
    // Created in winter (CET, +60) or in summer (CEST, +120): an hour off the anchor either way.
    await seed({
      'spaces/s1': spaceAt('Europe/Berlin', 60, now, { schedule: gap }),
      'spaces/s2': spaceAt('Europe/Berlin', 120, now, { schedule: gap }),
    })
    await allowed(setDoc(weekRef(db('alice'), '2027-03-22'), week))
    await allowed(setDoc(weekRef(db('alice'), '2027-03-22', 's2'), week))
  })

  test('Los Angeles, a deadline in the repeated hour (Sunday 2026-11-01 01:30, the first one)', async () => {
    const repeat: Schedule = { lock: 1440, reviewOpen: 5760, deadline: 6 * 1440 + 90 }
    const week = weekOn(AB, '2026-10-26', 'America/Los_Angeles', repeat)
    expect(new Date((week.deadlineAt as Timestamp).toMillis()).toISOString()).toBe('2026-11-01T08:30:00.000Z')
    await seed({ 'spaces/s1': spaceAt('America/Los_Angeles', -420, at('2026-10-23T12:00', 'America/Los_Angeles'), { schedule: repeat }) })
    await allowed(setDoc(weekRef(db('alice'), '2026-10-26'), week))
    // The second 01:30 is an hour later than the wall clock's first.
    await denied(setDoc(weekRef(db('alice'), '2026-10-26'), { ...week, deadlineAt: ts((week.deadlineAt as Timestamp).toMillis() + 2 * HOUR) }))
  })

  test('the usual week across Berlin\'s autumn change is accepted as before', async () => {
    await seed({ 'spaces/s1': spaceAt('Europe/Berlin', 120, at('2026-10-22T12:00', 'Europe/Berlin')) })
    await allowed(setDoc(weekRef(db('alice'), '2026-10-26'), weekOn(AB, '2026-10-26', 'Europe/Berlin')))
  })
})

describe('a change late on a Sunday', () => {
  const ZONE = 'Europe/Berlin'
  // The owner changed the times on Sunday 2026-11-01 at 22:00: lists now lock Monday at 8:00 AM.
  const EARLY: Schedule = { lock: 480, reviewOpen: 5760, deadline: 7200 }
  const noteAt = at('2026-11-01T22:00', ZONE)
  const note = { by: 'alice', at: ts(noteAt), fromWeek: '2026-11-09', before: USUAL }
  const sunday23 = at('2026-11-01T23:00', ZONE)

  test('a week missing at the change can\'t be created on the new times with less than a day\'s notice', async () => {
    await seed({ 'spaces/s1': spaceAt(ZONE, 60, sunday23, { schedule: EARLY, scheduleNote: note }) })
    // Its lock, Monday 08:00, is 10 hours after the change.
    await denied(setDoc(weekRef(db('bob'), '2026-11-02'), weekOn(AB, '2026-11-02', ZONE, EARLY)))
    await allowed(setDoc(weekRef(db('bob'), '2026-11-09'), weekOn(AB, '2026-11-09', ZONE, EARLY)))
  })

  test('Sunday 23:00, lock Monday 08:00: next week keeps its times, the week after moves', async () => {
    await seed({
      'spaces/s1': spaceAt(ZONE, 60, sunday23, { schedule: EARLY, scheduleNote: note }),
      'spaces/s1/weeks/2026-11-02': weekOn(AB, '2026-11-02', ZONE),
      'spaces/s1/weeks/2026-11-09': weekOn(AB, '2026-11-09', ZONE),
    })
    const retime = (weekId: string) => {
      const w = weekOn([], weekId, ZONE, EARLY)
      return updateDoc(weekRef(db('bob'), weekId), { lockAt: w.lockAt, reviewOpenAt: w.reviewOpenAt, deadlineAt: w.deadlineAt, schedule: EARLY })
    }
    // Its usual lock (Tuesday 00:00) is 25 hours away, but the new one only 9.
    await denied(retime('2026-11-02'))
    await allowed(retime('2026-11-09'))
  })

  test('Monday 15:00, lock Monday 15:30: this week keeps its times, next week moves', async () => {
    const half: Schedule = { lock: 930, reviewOpen: 5760, deadline: 7200 }
    await seed({
      'spaces/s1': spaceAt(ZONE, 60, at('2026-11-02T15:00', ZONE), { schedule: half }),
      'spaces/s1/weeks/2026-11-02': weekOn(AB, '2026-11-02', ZONE),
      'spaces/s1/weeks/2026-11-09': weekOn(AB, '2026-11-09', ZONE),
    })
    const retime = (weekId: string) => {
      const w = weekOn([], weekId, ZONE, half)
      return updateDoc(weekRef(db('bob'), weekId), { lockAt: w.lockAt, reviewOpenAt: w.reviewOpenAt, deadlineAt: w.deadlineAt, schedule: half })
    }
    await denied(retime('2026-11-02'))
    await allowed(retime('2026-11-09'))
  })

  test('a day\'s notice exactly, on the old lock and on the new one', async () => {
    const retimeAt = async (nowMs: number, schedule: Schedule) => {
      await seed({
        'spaces/s1': spaceAt(ZONE, 60, nowMs, { schedule }),
        'spaces/s1/weeks/2026-11-09': weekOn(AB, '2026-11-09', ZONE),
      })
      const w = weekOn([], '2026-11-09', ZONE, schedule)
      return updateDoc(weekRef(db('bob'), '2026-11-09'), { lockAt: w.lockAt, reviewOpenAt: w.reviewOpenAt, deadlineAt: w.deadlineAt, schedule })
    }
    const oldLock = at('2026-11-10T00:00', ZONE)
    const later: Schedule = { lock: 2880, reviewOpen: 5760, deadline: 7200 }
    await allowed(retimeAt(oldLock - 24 * HOUR, later))
    await denied(retimeAt(oldLock - 24 * HOUR + 60_000, later))
    // The new lock, Monday 20:00, a day away exactly, then a minute less.
    const newLock = at('2026-11-09T20:00', ZONE)
    await allowed(retimeAt(newLock - 24 * HOUR, CUSTOM))
    await denied(retimeAt(newLock - 24 * HOUR + 60_000, CUSTOM))
  })
})

describe('creating a monthly list', () => {
  // [month, what it shows, zone, the space's offset, schedule, weeks in the month]
  const CASES: Array<[string, string, string, number, Schedule, number]> = [
    ['2027-02', 'the 1st is a Monday; four weeks', 'Europe/Berlin', 60, USUAL, 4],
    ['2027-01', 'the 1st is a Friday; its first week starts in December', 'Europe/Berlin', 60, USUAL, 5],
    ['2026-12', 'December, ending the week before January\'s first', 'Europe/Berlin', 60, CUSTOM, 4],
    ['2027-05', 'the 1st is a Saturday', 'America/Los_Angeles', -420, USUAL, 4],
    ['2026-11', 'the 1st is a Sunday; Los Angeles after the clocks went back', 'America/Los_Angeles', -420, CUSTOM, 4],
    ['2026-10', 'five weeks; Berlin\'s clocks go back in the last one', 'Europe/Berlin', 120, USUAL, 5],
    ['2027-03', 'Berlin\'s clocks go forward before a Sunday-midnight deadline', 'Europe/Berlin', 60, { lock: 1440, reviewOpen: 9000, deadline: 10080 }, 4],
    ['2026-10', 'a Berlin space created in winter (offset an hour off all summer)', 'Europe/Berlin', 60, CUSTOM, 5],
    ['2027-07', 'Sydney in winter', 'Australia/Sydney', 600, CUSTOM, 5],
    ['2026-12', 'Kolkata, a half-hour offset', 'Asia/Kolkata', 330, USUAL, 4],
  ]

  test.each(CASES)('%s: %s', async (monthId, _what, zone, offset, schedule, weeks) => {
    const w = monthWeeks(monthId)
    expect((Date.parse(w.last) - Date.parse(w.first)) / (7 * 24 * HOUR) + 1).toBe(weeks)
    const list = monthlyOn(monthId, zone, schedule, AB)
    const start = (list.startAt as Timestamp).toMillis()
    await seed({ 'spaces/s1': spaceAt(zone, offset, start - 24 * HOUR, schedule === USUAL ? {} : { schedule }) })
    await allowed(setDoc(listRef(db('alice'), monthId), list))
  })

  test('refused lists', async () => {
    const monthId = '2026-11'
    const zone = 'Europe/Berlin'
    const list = monthlyOn(monthId, zone, USUAL, AB)
    const ms = (k: string) => (list[k] as Timestamp).toMillis()
    const shift = (k: string, d: number) => ({ ...list, [k]: ts(ms(k) + d) })
    await seed({
      'spaces/s1': spaceAt(zone, 60, ms('startAt') - 24 * HOUR),
      'spaces/s2': spaceAt(zone, 60, ms('lockAt') + 60_000),
      'spaces/s3': spaceAt(zone, 60, ms('startAt') - 8 * 24 * HOUR),
      'spaces/s4': spaceAt(zone, 60, ms('startAt') - 24 * HOUR, { judges: ['bob'] }),
      'spaces/s5': legacySpaceDoc(AB, { testNow: ts(ms('startAt') - 24 * HOUR) }),
    })
    const alice = db('alice')
    const create = (d: DocumentData, space = 's1', id = monthId) => () => setDoc(listRef(alice, id, space), d)
    const { submittedBy: _, ...missing } = list
    await allDenied({
      'start 61 minutes late': create(shift('startAt', 61 * 60_000)),
      'lock 61 minutes early': create(shift('lockAt', -61 * 60_000)),
      'review opening 61 minutes late': create(shift('reviewOpenAt', 61 * 60_000)),
      'deadline 61 minutes early': create(shift('deadlineAt', -61 * 60_000)),
      'locked on the first week\'s lock': create({ ...list, lockAt: ts(momentAt(monthWeeks(monthId).first, zone, USUAL.lock)) }),
      'after its lock': create(list, 's2'),
      '8 days before its start': create(list, 's3'),
      'without a member': create({ ...list, members: ['alice'] }),
      'with a stranger': create({ ...list, members: [...AB, 'zoe'] }),
      'judges not the space\'s': create(list, 's4'),
      'a judge where nobody judges': create({ ...list, judges: ['bob'] }),
      'submitted already': create({ ...list, submittedBy: ['alice'] }),
      'an extra key': create({ ...list, schedule: USUAL }),
      'a missing key': create(missing),
      'month 13': create(list, 's1', '2026-13'),
      'a one-digit month': create(list, 's1', '2026-1'),
      'a space without utcOffsetMin': create(list, 's5'),
    })
    await allowed(create({ ...list, judges: ['bob'] }, 's4')())
  })
})

describe('moving a monthly list', () => {
  const ZONE = 'Europe/Berlin'
  const M = '2026-11'
  const W = monthWeeks(M)
  const usual = monthlyOn(M, ZONE, USUAL, AB)
  const custom = monthlyOn(M, ZONE, CUSTOM, AB)
  const move = (data: DocumentData) => updateDoc(listRef(db('bob'), M), data)
  const lockPart = { lockAt: custom.lockAt }
  const reviewPart = { reviewOpenAt: custom.reviewOpenAt, deadlineAt: custom.deadlineAt }

  test('the lock moves only with a day\'s notice on both its old and new time', async () => {
    // The new lock is Monday Nov 9 at 20:00, the old one Tuesday Nov 10 at 00:00.
    const newLock = (custom.lockAt as Timestamp).toMillis()
    const seedAt = (nowMs: number) => seed({ 'spaces/s1': spaceAt(ZONE, 60, nowMs, { schedule: CUSTOM }), [`spaces/s1/monthly/${M}`]: usual })
    await seedAt(newLock - 24 * HOUR - 60_000)
    await allowed(move(lockPart))
    await seedAt(newLock - 23 * HOUR)
    await denied(move(lockPart))
    // Once locked, it stays.
    await seedAt((usual.lockAt as Timestamp).toMillis() + HOUR)
    await denied(move(lockPart))
  })

  test('without its last week\'s doc, the review window moves only while that week could still be created', async () => {
    // The last week would be created on the new times: it locks Monday at 8:00 PM.
    const lastLock = at(`${W.last}T00:00`, ZONE) + CUSTOM.lock * 60_000
    await seed({ 'spaces/s1': spaceAt(ZONE, 60, lastLock - 30 * 60_000, { schedule: CUSTOM }), [`spaces/s1/monthly/${M}`]: usual })
    await denied(move(reviewPart))
    await seed({ 'spaces/s1': spaceAt(ZONE, 60, lastLock - 2 * HOUR, { schedule: CUSTOM }) })
    await allowed(move(reviewPart))
  })

  test('an opened review window stays', async () => {
    await seed({
      'spaces/s1': spaceAt(ZONE, 60, (usual.reviewOpenAt as Timestamp).toMillis() + HOUR, { schedule: CUSTOM }),
      [`spaces/s1/monthly/${M}`]: usual,
      [`spaces/s1/weeks/${W.last}`]: weekOn(AB, W.last, ZONE, CUSTOM),
    })
    const last = weekOn(AB, W.last, ZONE, CUSTOM)
    await denied(move({ reviewOpenAt: last.reviewOpenAt, deadlineAt: last.deadlineAt }))
  })
})
