// sharedGoals/{goalId} and sharedGoals/{goalId}/checkins/{weekId}_{uid} (SPEC §11.3–§11.5): members and
// invitees read a goal; the owner invites friends, edits and finishes; invitees join or decline; members
// check in once a week, the check-in and the goal's totals in one batch; anyone leaves, and the last one
// out finishes it. Amounts are ints in hundredths.
import { describe, expect, test } from 'vitest'
import {
  arrayRemove, arrayUnion, collection, deleteDoc, deleteField, doc, getDoc, getDocs, query, runTransaction, serverTimestamp,
  setDoc, Timestamp, updateDoc, where, writeBatch, type DocumentData, type Firestore,
} from 'firebase/firestore'
import { applyCheckin, checkinClosesAt, cleanNote, goalProblem, toHundredths } from '../../src/domain/shared.ts'
import { decodeSharedGoal } from '../../src/domain/decode.ts'
import {
  addDays, allDenied, allowed, anchorOf, DAY, denied, goalDoc, GOAL_ZONE, HOUR, newGoalDoc, offsetNow, pairEntry, profileDoc,
  PUBLISHED_RULES, ts, useRulesEnv, weekOfClock,
} from './helpers.ts'

const { db, seed, clear } = useRulesEnv()

const now = () => serverTimestamp()
/** alice < bob < … < ivy < kim < zed (string order). zed is a stranger; kim has a pending request. */
const PEOPLE = ['alice', 'bob', 'cleo', 'dan', 'eve', 'fay', 'gus', 'hal', 'ivy', 'kim', 'zed']
const people = (): Record<string, DocumentData> => Object.fromEntries(PEOPLE.map((u) => [`users/${u}`, profileDoc(u)]))
/** `me` and each of `others` are friends. */
const friendsOf = (me: string, others: string[]): Record<string, DocumentData> => Object.fromEntries(others.map((o) => pairEntry(me, o)))

/** The goals' stored offset (as if created in Berlin, see storedGoal): Berlin's own, or 6 hours less when now is
 *  within 3 hours of a Monday 00:00 on that clock, so "last week" and "next week" are never inside the hour of slack
 *  on either side of this week (a run near midnight on a Sunday would otherwise see them allowed, as designed). */
const OFF = ((base: number) => {
  const sinceMonday = (off: number) => {
    const local = Date.now() + off * 60_000
    return (local - Date.parse(`${weekOfClock(Date.now(), off)}T00:00:00Z`)) / 60_000
  }
  const m = sinceMonday(base)
  return m >= 180 && m <= 7 * 1440 - 180 ? base : base - 360
})(offsetNow(GOAL_ZONE))
/** This week on the goals' clock, as the rules see it. */
const W = weekOfClock(Date.now(), OFF)
const LAST = addDays(W, -7)
const NEXT = addDays(W, 7)
const ago = (ms: number) => ts(Date.now() - ms)
/** The day ('YYYY-MM-DD') on the goals' clock `ms` from now. */
const localDay = (ms = 0) => new Date(Date.now() + ms + OFF * 60_000).toISOString().slice(0, 10)

/** A shared goal as stored (helpers' goalDoc) on the offset OFF. */
const storedGoal = (extra: DocumentData = {}): DocumentData => goalDoc({ utcOffsetMin: OFF, ...extra })
const goalRef = (fs: Firestore, id = 'g1') => doc(fs, `sharedGoals/${id}`)
const ciRef = (fs: Firestore, cid: string, goalId = 'g1') => doc(fs, `sharedGoals/${goalId}/checkins/${cid}`)
const checkins = (fs: Firestore, goalId = 'g1') => collection(fs, `sharedGoals/${goalId}/checkins`)
/** A check-in as stored. */
const ciDoc = (uid: string, amount100: number, weekId = W, note = ''): DocumentData => ({ uid, weekId, amount100, note, at: ago(HOUR) })

type BatchOpts = { weekId?: string; note?: string; goalFirst?: boolean; goalId?: string; ci?: DocumentData; cid?: string; last?: DocumentData }
/** The check-in batch, written by hand: `me`'s check-in for the week and the goal's `patch` with `last`
 *  naming it. `goalFirst` puts the goal's update first in the batch. */
function checkinBatch(fs: Firestore, me: string, amount100: number, patch: DocumentData, o: BatchOpts = {}) {
  const weekId = o.weekId ?? W
  const b = writeBatch(fs)
  const ci = () => b.set(ciRef(fs, o.cid ?? `${weekId}_${me}`, o.goalId), { uid: me, weekId, amount100, note: o.note ?? '', at: now(), ...o.ci })
  const goal = () => b.update(goalRef(fs, o.goalId), { last: o.last ?? { by: me, weekId, at: now() }, ...patch })
  if (o.goalFirst) {
    goal()
    ci()
  } else {
    ci()
    goal()
  }
  return b.commit()
}

/** What checkIn does (SPEC §11.8): a transaction reads the goal and my check-in for the week, then
 *  writes the check-in and the goal per the domain's applyCheckin. */
