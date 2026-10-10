// spaces/{id}/weeks/{weekId}: create (real Monday ids and bounds near now), join, submit, read.
import { describe, expect, test } from 'vitest'
import { DateTime } from 'luxon'
import {
  arrayUnion, deleteDoc, doc, getDoc, runTransaction, setDoc, updateDoc, type DocumentData, type Firestore,
} from 'firebase/firestore'
import { allDenied, allowed, DAY, denied, HOUR, spaceDoc, ts, useRulesEnv, weekDoc } from './helpers.ts'

const { db, seed } = useRulesEnv()

/** Monday (ISO week start) of the week containing now in `zone`, shifted by `weeks`. */
function mondayId(zone: string, weeks = 0): string {
  return DateTime.now().setZone(zone).startOf('week').plus({ weeks }).toISODate()!
}

/** The week doc a client creates: DST-correct local midnights, members per the lock rule. */
function newWeek(uid: string, weekId: string, zone: string, extra: DocumentData = {}): DocumentData {
  const start = DateTime.fromISO(weekId, { zone })
  const lockAt = start.plus({ days: 1 }).toMillis()
  return {
    startAt: ts(start.toMillis()),
    lockAt: ts(lockAt),
    reviewOpenAt: ts(start.plus({ days: 4 }).toMillis()),
    deadlineAt: ts(start.plus({ days: 5 }).toMillis()),
    members: Date.now() < lockAt ? [uid] : [],
    submittedBy: [],
    ...extra,
  }
}

/** Same as newWeek but with every bound shifted from the correct start by the given offsets. */
function shifted(uid: string, weekId: string, zone: string, offsets: Partial<Record<'startAt' | 'lockAt' | 'reviewOpenAt' | 'deadlineAt', number>>) {
  const base = newWeek(uid, weekId, zone)
  const out: DocumentData = { ...base }
  for (const [key, ms] of Object.entries(offsets)) out[key] = ts(base[key].toMillis() + ms)
  return out
}

/** Bounds at exact whole days from an arbitrary start instant. */
function fromStart(uid: string, startMs: number): DocumentData {
  return {
    startAt: ts(startMs),
    lockAt: ts(startMs + DAY),
    reviewOpenAt: ts(startMs + 4 * DAY),
    deadlineAt: ts(startMs + 5 * DAY),
    members: [uid],
    submittedBy: [],
  }
}

const weekRef = (fs: Firestore, weekId: string, space = 's1') => doc(fs, `spaces/${space}/weeks/${weekId}`)

