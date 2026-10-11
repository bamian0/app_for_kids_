// spaces/{id}/weeks/{weekId}: create (real Monday ids, bounds anchored to the space's offset, every
// member), adding members, leaving, submitting, read.
import { describe, expect, test } from 'vitest'
import { DateTime } from 'luxon'
import {
  arrayRemove, arrayUnion, deleteDoc, deleteField, doc, getDoc, runTransaction, serverTimestamp, setDoc, updateDoc,
  writeBatch, type DocumentData, type Firestore,
} from 'firebase/firestore'
import { allDenied, allowed, DAY, denied, HOUR, legacySpaceDoc, offsetNow, spaceDoc, ts, useRulesEnv, weekDoc } from './helpers.ts'

const { db, seed } = useRulesEnv()

type Bound = 'startAt' | 'lockAt' | 'reviewOpenAt' | 'deadlineAt'
const BOUNDS: Bound[] = ['startAt', 'lockAt', 'reviewOpenAt', 'deadlineAt']

/** Monday (ISO week start) of the week containing now in `zone`, shifted by `weeks`. */
function mondayId(zone: string, weeks = 0): string {
  return DateTime.now().setZone(zone).startOf('week').plus({ weeks }).toISODate()!
}

/** The week doc the data layer creates: DST-correct local midnights, every current member. */
function newWeek(members: string[], weekId: string, zone: string, extra: DocumentData = {}): DocumentData {
  const start = DateTime.fromISO(weekId, { zone })
  return {
    startAt: ts(start.toMillis()),
    lockAt: ts(start.plus({ days: 1 }).toMillis()),
    reviewOpenAt: ts(start.plus({ days: 4 }).toMillis()),
    deadlineAt: ts(start.plus({ days: 5 }).toMillis()),
    members,
    submittedBy: [],
    ...extra,
  }
}

/** newWeek with bounds shifted from the correct ones by the given offsets. */
function shifted(members: string[], weekId: string, zone: string, offsets: Partial<Record<Bound, number>>): DocumentData {
  const out = newWeek(members, weekId, zone)
  for (const [key, ms] of Object.entries(offsets)) out[key] = ts(out[key].toMillis() + ms)
  return out
}

const everyBound = (ms: number): Record<Bound, number> => Object.fromEntries(BOUNDS.map((b) => [b, ms])) as Record<Bound, number>

/** Bounds at exact whole days from an arbitrary start instant. */
function fromStart(members: string[], startMs: number): DocumentData {
  return { startAt: ts(startMs), lockAt: ts(startMs + DAY), reviewOpenAt: ts(startMs + 4 * DAY), deadlineAt: ts(startMs + 5 * DAY), members, submittedBy: [] }
}

const weekRef = (fs: Firestore, weekId: string, space = 's1') => doc(fs, `spaces/${space}/weeks/${weekId}`)
const isLocked = (weekId: string, zone: string) => Date.now() >= DateTime.fromISO(weekId, { zone }).plus({ days: 1 }).toMillis()

