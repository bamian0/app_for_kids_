// Custom times (SPEC §9.2): the owner's setsSchedule, week docs on the space's schedule, retimesWeek.
// Cases that need a particular day and hour (DST gaps, a change late on Sunday) run on a moved clock
// in calendar.test.ts.
import { describe, expect, test } from 'vitest'
import { DateTime } from 'luxon'
import {
  arrayUnion, deleteField, doc, getDoc, runTransaction, serverTimestamp, setDoc, Timestamp, updateDoc, type DocumentData,
  type Firestore,
} from 'firebase/firestore'
import {
  allDenied, allowed, CUSTOM, DAY, denied, HOUR, mondayOf, offsetOn, spaceDoc, ts, useRulesEnv, USUAL, weekOn, type Schedule,
} from './helpers.ts'

const { db, seed } = useRulesEnv()

const ZONE = 'Europe/Berlin'
const ABC = ['alice', 'bob', 'carol']
// Lists lock Tuesday at midnight, reviews due Saturday at midnight: next week's new lock is never
// earlier than its usual one, so it always has a day's notice, whatever day the tests run.
const LATER: Schedule = { lock: 2880, reviewOpen: 5760, deadline: 8640 }
// A Monday (UTC date) near now, as the rules check fromWeek.
const FROM_WEEK = DateTime.utc().startOf('week').plus({ weeks: 1 }).toISODate()!

const spaceRef = (fs: Firestore, id = 's1') => doc(fs, `spaces/${id}`)
const weekRef = (fs: Firestore, weekId: string, space = 's1') => doc(fs, `spaces/${space}/weeks/${weekId}`)

/** setSchedule's space write: the schedule (or deleteField for the usual times) and the note. */
function setTimes(fs: Firestore, uid: string, schedule: Schedule | null, note: DocumentData = {}, extra: DocumentData = {}, space = 's1') {
  return updateDoc(spaceRef(fs, space), {
    schedule: schedule ?? deleteField(),
    scheduleNote: { by: uid, at: serverTimestamp(), fromWeek: FROM_WEEK, before: USUAL, ...note },
    ...extra,
  })
}

/** A retime of a week to `schedule`: the three later bounds and `schedule` (deleted for the usual times). */
function retime(fs: Firestore, weekId: string, schedule: Schedule, extra: DocumentData = {}) {
  const w = weekOn([], weekId, ZONE, schedule)
  return updateDoc(weekRef(fs, weekId), {
    lockAt: w.lockAt, reviewOpenAt: w.reviewOpenAt, deadlineAt: w.deadlineAt,
    schedule: 'schedule' in w ? schedule : deleteField(),
    ...extra,
  })
}