function checkInTx(fs: Firestore, me: string, amount100: number, weekId = W, note = '', goalId = 'g1') {
  return runTransaction(fs, async (tx) => {
    const g = (await tx.get(goalRef(fs, goalId))).data()!
    const c = await tx.get(ciRef(fs, `${weekId}_${me}`, goalId))
    const old = c.exists() ? (c.get('amount100') as number) : 0
    const reachedAt = g.reachedAt === null ? null : (g.reachedAt as Timestamp).toMillis()
    const r = applyCheckin({ totals100: g.totals100, total100: g.total100, target100: g.target100, reachedAt }, me, old, amount100)
    const patch: DocumentData = { [`totals100.${me}`]: r.totals100[me], total100: r.total100, last: { by: me, weekId, at: now() } }
    if (r.reached === 'now') patch.reachedAt = now()
    if (r.reached === 'none' && reachedAt !== null) patch.reachedAt = null
    tx.set(ciRef(fs, `${weekId}_${me}`, goalId), { uid: me, weekId, amount100, note, at: now() })
    tx.update(goalRef(fs, goalId), patch)
    return r
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** A stored offset that puts now `afterMs` (+ less than 45 s) after 00:00 of day `id` on the goal's
 *  clock: the rules' bounds are tested on the real clock with offsets chosen for them. */
async function offsetPutting(id: string, afterMs: number): Promise<number> {
  for (;;) {
    const base = Date.now() - Date.parse(`${id}T00:00:00Z`)
    const off = Math.ceil((afterMs - base) / 60_000)
    const r = base + off * 60_000 - afterMs
    if (r < 45_000) return off
    await sleep(60_000 - r + 500)
  }
}

describe('reading goals', () => {
  test('members and invitees read a goal and list theirs; nobody else does', async () => {
    await seed({ ...people(), 'sharedGoals/g1': storedGoal(), 'sharedGoals/g2': storedGoal({ memberIds: ['dan'], invited: [], ownerId: 'dan' }) })
    await allowed(getDoc(goalRef(db('alice'))))
    await allowed(getDoc(goalRef(db('bob'))))
    await allowed(getDoc(goalRef(db('cleo'))))
    const mine = await getDocs(query(collection(db('alice'), 'sharedGoals'), where('memberIds', 'array-contains', 'alice')))
    expect(mine.docs.map((d) => d.id)).toEqual(['g1'])
    const invites = await getDocs(query(collection(db('cleo'), 'sharedGoals'), where('invited', 'array-contains', 'cleo')))
    expect(invites.docs.map((d) => d.id)).toEqual(['g1'])
    await allDenied({
      'a stranger reading a goal': () => getDoc(goalRef(db('zed'))),
      'signed out': () => getDoc(goalRef(db())),
      'a member of another goal reading it': () => getDoc(goalRef(db('dan'))),
      'an unconstrained list': () => getDocs(collection(db('alice'), 'sharedGoals')),
      'listing someone else\'s goals': () => getDocs(query(collection(db('zed'), 'sharedGoals'), where('memberIds', 'array-contains', 'alice'))),
      'listing someone else\'s invitations': () => getDocs(query(collection(db('zed'), 'sharedGoals'), where('invited', 'array-contains', 'cleo'))),
      'the job\'s query from a client': () => getDocs(query(collection(db('alice'), 'sharedGoals'), where('archivedAt', '==', null))),
      'a missing goal': () => getDoc(goalRef(db('alice'), 'nothere')),
    })
  })
})

describe('creating a goal', () => {
  const FRIENDS = PEOPLE.slice(1, 9) // bob … ivy: 8 friends
  const setup = () => seed({ ...people(), ...friendsOf('alice', FRIENDS), ...friendsOf('hal', ['bob']), ...Object.fromEntries([pairEntry('alice', 'kim', 'asked', 'alice')]) })

  test('anyone creates a goal, inviting up to 7 friends', async () => {
    await setup()
    const alice = db('alice')
    await allowed(setDoc(goalRef(alice, 'Xk3p9QmZ2aBcD4eF5gH6'), newGoalDoc('alice', FRIENDS.slice(0, 7))))
    await allowed(setDoc(goalRef(alice, 'g2'), newGoalDoc('alice')))
    await allowed(setDoc(goalRef(alice, 'A'.repeat(40)), newGoalDoc('alice', ['ivy'], {
      name: 'Ж'.repeat(60), unit: 'U'.repeat(16), target100: 100_000_000_000, endsOn: '2027-02-28', timezone: 'America/Argentina/Buenos_Aires', utcOffsetMin: -180,
      zones: { alice: 'America/Argentina/Buenos_Aires' },
    })))
    await allowed(setDoc(goalRef(alice, 'g3'), newGoalDoc('alice', [], { unit: 'USD', target100: toHundredths(5000.5), utcOffsetMin: 840, timezone: 'Pacific/Kiritimati', zones: { alice: 'Pacific/Kiritimati' } })))
    // A creator whose uid sorts after the invitee's (the pair id is theirs first).
    await allowed(setDoc(goalRef(db('hal'), 'g4'), newGoalDoc('hal', ['bob'], { zones: { hal: GOAL_ZONE } })))
    // The invitees read it before joining.
    await allowed(getDoc(goalRef(db('hal'), 'Xk3p9QmZ2aBcD4eF5gH6')))
  })

  test('goals that aren\'t a fresh goal of mine with my friends invited are refused', async () => {
    await setup()
    const alice = db('alice')
    const create = (extra: DocumentData, invited: string[] = ['bob'], id = 'g1') => () => setDoc(goalRef(alice, id), newGoalDoc('alice', invited, extra))
    const { endsOn: _, ...noEndsOn } = newGoalDoc('alice')
    await allDenied({
      'a goal id with _': create({}, ['bob'], 'g_1'),
      'a goal id with #': create({}, ['bob'], 'g#1'),
      'a goal id with -': create({}, ['bob'], 'g-1'),
      'a goal id of 41 characters': create({}, ['bob'], 'A'.repeat(41)),
      'a non-friend invitee': create({}, ['zed']),
      'an invitee with a pending request': create({}, ['kim']),
      'a friend and a non-friend': create({}, ['bob', 'zed']),
      '8 invitees': create({}, FRIENDS),
      '7 invitees, the last not a friend': create({}, [...FRIENDS.slice(0, 6), 'zed']),
      'itself invited': create({}, ['alice', 'bob']),
      'a friend invited twice': create({}, ['bob', 'bob']),
      'invited not a list': create({ invited: { bob: true } }, []),
      'memberIds other than [me] (two)': create({ memberIds: ['alice', 'bob'] }),
      'memberIds other than [me] (someone else)': create({ memberIds: ['bob'] }),
      'memberIds other than [me] (none)': create({ memberIds: [] }),
      'non-empty totals': create({ totals100: { alice: 100 } }),
      'a total other than 0': create({ total100: 100 }),
      'zones naming someone else': create({ zones: { bob: GOAL_ZONE } }),
      'zones naming me and someone else': create({ zones: { alice: GOAL_ZONE, bob: GOAL_ZONE } }),
      'zones differing from timezone': create({ zones: { alice: 'Asia/Tokyo' } }),
      'no zones': create({ zones: {} }),
      'a malformed timezone': create({ timezone: 'Europe/Berlin; x', zones: { alice: 'Europe/Berlin; x' } }),
      'an empty timezone': create({ timezone: '', zones: { alice: '' } }),
      'a 65-character timezone': create({ timezone: 'A'.repeat(65), zones: { alice: 'A'.repeat(65) } }),
      'an offset out of range': create({ utcOffsetMin: 841 }),
      'a fractional offset': create({ utcOffsetMin: 60.5 }),
      'someone else as owner': create({ ownerId: 'bob' }),
      'someone else as creator': create({ createdBy: 'bob' }),
      'a client join time': create({ joinedAt: { alice: Timestamp.now() } }),
      'someone else\'s join time': create({ joinedAt: { alice: now(), bob: now() } }),
      'a former member': create({ leftAt: { bob: ago(DAY) } }),
      'a check-in already': create({ last: { by: 'alice', weekId: W, at: now() } }),
      'already reached': create({ reachedAt: now() }),
      'already finished': create({ archivedAt: now() }),
      'a client creation time': create({ createdAt: Timestamp.now() }),
      'a missing key': () => setDoc(goalRef(alice), noEndsOn),
      'an extra key': create({ stakes: 'Dinner' }),
      'a 61-character name': create({ name: 'N'.repeat(61) }),
      'a blank name': create({ name: '   ' }),
      'a name with only line breaks': create({ name: '\n\t\r' }),
      'a name that isn\'t text': create({ name: 60 }),
      'a list as the name': create({ name: ['Run'] }),
      'a 17-character unit': create({ unit: 'U'.repeat(17) }),
      'a blank unit': create({ unit: ' ' }),
      'a target of 0': create({ target100: 0 }),
      'a fractional target': create({ target100: 1000.5 }),
      'a target over a billion': create({ target100: 100_000_000_001 }),
      'a target as text': create({ target100: '10000' }),
      'an end date of month 13': create({ endsOn: '2026-13-01' }),
      'an end date that doesn\'t exist': create({ endsOn: '2027-02-30' }),
      'an end date that isn\'t a date': create({ endsOn: 'next week' }),
      'an end date as a timestamp': create({ endsOn: Timestamp.now() }),
      'signed out': () => setDoc(goalRef(db()), newGoalDoc('alice')),
    })
  })
})

// "Not blank" for a goal's name and unit is JavaScript's trim(): the app's goalProblem and decodeSharedGoal use it.
// The rules spell trim()'s characters out (shows()), so a name the rules take is never one every client drops (a
// goal that vanished for its members while the rules kept it), and nothing the app sends is refused.
describe('the rules, the app and the decoder agree on blank names and units', () => {
  /** The rules' shows() regex, as a JavaScript one (RE2's \x{…} is \u{…}; (?s) is the s flag). */
  const showsRegex = (): RegExp => {
    const m = /function shows\(s\) \{\s*return s\.matches\('\(\?s\)(.*)'\);/.exec(PUBLISHED_RULES)
    if (!m) throw new Error('shows() not found in firestore.rules')
    return new RegExp(`^(?:${m[1]!.replaceAll('\\\\', '\\').replaceAll('\\x{', '\\u{')})$`, 'su')
  }

  test('the rules\' class is exactly the characters trim() keeps, over every code point', () => {
    const re = showsRegex()
    const disagree: string[] = []
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      const c = String.fromCodePoint(cp)
      if (re.test(c) !== (c.trim() !== '')) disagree.push(cp.toString(16))
    }
    expect(disagree).toEqual([])
    // Something that shows anywhere is enough; only trim()'s characters, however many, are blank.
    expect(re.test(' 　​﻿')).toBe(true)
    expect(re.test('  　﻿\t\n')).toBe(false)
  })

  test('each of trim()\'s characters and its neighbours, as a name and as a unit, in the emulator', async () => {
    await seed(people())
    const trimmed = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]
    const points = new Set<number>()
    for (const cp of trimmed) for (const p of [cp - 1, cp, cp + 1]) if (p > 0) points.add(p)
    // Lookalikes trim() keeps: next line, Mongolian vowel separator, zero-width space, word joiner, Hangul filler.
    for (const p of [0x85, 0x180e, 0x200b, 0x2060, 0x3164]) points.add(p)
    const alice = db('alice')
    const toMs = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : null)
    const disagree: string[] = []
    let n = 0
    for (const cp of points) {
      const c = String.fromCodePoint(cp)
      for (const field of ['name', 'unit'] as const) {
        const id = `b${n++}`
        let ok = true
        try {
          await setDoc(goalRef(alice, id), newGoalDoc('alice', [], { [field]: c }))
        } catch {
          ok = false
        }
        const app = goalProblem({ name: field === 'name' ? c : 'Run', unit: field === 'unit' ? c : 'km', target: 100 }) === null
        if (ok !== app) disagree.push(`${field} U+${cp.toString(16)}: rules ${ok ? 'accept' : 'refuse'}, app ${app ? 'accepts' : 'refuses'}`)
        if (ok) {
          const stored = (await getDoc(goalRef(alice, id))).data()
          if (decodeSharedGoal(id, stored, toMs) === null) disagree.push(`${field} U+${cp.toString(16)}: the rules accept it, the decoder drops the goal`)
        }
      }
    }
    expect(disagree).toEqual([])
  })
})

describe('checking in', () => {
  test('a member checks in: the check-in and the goal\'s totals in one batch, in either order', async () => {
    await seed({ ...people(), 'sharedGoals/g1': storedGoal() })
    await allowed(checkinBatch(db('alice'), 'alice', 1250, { 'totals100.alice': 4250, total100: 6750 }, { note: 'Long run on Sunday' }))
    await allowed(checkinBatch(db('bob'), 'bob', 300, { 'totals100.bob': 2800, total100: 7050 }, { goalFirst: true }))
    const g = (await getDoc(goalRef(db('alice')))).data()!
    expect(g.totals100).toEqual({ alice: 4250, bob: 2800 })
    expect(g.total100).toBe(7050)
    expect(g.last.by).toBe('bob')
  })

  test('a first check-in with no part yet, a 0 and the largest amount', async () => {
    await seed({ ...people(), 'sharedGoals/g1': storedGoal({ totals100: { alice: 3000 }, total100: 3000, target100: 100_000_000_000 }) })
    await allowed(checkinBatch(db('bob'), 'bob', 0, { 'totals100.bob': 0, total100: 3000 }))
    await allowed(checkinBatch(db('bob'), 'bob', 100_000_000_000, { 'totals100.bob': 100_000_000_000, total100: 100_000_003_000, reachedAt: now() }))
  })

  test('editing this week\'s check-in replaces it: the totals move by the difference, down too', async () => {
    await seed({
      ...people(),
      'sharedGoals/g1': storedGoal({ totals100: { alice: 4250, bob: 2500 }, total100: 6750 }),
      [`sharedGoals/g1/checkins/${W}_alice`]: ciDoc('alice', 1250),
    })
    // A negative delta: 12.50 km becomes 10 km.
    await allowed(checkinBatch(db('alice'), 'alice', 1000, { 'totals100.alice': 4000, total100: 6500 }, { note: 'Fixed a typo' }))
    await allowed(checkinBatch(db('alice'), 'alice', 2000, { 'totals100.alice': 5000, total100: 7500 }, { goalFirst: true }))
  })

  test('the app\'s transaction: amounts with decimals stay exact', async () => {
    await seed({ ...people(), 'sharedGoals/g1': storedGoal({ totals100: {}, total100: 0 }) })
    await allowed(checkInTx(db('alice'), 'alice', toHundredths(0.1)))
    await allowed(checkInTx(db('bob'), 'bob', toHundredths(0.2)))
    await allowed(checkInTx(db('alice'), 'alice', toHundredths(12.5), W, 'Edited'))
    const g = (await getDoc(goalRef(db('alice')))).data()!
    expect(g.total100).toBe(1270)
    expect(g.totals100).toEqual({ alice: 1250, bob: 20 })
  })

  test('the check-in that reaches the target sets reachedAt; later ones keep it; an edit back below clears it', async () => {
    await seed({ ...people(), 'sharedGoals/g1': storedGoal({ totals100: { alice: 5000, bob: 4500 }, total100: 9500 }) })
    const alice = db('alice')
    expect((await checkInTx(alice, 'alice', 600)).reached).toBe('now')
    const reachedAt = (await getDoc(goalRef(alice))).get('reachedAt') as Timestamp
    expect(reachedAt).not.toBeNull()
    expect((await checkInTx(db('bob'), 'bob', 100)).reached).toBe('keep')
    expect(((await getDoc(goalRef(alice))).get('reachedAt') as Timestamp).isEqual(reachedAt)).toBe(true)
    // Alice's 6 km were 0: back below the target.
    expect((await checkInTx(alice, 'alice', 0)).reached).toBe('none')
    expect((await getDoc(goalRef(alice))).get('reachedAt')).toBeNull()
    expect((await checkInTx(alice, 'alice', 500)).reached).toBe('now')
    // Exactly the target counts as reached.
    await seed({ 'sharedGoals/g2': storedGoal({ totals100: { alice: 5000, bob: 4500 }, total100: 9500 }) })
    await allowed(checkinBatch(alice, 'alice', 500, { 'totals100.alice': 5500, total100: 10_000, reachedAt: now() }, { goalId: 'g2' }))
  })

  test('the note: one line of 0-80 characters, as the app\'s cleanNote leaves it', async () => {
    await seed({ ...people(), 'sharedGoals/g1': storedGoal() })
    const alice = db('alice')
    const raw = ['Long run\non Sunday', 'Two\r\nlines', 'Line\u2028separator', 'Para\u2029graph', '  Tabs\tand\u0085NEL\u000bvt  \n']
    for (const note of raw) {
      await denied(checkinBatch(alice, 'alice', 1250, { 'totals100.alice': 4250, total100: 6750 }, { note }))
      expect(cleanNote(note)).not.toMatch(/[\r\n\u2028\u2029]/)
      await allowed(checkinBatch(alice, 'alice', 1250, { 'totals100.alice': 4250, total100: 6750 }, { note: cleanNote(note) }))
    }
    await allowed(checkinBatch(alice, 'alice', 1250, { 'totals100.alice': 4250, total100: 6750 }, { note: 'Ж'.repeat(80) }))
  })

  test('check-ins that aren\'t this week\'s part of a current member, with its totals, are refused', async () => {
    await seed({
      ...people(),
      'sharedGoals/g1': storedGoal({ totals100: { alice: 4250, bob: 2500 }, total100: 6750, reachedAt: null }),
      [`sharedGoals/g1/checkins/${W}_alice`]: ciDoc('alice', 1250),
      [`sharedGoals/g1/checkins/${W}_bob`]: ciDoc('bob', 500),
      'sharedGoals/done': storedGoal({ archivedAt: ago(HOUR) }),
      'sharedGoals/ended': storedGoal({ endsOn: localDay(-2 * DAY) }),
    })
    const [alice, bob] = [db('alice'), db('bob')]
    const plus100 = { 'totals100.alice': 4350, total100: 6850 } // alice from 12.50 to 13.50
    const fresh100 = { 'totals100.alice': 4350, total100: 6850 } // a new week's 1.00 km
    await allDenied({
      'a check-in for last week': () => checkinBatch(alice, 'alice', 100, fresh100, { weekId: LAST }),
      'a check-in for next week': () => checkinBatch(alice, 'alice', 100, fresh100, { weekId: NEXT }),
      'a check-in for a Tuesday': () => checkinBatch(alice, 'alice', 100, fresh100, { weekId: addDays(W, 1) }),
      'a check-in for someone else': () => checkinBatch(alice, 'alice', 1350, { 'totals100.bob': 3350, total100: 7600 }, { ci: { uid: 'bob' }, cid: `${W}_bob` }),
      'a check-in for someone else, in their name throughout': () => checkinBatch(alice, 'bob', 1350, { 'totals100.bob': 3350, total100: 7600 }),
      'my check-in under someone else\'s id': () => checkinBatch(alice, 'alice', 1350, plus100, { cid: `${W}_bob` }),
      'my check-in naming someone else as its author': () => checkinBatch(alice, 'alice', 1350, plus100, { ci: { uid: 'bob' } }),
      'a second check-in under another id in the same batch': () => {
        const b = writeBatch(alice)
        b.set(ciRef(alice, `${W}_alice`), { uid: 'alice', weekId: W, amount100: 1350, note: '', at: now() })
        b.set(ciRef(alice, `${W}_alice2`), { uid: 'alice', weekId: W, amount100: 9999, note: '', at: now() })
        b.update(goalRef(alice), { ...plus100, last: { by: 'alice', weekId: W, at: now() } })
        return b.commit()
      },
      'a negative amount': () => checkinBatch(alice, 'alice', -100, { 'totals100.alice': 2900, total100: 5400 }),
      'a fractional amount': () => checkinBatch(alice, 'alice', 1250.5, { 'totals100.alice': 4250.5, total100: 6750.5 }),
      'a too-large amount': () => checkinBatch(alice, 'alice', 100_000_000_001, { 'totals100.alice': 100_000_003_001, total100: 100_000_005_501, reachedAt: now() }),
      'an amount as text': () => checkinBatch(alice, 'alice', '1350' as unknown as number, plus100),
      'a note with a line break': () => checkinBatch(alice, 'alice', 1350, plus100, { note: 'Long run\non Sunday' }),
      'a note of 81 characters': () => checkinBatch(alice, 'alice', 1350, plus100, { note: 'N'.repeat(81) }),
      'a note that isn\'t text': () => checkinBatch(alice, 'alice', 1350, plus100, { ci: { note: 5 } }),
      'without a note': () => {
        const b = writeBatch(alice)
        b.set(ciRef(alice, `${W}_alice`), { uid: 'alice', weekId: W, amount100: 1350, at: now() })
        b.update(goalRef(alice), { ...plus100, last: { by: 'alice', weekId: W, at: now() } })
        return b.commit()
      },
      'a client time on the check-in': () => checkinBatch(alice, 'alice', 1350, plus100, { ci: { at: Timestamp.now() } }),
      'an extra key on the check-in': () => checkinBatch(alice, 'alice', 1350, plus100, { ci: { photo: 'x' } }),
      'the check-in without the goal update': () => setDoc(ciRef(alice, `${W}_alice`), { uid: 'alice', weekId: W, amount100: 1350, note: '', at: now() }),
      'the goal update without the check-in': () => updateDoc(goalRef(alice), { ...plus100, last: { by: 'alice', weekId: W, at: now() } }),
      'the goal update without the check-in, claiming no change': () => updateDoc(goalRef(alice), { last: { by: 'alice', weekId: W, at: now() } }),
      'a goal update whose delta is off by one (my part)': () => checkinBatch(alice, 'alice', 1350, { 'totals100.alice': 4351, total100: 6850 }),
      'a goal update whose delta is off by one (the total)': () => checkinBatch(alice, 'alice', 1350, { 'totals100.alice': 4350, total100: 6851 }),
      'a goal update that counts the whole amount again': () => checkinBatch(alice, 'alice', 1350, { 'totals100.alice': 5600, total100: 8100 }),
      'a goal update that adds to someone else\'s part': () => checkinBatch(alice, 'alice', 1350, { 'totals100.alice': 4350, 'totals100.bob': 2600, total100: 6950 }),
      'a goal update that moves someone else\'s part': () => checkinBatch(alice, 'alice', 1350, { 'totals100.alice': 4350, 'totals100.bob': 2400, total100: 6850 }),
      'a goal update that adds a part for an invitee': () => checkinBatch(alice, 'alice', 1350, { 'totals100.alice': 4350, 'totals100.cleo': 0, total100: 6850 }),
      'last naming another week': () => checkinBatch(alice, 'alice', 1350, plus100, { last: { by: 'alice', weekId: LAST, at: now() } }),
      'last naming someone else': () => checkinBatch(alice, 'alice', 1350, plus100, { last: { by: 'bob', weekId: W, at: now() } }),
      'last with a client time': () => checkinBatch(alice, 'alice', 1350, plus100, { last: { by: 'alice', weekId: W, at: Timestamp.now() } }),
      'last with an extra key': () => checkinBatch(alice, 'alice', 1350, plus100, { last: { by: 'alice', weekId: W, at: now(), amount: 1 } }),
      'changing the target in the check-in': () => checkinBatch(alice, 'alice', 1350, { ...plus100, target100: 6000, reachedAt: now() }),
      'setting reachedAt without reaching': () => checkinBatch(alice, 'alice', 1350, { ...plus100, reachedAt: now() }),
      'reaching without setting reachedAt': () => checkinBatch(alice, 'alice', 4600, { 'totals100.alice': 7600, total100: 10_100 }),
      'two check-ins in one batch': () => {
        const b = writeBatch(alice)
        b.set(ciRef(alice, `${W}_alice`), { uid: 'alice', weekId: W, amount100: 1350, note: '', at: now() })
        b.set(ciRef(alice, `${LAST}_alice`), { uid: 'alice', weekId: LAST, amount100: 100, note: '', at: now() })
        b.update(goalRef(alice), { 'totals100.alice': 4450, total100: 6950, last: { by: 'alice', weekId: W, at: now() } })
        return b.commit()
      },
      'editing someone else\'s check-in': () => checkinBatch(alice, 'alice', 600, { 'totals100.bob': 2600, total100: 6850 }, { ci: { uid: 'bob' }, cid: `${W}_bob` }),
      'a check-in after archivedAt': () => checkinBatch(alice, 'alice', 100, { 'totals100.alice': 3100, total100: 5600 }, { goalId: 'done' }),
      'a check-in after endsOn': () => checkinBatch(alice, 'alice', 100, { 'totals100.alice': 3100, total100: 5600 }, { goalId: 'ended' }),
      'a check-in by a non-member': () => checkinBatch(db('zed'), 'zed', 100, { 'totals100.zed': 100, total100: 6850 }),
      'a check-in by an invitee': () => checkinBatch(db('cleo'), 'cleo', 100, { 'totals100.cleo': 100, total100: 6850 }),
      'deleting (to re-create) this week\'s check-in while a member': () => deleteDoc(ciRef(alice, `${W}_alice`)),
      'deleting someone else\'s check-in': () => deleteDoc(ciRef(alice, `${W}_bob`)),
      'signed out': () => checkinBatch(db(), 'alice', 1350, plus100),
    })
    // Bob's own part is untouched by all of that.
    await allowed(checkinBatch(bob, 'bob', 600, { 'totals100.bob': 2600, total100: 6850 }))
  })

  test('reachedAt can\'t be cleared or moved while the goal stays reached, nor kept below the target', async () => {
    await seed({
      ...people(),
      'sharedGoals/g1': storedGoal({ totals100: { alice: 6000, bob: 4500 }, total100: 10_500, reachedAt: ago(DAY) }),
      [`sharedGoals/g1/checkins/${W}_alice`]: ciDoc('alice', 1000),
    })
    const alice = db('alice')
    await allDenied({
      'clearing reachedAt while reached': () => checkinBatch(alice, 'alice', 1100, { 'totals100.alice': 6100, total100: 10_600, reachedAt: null }),
      'moving reachedAt to now while reached': () => checkinBatch(alice, 'alice', 1100, { 'totals100.alice': 6100, total100: 10_600, reachedAt: now() }),
      'falling below the target and keeping reachedAt': () => checkinBatch(alice, 'alice', 0, { 'totals100.alice': 5000, total100: 9500 }),
    })
    await allowed(checkinBatch(alice, 'alice', 1100, { 'totals100.alice': 6100, total100: 10_600 }))
    await allowed(checkinBatch(alice, 'alice', 0, { 'totals100.alice': 5000, total100: 9500, reachedAt: null }))
  })

  test('a goal that ends today still takes check-ins', async () => {
    await seed({ ...people(), 'sharedGoals/g1': storedGoal({ endsOn: localDay() }) })
    await allowed(checkinBatch(db('alice'), 'alice', 100, { 'totals100.alice': 3100, total100: 5600 }))
  })
})

describe('the week\'s bounds on the real clock (stored offsets chosen for them)', () => {
  const MIN = 60_000
  const seedAt = async (off: number, extra: DocumentData = {}) => {
    await clear()
    await seed({ ...people(), 'sharedGoals/g1': storedGoal({ utcOffsetMin: off, ...extra }) })
  }
  const once = () => checkinBatch(db('alice'), 'alice', 100, { 'totals100.alice': 3100, total100: 5600 }, { weekId: W })

  test('a check-in at anchor + 7d + 59m is allowed, at + 61m refused', async () => {
    await seedAt(await offsetPutting(W, 7 * DAY + 59 * MIN))
    await allowed(once())
    await seedAt(await offsetPutting(W, 7 * DAY + 61 * MIN))
    await denied(once())
  })

  test('a check-in at anchor − 59m is allowed, at − 61m refused', async () => {
    await seedAt(await offsetPutting(W, -59 * MIN))
    await allowed(once())
    await seedAt(await offsetPutting(W, -61 * MIN))
    await denied(once())
  })

  test('the last day: endsOn + 1d + 59m is allowed, + 61m refused', async () => {
    // endsOn is the week's Monday; the week itself is open throughout.
    await seedAt(await offsetPutting(W, DAY + 59 * MIN), { endsOn: W })
    await allowed(once())
    await seedAt(await offsetPutting(W, DAY + 61 * MIN), { endsOn: W })
    await denied(once())
  })

  test('the app\'s checkinClosesAt is the rules\' upper bound', () => {
    for (const off of [-720, -420, 0, 60, 120, 330, 840]) expect(checkinClosesAt({ utcOffsetMin: off }, W)).toBe(anchorOf(W, off) + 7 * DAY + HOUR)
  })
})

describe('check-ins: reading and deleting', () => {
  const setup = () => seed({
    ...people(),
    'sharedGoals/g1': storedGoal({ leftAt: { dan: ago(HOUR) }, totals100: { alice: 3000, bob: 2500, dan: 700 }, total100: 6200 }),
    [`sharedGoals/g1/checkins/${W}_alice`]: ciDoc('alice', 1250, W, 'Long run'),
    [`sharedGoals/g1/checkins/${W}_bob`]: ciDoc('bob', 500),
    [`sharedGoals/g1/checkins/${W}_dan`]: ciDoc('dan', 700),
    [`sharedGoals/g1/checkins/${LAST}_dan`]: ciDoc('dan', 300, LAST),
  })

  test('the goal\'s current members read check-ins: a week\'s, and their own (to delete them after leaving)', async () => {
    await setup()
    const week = await getDocs(query(checkins(db('alice')), where('weekId', '==', W)))
    expect(week.size).toBe(3)
    await allowed(getDocs(query(checkins(db('bob')), where('uid', '==', 'bob'))))
    await allowed(getDoc(ciRef(db('bob'), `${W}_alice`)))
    await allDenied({
      'an invitee reading check-ins': () => getDocs(query(checkins(db('cleo')), where('weekId', '==', W))),
      'a stranger reading check-ins': () => getDocs(query(checkins(db('zed')), where('weekId', '==', W))),
      'a former member reading check-ins': () => getDocs(query(checkins(db('dan')), where('uid', '==', 'dan'))),
      'a stranger reading one check-in': () => getDoc(ciRef(db('zed'), `${W}_alice`)),
      'signed out': () => getDoc(ciRef(db(), `${W}_alice`)),
    })
  })

  test('only after leaving, the author deletes their check-ins', async () => {
    await setup()
    await allDenied({
      'deleting my check-in while a member': () => deleteDoc(ciRef(db('alice'), `${W}_alice`)),
      'a former member deleting someone else\'s': () => deleteDoc(ciRef(db('dan'), `${W}_bob`)),
      'a stranger deleting one': () => deleteDoc(ciRef(db('zed'), `${W}_bob`)),
      'an invitee deleting one': () => deleteDoc(ciRef(db('cleo'), `${W}_bob`)),
    })
    await allowed(deleteDoc(ciRef(db('dan'), `${W}_dan`)))
    await allowed(deleteDoc(ciRef(db('dan'), `${LAST}_dan`)))
  })
})

describe('joining and declining', () => {
  test('an invitee joins with their zone', async () => {
    await seed({ ...people(), 'sharedGoals/g1': storedGoal() })
    const cleo = db('cleo')
    await allowed(updateDoc(goalRef(cleo), { invited: arrayRemove('cleo'), memberIds: arrayUnion('cleo'), 'joinedAt.cleo': now(), 'zones.cleo': 'Asia/Tokyo' }))
    const g = (await getDoc(goalRef(cleo))).data()!
    expect(g.memberIds).toEqual(['alice', 'bob', 'cleo'])
    expect(g.zones).toEqual({ alice: GOAL_ZONE, bob: 'America/New_York', cleo: 'Asia/Tokyo' })
  })

  test('a former member re-joins: their part and leftAt stay, their zone may change or stay', async () => {
    const goal = storedGoal({ memberIds: ['alice'], invited: ['bob', 'dan'], joinedAt: { alice: ago(20 * DAY) }, leftAt: { bob: ago(DAY), dan: ago(DAY) }, zones: { alice: GOAL_ZONE, bob: 'America/New_York', dan: 'Asia/Tokyo' }, totals100: { alice: 3000, bob: 2500, dan: 100 }, total100: 5600 })
    await seed({ ...people(), 'sharedGoals/g1': goal })
    await allowed(updateDoc(goalRef(db('bob')), { invited: arrayRemove('bob'), memberIds: arrayUnion('bob'), 'joinedAt.bob': now(), 'zones.bob': 'America/Chicago' }))
    await allowed(updateDoc(goalRef(db('dan')), { invited: arrayRemove('dan'), memberIds: arrayUnion('dan'), 'joinedAt.dan': now() }))
    const g = (await getDoc(goalRef(db('bob')))).data()!
    expect(g.totals100).toEqual({ alice: 3000, bob: 2500, dan: 100 })
    expect(Object.keys(g.leftAt).sort()).toEqual(['bob', 'dan'])
  })

  test('joins that aren\'t an invitee taking their own place are refused', async () => {
    const full = ['alice', 'bob', 'dan', 'eve', 'fay', 'gus', 'hal', 'ivy']
    await seed({
      ...people(),
      'sharedGoals/g1': storedGoal({ invited: ['cleo', 'dan'] }),
      'sharedGoals/done': storedGoal({ archivedAt: ago(HOUR) }),
      // A broken state (members and invitations are 8 at most): the join's own size check still holds.
      'sharedGoals/full': storedGoal({ memberIds: full, joinedAt: Object.fromEntries(full.map((u) => [u, ago(DAY)])), invited: ['cleo'] }),
    })
    const cleo = db('cleo')
    const join = (extra: DocumentData = {}, id = 'g1', fs = cleo, me = 'cleo') => () =>
      updateDoc(goalRef(fs, id), { invited: arrayRemove(me), memberIds: arrayUnion(me), [`joinedAt.${me}`]: now(), [`zones.${me}`]: 'Asia/Tokyo', ...extra })
    await allDenied({
      'joining without an invite': join({}, 'g1', db('zed'), 'zed'),
      'joining into a finished goal': join({}, 'done'),
      'joining into a full goal': join({}, 'full'),
      'a join that writes someone else\'s zone': join({ 'zones.bob': 'Asia/Tokyo' }),
      'a join that writes only someone else\'s zone': () => updateDoc(goalRef(cleo), { invited: arrayRemove('cleo'), memberIds: arrayUnion('cleo'), 'joinedAt.cleo': now(), 'zones.bob': 'Asia/Tokyo' }),
      'a join with a malformed zone': join({ 'zones.cleo': 'Asia/Tokyo; x' }),
      'a join with a zone that isn\'t text': join({ 'zones.cleo': 9 }),
      'a join without a zone': () => updateDoc(goalRef(cleo), { invited: arrayRemove('cleo'), memberIds: arrayUnion('cleo'), 'joinedAt.cleo': now() }),
      'a join with a client time': join({ 'joinedAt.cleo': Timestamp.now() }),
      'a join that keeps the invitation': () => updateDoc(goalRef(cleo), { memberIds: arrayUnion('cleo'), 'joinedAt.cleo': now(), 'zones.cleo': 'Asia/Tokyo' }),
      'a join that drops someone else\'s invitation': join({ invited: [] }),
      'a join that brings someone else': join({ memberIds: arrayUnion('cleo', 'dan') }),
      'a join that moves someone else\'s join time': join({ 'joinedAt.alice': now() }),
      'a join that takes the goal over': join({ ownerId: 'cleo' }),
      'a join that adds to the totals': join({ 'totals100.cleo': 500, total100: 6000 }),
      'a member joining again': join({}, 'g1', db('bob'), 'bob'),
      'signed out': join({}, 'g1', db()),
    })
  })

  test('an invitee declines; the owner cancels an invitation; an ended goal\'s invitation can still be declined', async () => {
    await seed({ ...people(), 'sharedGoals/g1': storedGoal({ invited: ['cleo', 'dan', 'eve'] }), 'sharedGoals/ended': storedGoal({ endsOn: '2026-01-31' }) })
    await allowed(updateDoc(goalRef(db('cleo')), { invited: arrayRemove('cleo') }))
    await allowed(updateDoc(goalRef(db('alice')), { invited: arrayRemove('dan') }))
    await allowed(updateDoc(goalRef(db('cleo'), 'ended'), { invited: arrayRemove('cleo') }))
    expect((await getDoc(goalRef(db('alice')))).get('invited')).toEqual(['eve'])
  })

  test('dropping invitations as anyone else, or swapping them, is refused', async () => {
    await seed({ ...people(), 'sharedGoals/g1': storedGoal({ invited: ['cleo', 'dan'] }) })
    await allDenied({
      'a member who isn\'t the owner canceling an invitation': () => updateDoc(goalRef(db('bob')), { invited: arrayRemove('cleo') }),
      'an invitee declining for someone else': () => updateDoc(goalRef(db('cleo')), { invited: arrayRemove('dan') }),
      'an invitee declining for everyone': () => updateDoc(goalRef(db('cleo')), { invited: [] }),
      'a stranger dropping an invitation': () => updateDoc(goalRef(db('zed')), { invited: arrayRemove('cleo') }),
      'declining and inviting someone else': () => updateDoc(goalRef(db('cleo')), { invited: ['dan', 'zed'] }),
      'the owner swapping an invitation': () => updateDoc(goalRef(db('alice')), { invited: ['cleo', 'eve'] }),
      'reordering the invitations': () => updateDoc(goalRef(db('alice')), { invited: ['dan', 'cleo'] }),
      'a decline that also moves the total': () => updateDoc(goalRef(db('cleo')), { invited: arrayRemove('cleo'), total100: 0 }),
    })
  })
})

describe('inviting', () => {
  const FRIENDS = ['cleo', 'dan', 'eve', 'fay', 'gus', 'hal', 'ivy']
  const setup = () => seed({
    ...people(),
    ...friendsOf('alice', FRIENDS),
    ...friendsOf('bob', ['dan', 'zed']),
    // Bob is a member and Alice's friend: only membership stops his invitation.
    ...Object.fromEntries([pairEntry('alice', 'bob')]),
    ...Object.fromEntries([pairEntry('alice', 'kim', 'asked', 'alice'), pairEntry('alice', 'lou', 'declined', 'alice')]),
    'sharedGoals/g1': storedGoal(),
    'sharedGoals/done': storedGoal({ archivedAt: ago(HOUR) }),
  })

  test('the owner invites friends, up to 8 people in all', async () => {
    await setup()
    await allowed(updateDoc(goalRef(db('alice')), { invited: arrayUnion('dan', 'eve') }))
    await allowed(updateDoc(goalRef(db('alice')), { invited: arrayUnion('fay', 'gus', 'hal') }))
    expect((await getDoc(goalRef(db('alice')))).get('invited')).toEqual(['cleo', 'dan', 'eve', 'fay', 'gus', 'hal'])
  })

  test('invitations from anyone but the owner, or to anyone but the owner\'s friends, are refused', async () => {
    await setup()
    const alice = db('alice')
    await allDenied({
      'inviting as a non-owner': () => updateDoc(goalRef(db('bob')), { invited: arrayUnion('dan') }),
      'inviting as an invitee': () => updateDoc(goalRef(db('cleo')), { invited: arrayUnion('dan') }),
      'inviting a non-friend (a member\'s friend)': () => updateDoc(goalRef(alice), { invited: arrayUnion('zed') }),
      'inviting a pending friend': () => updateDoc(goalRef(alice), { invited: arrayUnion('kim') }),
      'inviting someone who declined my request': () => updateDoc(goalRef(alice), { invited: arrayUnion('lou') }),
      'inviting a friend and a non-friend': () => updateDoc(goalRef(alice), { invited: arrayUnion('dan', 'kim') }),
      'inviting past 8 people': () => updateDoc(goalRef(alice), { invited: arrayUnion('dan', 'eve', 'fay', 'gus', 'hal', 'ivy') }),
      'inviting a member': () => updateDoc(goalRef(alice), { invited: arrayUnion('bob') }),
      'inviting myself': () => updateDoc(goalRef(alice), { invited: arrayUnion('alice') }),
      'inviting the same friend twice': () => updateDoc(goalRef(alice), { invited: ['cleo', 'dan', 'dan'] }),
      'inviting someone already invited again': () => updateDoc(goalRef(alice), { invited: ['cleo', 'cleo'] }),
      'inviting into a finished goal': () => updateDoc(goalRef(alice, 'done'), { invited: arrayUnion('dan') }),
      'an invitation that drops another': () => updateDoc(goalRef(alice), { invited: ['dan'] }),
      'an invitation that also edits the goal': () => updateDoc(goalRef(alice), { invited: arrayUnion('dan'), name: 'Run 200 km' }),
      'signed out': () => updateDoc(goalRef(db()), { invited: arrayUnion('dan') }),
    })
  })
})

describe('leaving', () => {
  const leave = (fs: Firestore, me: string, extra: DocumentData = {}, id = 'g1') =>
    updateDoc(goalRef(fs, id), { memberIds: arrayRemove(me), [`joinedAt.${me}`]: deleteField(), [`leftAt.${me}`]: now(), ...extra })
  /** Eight members; hal joined right after alice, so he takes over. */
  const EIGHT = ['alice', 'bob', 'cleo', 'dan', 'eve', 'fay', 'gus', 'hal']
  const joined = Object.fromEntries(EIGHT.map((u, i) => [u, ago((u === 'alice' ? 30 : u === 'hal' ? 29 : 20 - i) * DAY)]))
  const eight = (extra: DocumentData = {}) => storedGoal({ memberIds: EIGHT, invited: [], joinedAt: joined, ...extra })

  test('a member leaves; their part stays in the totals', async () => {
    await seed({ ...people(), 'sharedGoals/g1': storedGoal() })
    await allowed(leave(db('bob'), 'bob'))
    const g = (await getDoc(goalRef(db('alice')))).data()!
    expect(g.memberIds).toEqual(['alice'])
    expect(g.totals100).toEqual({ alice: 3000, bob: 2500 })
    expect(g.ownerId).toBe('alice')
  })

  test('an owner leaving a goal of 8 hands on to the earliest-joined', async () => {
    await seed({ ...people(), 'sharedGoals/g1': eight() })
    await allDenied({
      'an owner leaving who names anyone but the earliest-joined': () => leave(db('alice'), 'alice', { ownerId: 'bob' }),
      'an owner leaving who keeps the goal': () => leave(db('alice'), 'alice'),
      'an owner leaving who names a stranger': () => leave(db('alice'), 'alice', { ownerId: 'zed' }),
    })
    await allowed(leave(db('alice'), 'alice', { ownerId: 'hal' }))
  })

  test('the last member leaving finishes the goal and clears its invitations', async () => {
    await seed({
      ...people(),
      'sharedGoals/g1': storedGoal({ memberIds: ['alice'], joinedAt: { alice: ago(20 * DAY) }, invited: ['cleo', 'dan'] }),
      'sharedGoals/done': storedGoal({ memberIds: ['bob'], ownerId: 'bob', joinedAt: { bob: ago(20 * DAY) }, invited: [], archivedAt: ago(DAY) }),
    })
    const alice = db('alice')
    await allDenied({
      'the last member leaving without archiving': () => leave(alice, 'alice', { invited: [] }),
      'the last member leaving without clearing the invitations': () => leave(alice, 'alice', { archivedAt: now() }),
      'the last member leaving with a client time': () => leave(alice, 'alice', { archivedAt: Timestamp.now(), invited: [] }),
      'the last member leaving and handing the goal to an invitee': () => leave(alice, 'alice', { archivedAt: now(), invited: [], ownerId: 'cleo' }),
      'the last member leaving a finished goal re-dates it': () => leave(db('bob'), 'bob', { archivedAt: now() }, 'done'),
    })
    await allowed(leave(alice, 'alice', { archivedAt: now(), invited: [] }))
    // A finished goal's last member leaves it finished as it was.
    await allowed(leave(db('bob'), 'bob', {}, 'done'))
  })

  test('leaves that aren\'t a member taking only themselves out are refused', async () => {
    await seed({ ...people(), 'sharedGoals/g1': storedGoal({ invited: ['cleo'] }) })
    const bob = db('bob')
    await allDenied({
      'leaving without leftAt': () => updateDoc(goalRef(bob), { memberIds: arrayRemove('bob'), 'joinedAt.bob': deleteField() }),
      'leaving with a client time': () => leave(bob, 'bob', { 'leftAt.bob': Timestamp.now() }),
      'leaving and keeping the join time': () => updateDoc(goalRef(bob), { memberIds: arrayRemove('bob'), 'leftAt.bob': now() }),
      'taking someone else out': () => leave(db('alice'), 'bob'),
      'a non-member leaving': () => leave(db('cleo'), 'cleo'),
      'a stranger leaving': () => leave(db('zed'), 'zed'),
      'leaving and taking my part away': () => leave(bob, 'bob', { 'totals100.bob': 0, total100: 3000 }),
      'leaving and archiving a goal others are still in': () => leave(bob, 'bob', { archivedAt: now() }),
      'leaving and clearing invitations others still have': () => leave(bob, 'bob', { invited: [] }),
      'a member leaving who takes the goal': () => leave(bob, 'bob', { ownerId: 'cleo' }),
      'a member leaving who moves someone\'s leftAt': () => leave(bob, 'bob', { 'leftAt.alice': now() }),
      'signed out': () => leave(db(), 'bob'),
    })
  })
})

describe('editing and finishing', () => {
  test('the owner edits the text, the target and the end date; reachedAt follows the target', async () => {
    await seed({
      ...people(),
      'sharedGoals/g1': storedGoal(),
      'sharedGoals/reached': storedGoal({ totals100: { alice: 6000, bob: 4500 }, total100: 10_500, reachedAt: ago(DAY) }),
    })
    const alice = db('alice')
    await allowed(updateDoc(goalRef(alice), { name: 'Run 120 km', unit: 'miles', target100: 12_000, endsOn: '2026-12-31' }))
    await allowed(updateDoc(goalRef(alice), { endsOn: null }))
    // Lowering the target to the total reaches it now.
    await allowed(updateDoc(goalRef(alice), { target100: 5500, reachedAt: now() }))
    // Keep Going: raising the target past the total clears it.
    await allowed(updateDoc(goalRef(alice, 'reached'), { target100: 15_000, reachedAt: null }))
    // A text edit of a reached goal keeps it.
    await seed({ 'sharedGoals/reached': storedGoal({ totals100: { alice: 6000, bob: 4500 }, total100: 10_500, reachedAt: ago(DAY) }) })
    await allowed(updateDoc(goalRef(alice, 'reached'), { name: 'Run 105 km' }))
  })

  test('edits by anyone but the owner, of a finished goal, or that break the goal are refused', async () => {
    await seed({
      ...people(),
      'sharedGoals/g1': storedGoal(),
      'sharedGoals/reached': storedGoal({ totals100: { alice: 6000, bob: 4500 }, total100: 10_500, reachedAt: ago(DAY) }),
      'sharedGoals/done': storedGoal({ archivedAt: ago(HOUR) }),
    })
    const alice = db('alice')
    await allDenied({
      'editing as a non-owner': () => updateDoc(goalRef(db('bob')), { name: 'Run 200 km' }),
      'editing as an invitee': () => updateDoc(goalRef(db('cleo')), { name: 'Run 200 km' }),
      'editing a finished goal': () => updateDoc(goalRef(alice, 'done'), { name: 'Run 200 km' }),
      'a raised target that keeps reachedAt': () => updateDoc(goalRef(alice, 'reached'), { target100: 15_000 }),
      'a lowered target that doesn\'t set reachedAt': () => updateDoc(goalRef(alice), { target100: 5000 }),
      'setting reachedAt without reaching': () => updateDoc(goalRef(alice), { reachedAt: now() }),
      'clearing reachedAt while reached': () => updateDoc(goalRef(alice, 'reached'), { reachedAt: null }),
      'a 61-character name': () => updateDoc(goalRef(alice), { name: 'N'.repeat(61) }),
      'a blank unit': () => updateDoc(goalRef(alice), { unit: '' }),
      'a target of 0': () => updateDoc(goalRef(alice), { target100: 0, reachedAt: now() }),
      'a fractional target': () => updateDoc(goalRef(alice), { target100: 12_000.5 }),
      'a bad end date': () => updateDoc(goalRef(alice), { endsOn: '2026-02-30' }),
      'changing the total': () => updateDoc(goalRef(alice), { total100: 9000 }),
      'changing someone\'s part': () => updateDoc(goalRef(alice), { 'totals100.bob': 0 }),
      'changing the timezone': () => updateDoc(goalRef(alice), { timezone: 'Asia/Tokyo', utcOffsetMin: 540 }),
      'changing the owner': () => updateDoc(goalRef(alice), { ownerId: 'bob' }),
      'adding a member': () => updateDoc(goalRef(alice), { memberIds: arrayUnion('zed') }),
      'an extra key': () => updateDoc(goalRef(alice), { stakes: 'Dinner' }),
    })
  })

  test('the owner finishes a goal: for good, invitations gone', async () => {
    await seed({ ...people(), 'sharedGoals/g1': storedGoal(), 'sharedGoals/done': storedGoal({ archivedAt: ago(HOUR), invited: [] }) })
    const alice = db('alice')
    await allDenied({
      'finishing as a non-owner': () => updateDoc(goalRef(db('bob')), { archivedAt: now(), invited: [] }),
      'finishing with a client time': () => updateDoc(goalRef(alice), { archivedAt: Timestamp.now(), invited: [] }),
      'finishing and keeping the invitations': () => updateDoc(goalRef(alice), { archivedAt: now() }),
      'un-finishing': () => updateDoc(goalRef(alice, 'done'), { archivedAt: null }),
      'finishing again': () => updateDoc(goalRef(alice, 'done'), { archivedAt: now() }),
      'deleting a goal (the owner)': () => deleteDoc(goalRef(alice)),
      'deleting a goal (a member)': () => deleteDoc(goalRef(db('bob'))),
      'deleting a finished goal': () => deleteDoc(goalRef(alice, 'done')),
    })
    await allowed(updateDoc(goalRef(alice), { archivedAt: now(), invited: [] }))
  })
})