// Zones on both sides of UTC, a half-hour offset, both extremes and a southern-hemisphere DST.
const ZONES = ['Europe/Berlin', 'America/Los_Angeles', 'Australia/Sydney', 'Asia/Kolkata', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']
const AB = ['alice', 'bob']

describe('weeks: create', () => {
  test.each(ZONES)('this week (until it locks) and next week in %s', async (zone) => {
    await seed({ 'spaces/s1': spaceDoc(AB, { timezone: zone }) })
    const alice = db('alice')
    const thisWeek = mondayId(zone)
    const nextWeek = mondayId(zone, 1)
    await (isLocked(thisWeek, zone) ? denied : allowed)(setDoc(weekRef(alice, thisWeek), newWeek(AB, thisWeek, zone)))
    await allowed(setDoc(weekRef(alice, nextWeek), newWeek(AB, nextWeek, zone)))
    expect((await getDoc(weekRef(alice, nextWeek))).data()?.members).toEqual(AB)
  })

  test.each(ZONES)('DST: a space created in the other season (offset ±1h) still creates real weeks in %s', async (zone) => {
    const now = offsetNow(zone)
    await seed({
      'spaces/s1': spaceDoc(AB, { timezone: zone, utcOffsetMin: now - 60 }),
      'spaces/s2': spaceDoc(AB, { timezone: zone, utcOffsetMin: now + 60 }),
    })
    const next = mondayId(zone, 1)
    await allowed(setDoc(weekRef(db('alice'), next, 's1'), newWeek(AB, next, zone)))
    await allowed(setDoc(weekRef(db('alice'), next, 's2'), newWeek(AB, next, zone)))
  })

  test.each(ZONES)('a space from the other season can move a week by 2h at most in %s', async (zone) => {
    // Its anchor is an hour early, so its hour of slack reaches 2h early; the bounds' own hour can't add a third.
    await seed({ 'spaces/s1': spaceDoc(AB, { timezone: zone, utcOffsetMin: offsetNow(zone) + 60 }), 'spaces/s2': spaceDoc(AB, { timezone: zone, utcOffsetMin: offsetNow(zone) + 60 }) })
    const next = mondayId(zone, 1)
    await allowed(setDoc(weekRef(db('alice'), next, 's1'), shifted(AB, next, zone, everyBound(-2 * HOUR))))
    await denied(setDoc(weekRef(db('alice'), next, 's2'), shifted(AB, next, zone, { startAt: -2 * HOUR, lockAt: -3 * HOUR, reviewOpenAt: -3 * HOUR, deadlineAt: -3 * HOUR })))
  })

  test('DST inside the week: later bounds may be 1h off whole days', async () => {
    const zone = 'Europe/Berlin'
    await seed({ 'spaces/s1': spaceDoc(AB), 'spaces/s2': spaceDoc(AB) })
    const next = mondayId(zone, 1)
    await allowed(setDoc(weekRef(db('alice'), next, 's1'), shifted(AB, next, zone, { reviewOpenAt: HOUR, deadlineAt: HOUR })))
    await allowed(setDoc(weekRef(db('alice'), next, 's2'), shifted(AB, next, zone, { reviewOpenAt: -HOUR, deadlineAt: -HOUR })))
  })

  test.each(ZONES)('skewed timelines are refused in %s', async (zone) => {
    await seed({ 'spaces/s1': spaceDoc(AB, { timezone: zone }) })
    const alice = db('alice')
    const next = mondayId(zone, 1)
    const utcMidnight = Date.parse(`${next}T00:00:00Z`)
    const create = (data: DocumentData) => () => setDoc(weekRef(alice, next), data)
    const cases: Record<string, () => Promise<unknown>> = {
      'everything 2h early': create(shifted(AB, next, zone, everyBound(-2 * HOUR))),
      'everything 2h late': create(shifted(AB, next, zone, everyBound(2 * HOUR))),
      'everything 23h early': create(shifted(AB, next, zone, everyBound(-23 * HOUR))),
      'lock 2h early': create(shifted(AB, next, zone, { lockAt: -2 * HOUR })),
      'deadline 2h early': create(shifted(AB, next, zone, { deadlineAt: -2 * HOUR })),
      // Each hour of slack is fine alone; stacked they would move the lock and deadline by two.
      'start 1h early, later bounds 1h earlier still': create(shifted(AB, next, zone, { startAt: -HOUR, lockAt: -2 * HOUR, reviewOpenAt: -2 * HOUR, deadlineAt: -2 * HOUR })),
      'start 1h late, later bounds 1h later still': create(shifted(AB, next, zone, { startAt: HOUR, lockAt: 2 * HOUR, reviewOpenAt: 2 * HOUR, deadlineAt: 2 * HOUR })),
      'review window 2h late': create(shifted(AB, next, zone, { reviewOpenAt: 2 * HOUR, deadlineAt: 2 * HOUR })),
      // The old attack: Monday 00:00 UTC − 14h, every later bound − 2h.
      'UTC − 14h, bounds − 2h': create({
        ...fromStart(AB, utcMidnight - 14 * HOUR),
        lockAt: ts(utcMidnight - 14 * HOUR + DAY - 2 * HOUR),
        reviewOpenAt: ts(utcMidnight - 14 * HOUR + 4 * DAY - 2 * HOUR),
        deadlineAt: ts(utcMidnight - 14 * HOUR + 5 * DAY - 2 * HOUR),
      }),
    }
    // A UTC-midnight timeline is a skew wherever local midnight is more than an hour away from it.
    if (Math.abs(offsetNow(zone)) > 60) cases['UTC midnight'] = create(fromStart(AB, utcMidnight))
    await allDenied(cases)
  })

  test('spaces from before utcOffsetMin keep the ±14h anchor, with 1h slack per bound', async () => {
    await seed({ 'spaces/s1': legacySpaceDoc(AB), 'spaces/s2': legacySpaceDoc(AB), 'spaces/s3': legacySpaceDoc(AB) })
    const alice = db('alice')
    const next = mondayId('UTC', 1)
    const utcMidnight = Date.parse(`${next}T00:00:00Z`)
    await allowed(setDoc(weekRef(alice, next, 's1'), fromStart(AB, utcMidnight + 14 * HOUR)))
    await allowed(setDoc(weekRef(alice, next, 's2'), fromStart(AB, utcMidnight - 14 * HOUR)))
    await allDenied({
      '+15h': () => setDoc(weekRef(alice, next, 's3'), fromStart(AB, utcMidnight + 15 * HOUR)),
      '-15h': () => setDoc(weekRef(alice, next, 's3'), fromStart(AB, utcMidnight - 15 * HOUR)),
      'lock 2h early': () => setDoc(weekRef(alice, next, 's3'), { ...fromStart(AB, utcMidnight), lockAt: ts(utcMidnight + DAY - 2 * HOUR) }),
    })
  })

  test('every current space member takes part, whoever creates the week', async () => {
    const zone = 'Europe/Berlin'
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob', 'carol']), 'spaces/s2': spaceDoc(['alice', 'bob', 'carol']) })
    const next = mondayId(zone, 1)
    const create = (members: string[]) => () => setDoc(weekRef(db('alice'), next), newWeek(members, next, zone))
    await allDenied({
      'only self': create(['alice']),
      'missing a member': create(['alice', 'bob']),
      'nobody': create([]),
      'a non-member': create(['alice', 'bob', 'carol', 'zoe']),
      'a duplicate instead of a member': create(['alice', 'bob', 'bob']),
    })
    await allowed(setDoc(weekRef(db('bob'), next), newWeek(['carol', 'alice', 'bob'], next, zone)))
    await allowed(setDoc(weekRef(db('carol'), next, 's2'), newWeek(['alice', 'bob', 'carol'], next, zone)))
  })

  test('a week can only be created before it locks', async () => {
    await seed({ 'spaces/s1': spaceDoc(AB, { timezone: 'UTC' }) })
    const last = mondayId('UTC', -1)
    await allDenied({
      'last week with everyone': () => setDoc(weekRef(db('alice'), last), newWeek(AB, last, 'UTC')),
      'last week with nobody': () => setDoc(weekRef(db('alice'), last), newWeek([], last, 'UTC')),
    })
  })

  test('inconsistent or out-of-range weeks are rejected', async () => {
    const zone = 'Europe/Berlin'
    await seed({ 'spaces/s1': spaceDoc(AB) })
    const alice = db('alice')
    const next = mondayId(zone, 1)
    const nextTuesday = DateTime.fromISO(next).plus({ days: 1 }).toISODate()!
    const tooFar = mondayId(zone, 3)
    const create = (weekId: string, data: DocumentData) => () => setDoc(weekRef(alice, weekId), data)
    await allDenied({
      'weekId is a Tuesday': create(nextTuesday, newWeek(AB, nextTuesday, zone)),
      'weekId has a suffix': create(`${next}x`, newWeek(AB, next, zone)),
      'weekId not a date': create('next-week', newWeek(AB, next, zone)),
      'impossible date': create('2026-02-30', newWeek(AB, next, zone)),
      'startAt a day early': create(next, shifted(AB, next, zone, everyBound(-DAY))),
      'lockAt a day late': create(next, shifted(AB, next, zone, { lockAt: DAY })),
      'deadlineAt a day late': create(next, shifted(AB, next, zone, { deadlineAt: DAY })),
      'startAt is a number': create(next, newWeek(AB, next, zone, { startAt: Date.now() })),
      'submittedBy not empty': create(next, newWeek(AB, next, zone, { submittedBy: ['alice'] })),
      'members not a list': create(next, newWeek(AB, next, zone, { members: { alice: true, bob: true } })),
      'extra key': create(next, newWeek(AB, next, zone, { bonus: 1 })),
      'missing deadlineAt': create(next, (({ deadlineAt: _, ...rest }) => rest)(newWeek(AB, next, zone))),
      'three weeks ahead': create(tooFar, newWeek(AB, tooFar, zone)),
      'non-member': () => setDoc(weekRef(db('zoe'), next), newWeek(AB, next, zone)),
      'signed out': () => setDoc(weekRef(db(), next), newWeek(AB, next, zone)),
    })
  })

  test('create inside a transaction (read, then create)', async () => {
    const zone = 'Europe/Berlin'
    await seed({ 'spaces/s1': spaceDoc(AB) })
    const alice = db('alice')
    const next = mondayId(zone, 1)
    await allowed(
      runTransaction(alice, async (tx) => {
        const space = await tx.get(doc(alice, 'spaces/s1'))
        const snap = await tx.get(weekRef(alice, next))
        if (!snap.exists()) tx.set(weekRef(alice, next), newWeek(space.data()?.memberIds, next, zone))
      }),
    )
  })
})

describe('weeks: adding members', () => {
  test('before lockAt any member adds current space members who are missing', async () => {
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob', 'carol', 'dave']), 'spaces/s1/weeks/W': weekDoc('planning', ['alice']) })
    await allowed(updateDoc(weekRef(db('alice'), 'W'), { members: arrayUnion('bob', 'carol') }))
    const dave = db('dave')
    await allowed(
      runTransaction(dave, async (tx) => {
        const snap = await tx.get(weekRef(dave, 'W'))
        if (!snap.data()?.members.includes('dave')) tx.update(weekRef(dave, 'W'), { members: arrayUnion('dave') })
      }),
    )
    expect((await getDoc(weekRef(dave, 'W'))).data()?.members).toEqual(['alice', 'bob', 'carol', 'dave'])
  })

  test('adding is limited to space members, before lockAt, append only', async () => {
    await seed({
      'spaces/s1': spaceDoc(['alice', 'bob', 'carol']),
      'spaces/s1/weeks/W': weekDoc('planning', ['alice']),
      'spaces/s1/weeks/L': weekDoc('active', ['alice']),
    })
    const bob = db('bob')
    await allDenied({
      'after lockAt': () => updateDoc(weekRef(bob, 'L'), { members: arrayUnion('bob') }),
      'not a space member': () => updateDoc(weekRef(db('zoe'), 'W'), { members: arrayUnion('zoe') }),
      'adds a non-member': () => updateDoc(weekRef(bob, 'W'), { members: arrayUnion('bob', 'zoe') }),
      'replaces members': () => updateDoc(weekRef(bob, 'W'), { members: ['bob'] }),
      'reorders and adds': () => updateDoc(weekRef(bob, 'W'), { members: ['bob', 'alice'] }),
      'adds twice': () => updateDoc(weekRef(bob, 'W'), { members: ['alice', 'bob', 'bob'] }),
      'nothing new': () => updateDoc(weekRef(db('alice'), 'W'), { members: arrayUnion('alice') }),
      'also moves lockAt': () => updateDoc(weekRef(bob, 'W'), { members: arrayUnion('bob'), lockAt: ts(Date.now() + 9 * DAY) }),
      'also submits': () => updateDoc(weekRef(bob, 'W'), { members: arrayUnion('bob'), submittedBy: arrayUnion('bob') }),
    })
  })
})

describe('weeks: leaving', () => {
  const leaveSpace = (fs: Firestore, uid: string, weeks: string[], spacePatch: DocumentData = {}) => {
    const batch = writeBatch(fs)
    for (const w of weeks) batch.update(weekRef(fs, w), { members: arrayRemove(uid) })
    batch.update(doc(fs, 'spaces/s1'), {
      memberIds: arrayRemove(uid), [`joinedAt.${uid}`]: deleteField(), [`leftAt.${uid}`]: serverTimestamp(), ...spacePatch,
    })
    return batch.commit()
  }

  test('someone leaving the space before lock leaves the unlocked weeks in the same batch', async () => {
    await seed({
      'spaces/s1': spaceDoc(['alice', 'bob', 'carol']),
      'spaces/s1/weeks/P': weekDoc('planning', ['alice', 'bob', 'carol']),
      'spaces/s1/weeks/N': weekDoc('planning', ['alice', 'bob', 'carol']),
    })
    await allowed(leaveSpace(db('carol'), 'carol', ['P', 'N']))
    expect((await getDoc(weekRef(db('alice'), 'P'))).data()?.members).toEqual(['alice', 'bob'])
    expect((await getDoc(weekRef(db('alice'), 'N'))).data()?.members).toEqual(['alice', 'bob'])
  })

  test('after lock, leaving or being removed keeps you in the week', async () => {
    // The lock is a commitment: slacking then leaving on Thursday, or the owner removing someone on
    // Friday, must not erase that week.
    await seed({
      'spaces/s1': spaceDoc(['alice', 'bob', 'carol', 'dave']),
      'spaces/s1/weeks/A': weekDoc('active', ['alice', 'bob', 'carol', 'dave']),
      'spaces/s1/weeks/R': weekDoc('review', ['alice', 'bob', 'carol', 'dave']),
      'spaces/s1/weeks/N': weekDoc('planning', ['alice', 'bob', 'carol', 'dave']),
    })
    await allDenied({
      'leave a week in its active phase': () => leaveSpace(db('carol'), 'carol', ['A']),
      'leave a week in its review window': () => leaveSpace(db('carol'), 'carol', ['R']),
      'leave the locked week along with the unlocked one': () => leaveSpace(db('carol'), 'carol', ['N', 'A']),
      'owner removes someone from the review week': () => leaveSpace(db('alice'), 'dave', ['R']),
    })
    // Leaving the space itself (and the week that hasn't locked) still works; the locked weeks keep them.
    await allowed(leaveSpace(db('carol'), 'carol', ['N']))
    await allowed(leaveSpace(db('alice'), 'dave', ['N']))
    expect((await getDoc(weekRef(db('alice'), 'A'))).data()?.members).toEqual(['alice', 'bob', 'carol', 'dave'])
    expect((await getDoc(weekRef(db('alice'), 'R'))).data()?.members).toEqual(['alice', 'bob', 'carol', 'dave'])
    expect((await getDoc(weekRef(db('alice'), 'N'))).data()?.members).toEqual(['alice', 'bob'])
    // And nobody can take them out afterwards either.
    await allDenied({
      'owner, later': () => updateDoc(weekRef(db('alice'), 'R'), { members: arrayRemove('carol') }),
      'another member, later': () => updateDoc(weekRef(db('bob'), 'A'), { members: arrayRemove('dave') }),
    })
  })

  test('the owner takes someone who already left out of a week that has not locked', async () => {
    await seed({
      'spaces/s1': spaceDoc(AB),
      'spaces/s1/weeks/P': weekDoc('planning', ['alice', 'bob', 'dave']),
      'spaces/s1/weeks/R': weekDoc('review', ['alice', 'bob', 'dave']),
    })
    await denied(updateDoc(weekRef(db('bob'), 'P'), { members: arrayRemove('dave') }))
    await allowed(updateDoc(weekRef(db('alice'), 'P'), { members: arrayRemove('dave') }))
    await denied(updateDoc(weekRef(db('alice'), 'R'), { members: arrayRemove('dave') }))
  })

  test('leaving a week is limited to one ex-member, before lockAt', async () => {
    await seed({
      'spaces/s1': spaceDoc(['alice', 'bob', 'carol']),
      'spaces/s1/weeks/P': weekDoc('planning', ['alice', 'bob', 'carol', 'dave', 'erin']),
      'spaces/s1/weeks/A': weekDoc('active', ['alice', 'bob', 'carol', 'dave']),
      'spaces/s1/weeks/R': weekDoc('review', ['alice', 'bob', 'carol', 'dave', 'erin'], ['erin']),
      'spaces/s1/weeks/C': weekDoc('closed', ['alice', 'bob', 'carol', 'dave']),
    })
    const alice = db('alice')
    await allDenied({
      'still a space member': () => updateDoc(weekRef(db('carol'), 'P'), { members: arrayRemove('carol') }),
      'owner drops a current member': () => updateDoc(weekRef(alice, 'P'), { members: arrayRemove('carol') }),
      'after lockAt': () => updateDoc(weekRef(alice, 'A'), { members: arrayRemove('dave') }),
      'in the review window': () => updateDoc(weekRef(alice, 'R'), { members: arrayRemove('dave') }),
      'already submitted': () => updateDoc(weekRef(alice, 'R'), { members: arrayRemove('erin') }),
      'after the deadline': () => updateDoc(weekRef(alice, 'C'), { members: arrayRemove('dave') }),
      'two at once': () => updateDoc(weekRef(alice, 'P'), { members: arrayRemove('dave', 'erin') }),
      'also edits submittedBy': () => updateDoc(weekRef(alice, 'P'), { members: arrayRemove('dave'), submittedBy: ['alice'] }),
      'a stranger': () => updateDoc(weekRef(db('zoe'), 'P'), { members: arrayRemove('dave') }),
    })
  })
})

describe('weeks: submitting', () => {
  test('a participant marks self submitted inside the review window', async () => {
    await seed({ 'spaces/s1': spaceDoc(AB), 'spaces/s1/weeks/R': weekDoc('review', AB) })
    await allowed(updateDoc(weekRef(db('alice'), 'R'), { submittedBy: arrayUnion('alice') }))
  })

  test('submittedBy is limited to self, participants still in the space, inside the window, once', async () => {
    await seed({
      'spaces/s1': spaceDoc(['alice', 'bob', 'carol']),
      'spaces/s1/weeks/A': weekDoc('active', AB),
      'spaces/s1/weeks/R': weekDoc('review', ['alice', 'bob', 'dave'], ['bob']),
      'spaces/s1/weeks/C': weekDoc('closed', AB),
    })
    const alice = db('alice')
    await allDenied({
      'before reviewOpenAt': () => updateDoc(weekRef(alice, 'A'), { submittedBy: arrayUnion('alice') }),
      'after deadlineAt': () => updateDoc(weekRef(alice, 'C'), { submittedBy: arrayUnion('alice') }),
      'not a participant': () => updateDoc(weekRef(db('carol'), 'R'), { submittedBy: arrayUnion('carol') }),
      'left the space': () => updateDoc(weekRef(db('dave'), 'R'), { submittedBy: arrayUnion('dave') }),
      'for someone else': () => updateDoc(weekRef(db('bob'), 'R'), { submittedBy: arrayUnion('alice') }),
      'twice': () => updateDoc(weekRef(db('bob'), 'R'), { submittedBy: ['bob', 'bob'] }),
      'removes others': () => updateDoc(weekRef(alice, 'R'), { submittedBy: ['alice'] }),
      'also edits deadline': () => updateDoc(weekRef(alice, 'R'), { submittedBy: arrayUnion('alice'), deadlineAt: ts(Date.now() + 9 * DAY) }),
    })
  })

  test('weeks cannot be deleted or rewritten', async () => {
    await seed({ 'spaces/s1': spaceDoc(['alice']), 'spaces/s1/weeks/W': weekDoc('planning', ['alice']) })
    const alice = db('alice')
    await denied(deleteDoc(weekRef(alice, 'W')))
    await denied(updateDoc(weekRef(alice, 'W'), { lockAt: ts(Date.now() + 9 * DAY) }))
    await denied(setDoc(weekRef(alice, 'W'), weekDoc('planning', ['alice'])))
  })
})

describe('weeks: read', () => {
  test('space members read; others do not', async () => {
    await seed({ 'spaces/s1': spaceDoc(AB), 'spaces/s1/weeks/W': weekDoc('active', ['alice']) })
    await allowed(getDoc(weekRef(db('bob'), 'W')))
    await allowed(getDoc(weekRef(db('bob'), 'missing')))
    await denied(getDoc(weekRef(db('zoe'), 'W')))
    await denied(getDoc(weekRef(db(), 'W')))
  })
})