describe('setsSchedule', () => {
  test('the owner sets the times with a note, changes them again, and goes back to the usual ones', async () => {
    await seed({ 'spaces/s1': spaceDoc(ABC) })
    const alice = db('alice')
    await allowed(setTimes(alice, 'alice', CUSTOM))
    const after = (await getDoc(spaceRef(alice))).data()!
    expect(after.schedule).toEqual(CUSTOM)
    expect(after.scheduleNote.before).toEqual(USUAL)
    await allowed(setTimes(alice, 'alice', LATER, { before: CUSTOM }))
    await allowed(setTimes(alice, 'alice', null, { before: LATER }))
    expect((await getDoc(spaceRef(alice))).data()!.schedule).toBeUndefined()
  })

  test('the limits hold at their edges', async () => {
    await seed({ 'spaces/s1': spaceDoc(ABC) })
    const alice = db('alice')
    // Lists lock Sunday at midnight (the week's start), reviews get exactly 3 hours, due Sunday at midnight.
    await allowed(setTimes(alice, 'alice', { lock: 0, reviewOpen: 9900, deadline: 10080 }))
    await allowed(setTimes(alice, 'alice', { lock: 1439, reviewOpen: 1440, deadline: 1620 }, { before: { lock: 0, reviewOpen: 9900, deadline: 10080 } }))
  })

  test('only the owner, still a member, sets valid times with an honest note', async () => {
    await seed({
      'spaces/s1': spaceDoc(ABC),
      // An owner who left (a space from an older client).
      'spaces/s2': spaceDoc(['bob', 'carol'], { ownerId: 'alice' }),
    })
    const alice = db('alice')
    const set = (schedule: unknown, note: DocumentData = {}, extra: DocumentData = {}) => () =>
      setTimes(alice, 'alice', schedule as Schedule, note, extra)
    const monday = (weeks: number) => DateTime.utc().startOf('week').plus({ weeks }).toISODate()!
    await allDenied({
      'a member who isn\'t the owner': () => setTimes(db('bob'), 'bob', CUSTOM),
      'an owner who left': () => setTimes(alice, 'alice', CUSTOM, {}, {}, 's2'),
      'signed out': () => setTimes(db(), 'alice', CUSTOM),
      'lock before the week starts': set({ lock: -30, reviewOpen: 5760, deadline: 7200 }),
      'lock at the review opening': set({ lock: 5760, reviewOpen: 5760, deadline: 7200 }),
      'lock after the review opening': set({ lock: 6000, reviewOpen: 5760, deadline: 7200 }),
      'a review window under 3 hours': set({ lock: 1440, reviewOpen: 5760, deadline: 5939 }),
      'due after Sunday at midnight': set({ lock: 1440, reviewOpen: 5760, deadline: 10110 }),
      'a float': set({ lock: 1440.5, reviewOpen: 5760, deadline: 7200 }),
      'a string': set({ lock: '1440', reviewOpen: 5760, deadline: 7200 }),
      'a missing moment': set({ lock: 1440, deadline: 7200 }),
      'an extra key': set({ ...CUSTOM, results: 8640 }),
      'not a map': set([1200, 5760, 7920]),
      'unchanged': set(USUAL),
      'with a rename': set(CUSTOM, {}, { name: 'New times' }),
      'without a note': () => updateDoc(spaceRef(alice), { schedule: CUSTOM }),
      'note by someone else': set(CUSTOM, { by: 'bob' }),
      'note at a client time': set(CUSTOM, { at: Timestamp.now() }),
      'note with an extra key': set(CUSTOM, { reason: 'later' }),
      'note without before': () =>
        updateDoc(spaceRef(alice), { schedule: CUSTOM, scheduleNote: { by: 'alice', at: serverTimestamp(), fromWeek: FROM_WEEK } }),
      'before is not the old schedule': set(CUSTOM, { before: CUSTOM }),
      'fromWeek not a Monday': set(CUSTOM, { fromWeek: DateTime.fromISO(FROM_WEEK).plus({ days: 1 }).toISODate() }),
      'fromWeek two weeks back': set(CUSTOM, { fromWeek: monday(-2) }),
      'fromWeek a month ahead': set(CUSTOM, { fromWeek: monday(4) }),
      'fromWeek malformed': set(CUSTOM, { fromWeek: 'next week' }),
      'fromWeek not a date': set(CUSTOM, { fromWeek: '2026-02-30' }),
      'note deleted': () => updateDoc(spaceRef(alice), { schedule: CUSTOM, scheduleNote: deleteField() }),
    })
  })

  test('an explicit usual map counts as the usual times', async () => {
    await seed({ 'spaces/s1': spaceDoc(ABC, { schedule: USUAL }) })
    // Deleting it changes nothing that counts, so there is nothing to note.
    await denied(setTimes(db('alice'), 'alice', null))
    await allowed(setTimes(db('alice'), 'alice', CUSTOM))
  })
})