describe('weeks: create', () => {
  const zones = ['Europe/Berlin', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Kolkata', 'Australia/Lord_Howe']

  test.each(zones)('this week and next week in %s', async (zone) => {
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob'], { timezone: zone }) })
    const alice = db('alice')
    const thisWeek = mondayId(zone)
    const nextWeek = mondayId(zone, 1)
    await allowed(setDoc(weekRef(alice, thisWeek), newWeek('alice', thisWeek, zone)))
    await allowed(setDoc(weekRef(alice, nextWeek), newWeek('alice', nextWeek, zone)))
    expect((await getDoc(weekRef(alice, nextWeek))).data()?.members).toEqual(['alice'])
  })

  test('members must be [self] before lockAt and [] after', async () => {
    const zone = 'Europe/Berlin'
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob']) })
    const alice = db('alice')
    const thisWeek = mondayId(zone)
    const nextWeek = mondayId(zone, 1)
    const thisLocked = Date.now() >= DateTime.fromISO(thisWeek, { zone }).plus({ days: 1 }).toMillis()
    await allDenied({
      'this week, members flipped': () =>
        setDoc(weekRef(alice, thisWeek), newWeek('alice', thisWeek, zone, { members: thisLocked ? ['alice'] : [] })),
      'next week, no members': () => setDoc(weekRef(alice, nextWeek), newWeek('alice', nextWeek, zone, { members: [] })),
      'next week, someone else': () => setDoc(weekRef(alice, nextWeek), newWeek('alice', nextWeek, zone, { members: ['bob'] })),
      'next week, self and another': () =>
        setDoc(weekRef(alice, nextWeek), newWeek('alice', nextWeek, zone, { members: ['alice', 'bob'] })),
    })
  })

  test('DST: bounds may differ from whole days by up to 2h', async () => {
    const zone = 'Europe/Berlin'
    await seed({ 'spaces/s1': spaceDoc(['alice']) })
    const nextWeek = mondayId(zone, 1)
    await allowed(
      setDoc(weekRef(db('alice'), nextWeek), shifted('alice', nextWeek, zone, { reviewOpenAt: HOUR, deadlineAt: HOUR })),
    )
  })

  test('startAt must be within 14h of the Monday at 00:00 UTC', async () => {
    await seed({ 'spaces/s1': spaceDoc(['alice']), 'spaces/s2': spaceDoc(['alice']), 'spaces/s3': spaceDoc(['alice']) })
    const alice = db('alice')
    const next = mondayId('UTC', 1)
    const utcMidnight = Date.parse(`${next}T00:00:00Z`)
    await allowed(setDoc(weekRef(alice, next, 's1'), fromStart('alice', utcMidnight + 14 * HOUR)))
    await allowed(setDoc(weekRef(alice, next, 's2'), fromStart('alice', utcMidnight - 14 * HOUR)))
    await allDenied({
      '+15h': () => setDoc(weekRef(alice, next, 's3'), fromStart('alice', utcMidnight + 15 * HOUR)),
      '-15h': () => setDoc(weekRef(alice, next, 's3'), fromStart('alice', utcMidnight - 15 * HOUR)),
    })
  })

  test('inconsistent or out-of-range weeks are rejected', async () => {
    const zone = 'Europe/Berlin'
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob']) })
    const alice = db('alice')
    const next = mondayId(zone, 1)
    const nextTuesday = DateTime.fromISO(next).plus({ days: 1 }).toISODate()!
    const tooFar = mondayId(zone, 3)
    const tooOld = mondayId(zone, -2)
    const create = (weekId: string, data: DocumentData) => () => setDoc(weekRef(alice, weekId), data)
    await allDenied({
      'weekId is a Tuesday': create(nextTuesday, newWeek('alice', nextTuesday, zone)),
      'weekId has a suffix': create(`${next}x`, newWeek('alice', next, zone)),
      'weekId not a date': create('next-week', newWeek('alice', next, zone)),
      'impossible date': create('2026-02-30', newWeek('alice', next, zone)),
      'startAt a day early': create(next, shifted('alice', next, zone, { startAt: -DAY, lockAt: -DAY, reviewOpenAt: -DAY, deadlineAt: -DAY })),
      'lockAt +3h': create(next, shifted('alice', next, zone, { lockAt: 3 * HOUR })),
      'lockAt a day late': create(next, shifted('alice', next, zone, { lockAt: DAY })),
      'reviewOpenAt -3h': create(next, shifted('alice', next, zone, { reviewOpenAt: -3 * HOUR })),
      'deadlineAt a day late': create(next, shifted('alice', next, zone, { deadlineAt: DAY })),
      'startAt is a number': create(next, newWeek('alice', next, zone, { startAt: Date.now() })),
      'submittedBy not empty': create(next, newWeek('alice', next, zone, { submittedBy: ['alice'] })),
      'extra key': create(next, newWeek('alice', next, zone, { bonus: 1 })),
      'missing deadlineAt': create(next, (({ deadlineAt: _, ...rest }) => rest)(newWeek('alice', next, zone))),
      'three weeks ahead': create(tooFar, newWeek('alice', tooFar, zone)),
      'two weeks ago': create(tooOld, newWeek('alice', tooOld, zone)),
      'non-member': () => setDoc(weekRef(db('zoe'), next), newWeek('zoe', next, zone)),
      'signed out': () => setDoc(weekRef(db(), next), newWeek('alice', next, zone, { members: [] })),
    })
  })

  test('create inside a transaction (read, then create)', async () => {
    const zone = 'Europe/Berlin'
    await seed({ 'spaces/s1': spaceDoc(['alice']) })
    const alice = db('alice')
    const next = mondayId(zone, 1)
    await allowed(
      runTransaction(alice, async (tx) => {
        const snap = await tx.get(weekRef(alice, next))
        if (!snap.exists()) tx.set(weekRef(alice, next), newWeek('alice', next, zone))
      }),
    )
  })
})

describe('weeks: update', () => {
  test('a space member joins the week before lockAt', async () => {
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob', 'carol']), 'spaces/s1/weeks/W': weekDoc('planning', ['alice']) })
    await allowed(updateDoc(weekRef(db('bob'), 'W'), { members: arrayUnion('bob') }))
    const carol = db('carol')
    await allowed(
      runTransaction(carol, async (tx) => {
        const snap = await tx.get(weekRef(carol, 'W'))
        if (!snap.data()?.members.includes('carol')) tx.update(weekRef(carol, 'W'), { members: arrayUnion('carol') })
      }),
    )
  })

  test('joining the week is limited to self, members, before lockAt', async () => {
    await seed({
      'spaces/s1': spaceDoc(['alice', 'bob']),
      'spaces/s1/weeks/W': weekDoc('planning', ['alice']),
      'spaces/s1/weeks/L': weekDoc('active', ['alice']),
    })
    const bob = db('bob')
    await allDenied({
      'after lockAt': () => updateDoc(weekRef(bob, 'L'), { members: arrayUnion('bob') }),
      'not a space member': () => updateDoc(weekRef(db('zoe'), 'W'), { members: arrayUnion('zoe') }),
      'adds someone else': () => updateDoc(weekRef(db('alice'), 'W'), { members: arrayUnion('bob') }),
      'replaces members': () => updateDoc(weekRef(bob, 'W'), { members: ['bob'] }),
      'already a member': () => updateDoc(weekRef(db('alice'), 'W'), { members: arrayUnion('alice') }),
      'also moves lockAt': () => updateDoc(weekRef(bob, 'W'), { members: arrayUnion('bob'), lockAt: ts(Date.now() + 9 * DAY) }),
      'also submits': () => updateDoc(weekRef(bob, 'W'), { members: arrayUnion('bob'), submittedBy: arrayUnion('bob') }),
    })
  })

  test('a participant marks self submitted inside the review window', async () => {
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob']), 'spaces/s1/weeks/R': weekDoc('review', ['alice', 'bob']) })
    await allowed(updateDoc(weekRef(db('alice'), 'R'), { submittedBy: arrayUnion('alice') }))
  })

  test('submittedBy is limited to self, participants, inside the window, once', async () => {
    await seed({
      'spaces/s1': spaceDoc(['alice', 'bob', 'carol']),
      'spaces/s1/weeks/A': weekDoc('active', ['alice', 'bob']),
      'spaces/s1/weeks/R': weekDoc('review', ['alice', 'bob'], ['bob']),
      'spaces/s1/weeks/C': weekDoc('closed', ['alice', 'bob']),
    })
    const alice = db('alice')
    await allDenied({
      'before reviewOpenAt': () => updateDoc(weekRef(alice, 'A'), { submittedBy: arrayUnion('alice') }),
      'after deadlineAt': () => updateDoc(weekRef(alice, 'C'), { submittedBy: arrayUnion('alice') }),
      'not a participant': () => updateDoc(weekRef(db('carol'), 'R'), { submittedBy: arrayUnion('carol') }),
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
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob']), 'spaces/s1/weeks/W': weekDoc('active', ['alice']) })
    await allowed(getDoc(weekRef(db('bob'), 'W')))
    await allowed(getDoc(weekRef(db('bob'), 'missing')))
    await denied(getDoc(weekRef(db('zoe'), 'W')))
    await denied(getDoc(weekRef(db(), 'W')))
  })
})