describe('weeks on the space\'s times', () => {
  // Zones on both sides of UTC, a half-hour offset, both extremes and a southern-hemisphere DST.
  const ZONES = ['Europe/Berlin', 'America/Los_Angeles', 'Australia/Sydney', 'Asia/Kolkata', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']

  test.each(ZONES)('next week follows the space\'s schedule in %s', async (zone) => {
    const next = mondayOf(zone, 1)
    await seed({
      'spaces/s1': spaceDoc(ABC, { timezone: zone, schedule: CUSTOM, utcOffsetMin: offsetOn(zone, next) }),
      'spaces/s2': spaceDoc(ABC, { timezone: zone, schedule: CUSTOM, utcOffsetMin: offsetOn(zone, next) }),
    })
    const alice = db('alice')
    const week = weekOn(ABC, next, zone, CUSTOM)
    const { schedule: _, ...sixKeys } = week
    const shift = (key: string, ms: number) => ({ ...week, [key]: ts((week[key] as Timestamp).toMillis() + ms) })
    await allDenied({
      'an older client\'s 6-key doc': () => setDoc(weekRef(alice, next), sixKeys),
      'the usual bounds': () => setDoc(weekRef(alice, next), { ...weekOn(ABC, next, zone), schedule: CUSTOM }),
      'another schedule': () => setDoc(weekRef(alice, next), { ...week, schedule: LATER }),
      'the usual schedule stored': () => setDoc(weekRef(alice, next), { ...week, schedule: USUAL }),
      'lock 2h late': () => setDoc(weekRef(alice, next), shift('lockAt', 2 * HOUR)),
      'deadline 2h early': () => setDoc(weekRef(alice, next), shift('deadlineAt', -2 * HOUR)),
      'start 1h early, bounds 1h earlier still': () => setDoc(weekRef(alice, next), {
        ...week,
        startAt: ts((week.startAt as Timestamp).toMillis() - HOUR),
        lockAt: ts((week.lockAt as Timestamp).toMillis() - 2 * HOUR),
        reviewOpenAt: ts((week.reviewOpenAt as Timestamp).toMillis() - 2 * HOUR),
        deadlineAt: ts((week.deadlineAt as Timestamp).toMillis() - 2 * HOUR),
      }),
      'an extra key': () => setDoc(weekRef(alice, next), { ...week, results: week.deadlineAt }),
    })
    await allowed(setDoc(weekRef(alice, next), week))
    expect((await getDoc(weekRef(alice, next))).data()?.schedule).toEqual(CUSTOM)
    // Each bound has the usual hour of slack (DST inside the week).
    await allowed(setDoc(weekRef(alice, next, 's2'), shift('deadlineAt', HOUR)))
  })

  test('a space on the usual times takes the 6-key doc, also when its schedule is stored explicitly', async () => {
    await seed({ 'spaces/s1': spaceDoc(ABC), 'spaces/s2': spaceDoc(ABC, { schedule: USUAL }), 'spaces/s3': spaceDoc(ABC) })
    const next = mondayOf(ZONE, 1)
    await allowed(setDoc(weekRef(db('alice'), next), weekOn(ABC, next, ZONE)))
    await allowed(setDoc(weekRef(db('alice'), next, 's2'), weekOn(ABC, next, ZONE)))
    // The usual map stored on the week matches the usual times too.
    await allowed(setDoc(weekRef(db('alice'), next, 's3'), { ...weekOn(ABC, next, ZONE), schedule: USUAL }))
  })

  test('after a change, no week is created on the new times with less than a day\'s notice', async () => {
    const next = mondayOf(ZONE, 1)
    const week = weekOn(ABC, next, ZONE, CUSTOM)
    const lock = (week.lockAt as Timestamp).toMillis()
    const note = (atMs: number) => ({ by: 'alice', at: ts(atMs), fromWeek: next, before: USUAL })
    await seed({
      'spaces/s1': spaceDoc(ABC, { schedule: CUSTOM, scheduleNote: note(lock - 23 * HOUR) }),
      'spaces/s2': spaceDoc(ABC, { schedule: CUSTOM, scheduleNote: note(lock - DAY) }),
    })
    await denied(setDoc(weekRef(db('bob'), next), week))
    await allowed(setDoc(weekRef(db('bob'), next, 's2'), week))
  })
})

describe('retimesWeek', () => {
  const next = mondayOf(ZONE, 1)
  const after = mondayOf(ZONE, 2)

  test('a member moves next week to the space\'s new times, and back to the usual ones', async () => {
    await seed({ 'spaces/s1': spaceDoc(ABC, { schedule: LATER }), [`spaces/s1/weeks/${next}`]: weekOn(ABC, next, ZONE) })
    await allowed(retime(db('bob'), next, LATER))
    const week = (await getDoc(weekRef(db('bob'), next))).data()!
    expect(week.schedule).toEqual(LATER)
    expect(week.members).toEqual(ABC)
    await seed({ 'spaces/s1': spaceDoc(ABC) })
    await allowed(retime(db('carol'), next, USUAL))
    expect((await getDoc(weekRef(db('bob'), next))).data()!.schedule).toBeUndefined()
  })

  test('the owner changes the times and moves both weeks in one transaction', async () => {
    await seed({
      'spaces/s1': spaceDoc(ABC),
      [`spaces/s1/weeks/${next}`]: weekOn(ABC, next, ZONE),
      // Admin-seeded: clients create weeks at most 8 days ahead.
      [`spaces/s1/weeks/${after}`]: weekOn(ABC, after, ZONE),
    })
    const alice = db('alice')
    await allowed(runTransaction(alice, async (tx) => {
      await tx.get(spaceRef(alice))
      await tx.get(weekRef(alice, next))
      await tx.get(weekRef(alice, after))
      tx.update(spaceRef(alice), {
        schedule: LATER, scheduleNote: { by: 'alice', at: serverTimestamp(), fromWeek: next, before: USUAL },
      })
      for (const w of [next, after]) {
        const b = weekOn([], w, ZONE, LATER)
        tx.update(weekRef(alice, w), { lockAt: b.lockAt, reviewOpenAt: b.reviewOpenAt, deadlineAt: b.deadlineAt, schedule: LATER })
      }
    }))
  })

  test('only an unlocked week not yet on the new times moves, exactly onto them', async () => {
    const last = mondayOf(ZONE, -1)
    await seed({
      'spaces/s1': spaceDoc(ABC, { schedule: LATER }),
      [`spaces/s1/weeks/${next}`]: weekOn(ABC, next, ZONE),
      [`spaces/s1/weeks/${after}`]: weekOn(ABC, after, ZONE, LATER),
      [`spaces/s1/weeks/${last}`]: weekOn(ABC, last, ZONE),
    })
    const bob = db('bob')
    const moved = (weekId: string, ms: number, keys = ['lockAt', 'reviewOpenAt', 'deadlineAt']) => {
      const b = weekOn([], weekId, ZONE, LATER)
      return Object.fromEntries(keys.map((k) => [k, ts((b[k] as Timestamp).toMillis() + ms)]))
    }
    await allDenied({
      'a week that has locked': () => retime(bob, last, LATER),
      'already on the new times (a nudge)': () => updateDoc(weekRef(bob, after), moved(after, 30 * 60_000)),
      'to times the space doesn\'t have': () => retime(bob, next, CUSTOM),
      'skewed by 2h': () => updateDoc(weekRef(bob, next), { ...moved(next, 2 * HOUR), schedule: LATER }),
      'the lock alone skewed by 2h': () => updateDoc(weekRef(bob, next), { ...moved(next, 0), ...moved(next, 2 * HOUR, ['lockAt']), schedule: LATER }),
      'without storing the schedule': () => updateDoc(weekRef(bob, next), moved(next, 0)),
      'with members': () => retime(bob, next, LATER, { members: arrayUnion('dave') }),
      'with submittedBy': () => retime(bob, next, LATER, { submittedBy: ['bob'] }),
      'with startAt': () => retime(bob, next, LATER, { startAt: ts(Date.now() + 3 * DAY) }),
      'a non-member': () => retime(db('zoe'), next, LATER),
      'signed out': () => retime(db(), next, LATER),
    })
  })
})
