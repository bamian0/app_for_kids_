// spaces/{id}/months/{monthId}: a month's house stakes, frozen once the month is complete (SPEC §9.7).
// The rules judge completion by the month's last week's stored deadline (and its monthly list's);
// without a week doc, by its deadline computed from the space's offset and schedule. Tests seed those
// stored deadlines relative to now, and move a space's computed deadlines by seeding its utcOffsetMin.
import { describe, expect, test } from 'vitest'
import { DateTime } from 'luxon'
import {
  collection, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc, Timestamp, updateDoc, writeBatch, type DocumentData,
  type Firestore,
} from 'firebase/firestore'
import {
  addMonths, allDenied, allowed, CODE, CUSTOM, DAY, denied, HOUR, inviteDoc, legacySpaceDoc, monthStr, monthWeeks,
  spaceDoc, ts, useRulesEnv, USUAL, type Schedule,
} from './helpers.ts'

const { db, seed } = useRulesEnv()

const C = monthStr(Date.now())
const P = addMonths(C, -1)
const ABC = ['alice', 'bob', 'carol']
const SPACE_STAKES = { reward: 'Dinner on me', penalty: 'You buy coffee for a week' }

const ref = (fs: Firestore, monthId: string, space = 's1') => doc(fs, `spaces/${space}/months/${monthId}`)
const freezeOf = (extra: DocumentData = {}): DocumentData => ({ ...SPACE_STAKES, createdAt: serverTimestamp(), ...extra })
const freeze = (fs: Firestore, monthId: string, extra: DocumentData = {}, space = 's1') => setDoc(ref(fs, monthId, space), freezeOf(extra))

/** The month's last week as stored, ending at `deadlineMs` (the rules read only its deadline). */
const lastWeekPath = (monthId: string, space = 's1') => `spaces/${space}/weeks/${monthWeeks(monthId).last}`
const weekEnding = (deadlineMs: number): DocumentData => ({
  startAt: ts(deadlineMs - 5 * DAY), lockAt: ts(deadlineMs - 4 * DAY), reviewOpenAt: ts(deadlineMs - DAY), deadlineAt: ts(deadlineMs),
  members: ABC, submittedBy: [],
})
const listEnding = (deadlineMs: number): DocumentData => ({ ...weekEnding(deadlineMs), judges: [] })

/** The utcOffsetMin that puts month `m`'s computed completion (its last week's Monday 00:00 local +
 *  the schedule's deadline) at `completeAtMs`. */
function offsetFor(m: string, schedule: Schedule, completeAtMs: number): number {
  const lastMonday = Date.parse(`${monthWeeks(m).last}T00:00:00Z`)
  return Math.round((lastMonday - completeAtMs) / 60_000) + schedule.deadline
}

describe('freezing a month\'s house stakes', () => {
  test('once its last week\'s stored deadline has passed, with the space\'s stakes', async () => {
    await seed({ 'spaces/s1': spaceDoc(ABC), [lastWeekPath(C)]: weekEnding(Date.now() + HOUR) })
    await denied(freeze(db('bob'), C))
    await seed({ [lastWeekPath(C)]: weekEnding(Date.now() - 60_000) })
    await allowed(freeze(db('bob'), C))
    expect((await getDoc(ref(db('alice'), C))).data()).toMatchObject(SPACE_STAKES)
  })

  test.each([['usual', USUAL], ['custom', CUSTOM]] as const)('without a week doc, from an hour before its computed deadline (%s times)', async (_, schedule) => {
    const extra = (completeAtMs: number) => ({ schedule, utcOffsetMin: offsetFor(P, schedule, completeAtMs) })
    await seed({
      'spaces/s1': spaceDoc(ABC, extra(Date.now() + 90 * 60_000)),
      'spaces/s2': spaceDoc(ABC, extra(Date.now() + 30 * 60_000)),
    })
    await denied(freeze(db('bob'), P))
    await allowed(freeze(db('bob'), P, {}, 's2'))
  })

  test('not while the month\'s monthly list is still open', async () => {
    await seed({
      'spaces/s1': spaceDoc(ABC),
      [lastWeekPath(C)]: weekEnding(Date.now() - 2 * HOUR),
      [`spaces/s1/monthly/${C}`]: listEnding(Date.now() + HOUR),
    })
    await denied(freeze(db('bob'), C))
    await seed({ [`spaces/s1/monthly/${C}`]: listEnding(Date.now() - 60_000) })
    await allowed(freeze(db('bob'), C))
  })

  test('not a month in progress: an older client\'s freeze at the first lock is refused', async () => {
    await seed({ 'spaces/s1': spaceDoc(ABC), [lastWeekPath(C)]: weekEnding(Date.now() + 3 * DAY) })
    await allDenied({
      'this month': () => freeze(db('alice'), C),
      'next month': () => freeze(db('alice'), addMonths(C, 1)),
    })
  })

  test('recent months only', async () => {
    const old = addMonths(C, -4)
    await seed({ 'spaces/s1': spaceDoc(ABC), [lastWeekPath(old)]: weekEnding(Date.now() - 100 * DAY) })
    await denied(freeze(db('alice'), old))
  })

  test('exactly the space\'s stakes, by a member, at the server time', async () => {
    await seed({ 'spaces/s1': spaceDoc(ABC), [lastWeekPath(C)]: weekEnding(Date.now() - HOUR) })
    const alice = db('alice')
    await allDenied({
      'another reward': () => freeze(alice, C, { reward: 'A high five' }),
      'another penalty': () => freeze(alice, C, { penalty: 'Nothing' }),
      'an extra key': () => freeze(alice, C, { note: 'agreed' }),
      'no penalty': () => setDoc(ref(alice, C), { reward: SPACE_STAKES.reward, createdAt: serverTimestamp() }),
      'a client createdAt': () => freeze(alice, C, { createdAt: Timestamp.now() }),
      'month 13': () => freeze(alice, `${C.slice(0, 4)}-13`),
      'a one-digit month': () => freeze(alice, `${C.slice(0, 4)}-1`),
      'a date': () => freeze(alice, `${C}-01`),
      'a non-member': () => freeze(db('zoe'), C),
      'signed out': () => freeze(db(), C),
    })
    await allowed(freeze(alice, C))
  })

  test('a space without utcOffsetMin: complete 4 days into the next month, or after a stored deadline', async () => {
    await seed({ 'spaces/s1': legacySpaceDoc(ABC), 'spaces/s2': legacySpaceDoc(ABC), [lastWeekPath(C, 's2')]: weekEnding(Date.now() - HOUR) })
    await allowed(freeze(db('alice'), addMonths(C, -2)))
    await denied(freeze(db('alice'), C))
    // Last month: from the 5th of this month, 00:00 UTC.
    const fifth = DateTime.fromISO(`${C}-05T00:00:00Z`).toMillis()
    await (Date.now() >= fifth ? allowed : denied)(freeze(db('alice'), P))
    await allowed(freeze(db('alice'), C, {}, 's2'))
  })

  test('the owner\'s house-stakes edit freezes finished months with the old stakes, in the same batch', async () => {
    await seed({
      'spaces/s1': spaceDoc(ABC, { createdAt: ts(Date.now() - 90 * DAY) }),
      [`invites/${CODE}`]: inviteDoc('s1', 'alice'),
      [lastWeekPath(C)]: weekEnding(Date.now() - HOUR),
      [lastWeekPath(P)]: weekEnding(Date.now() - 20 * DAY),
    })
    const alice = db('alice')
    const batch = writeBatch(alice)
    batch.set(ref(alice, C), freezeOf())
    batch.set(ref(alice, P), freezeOf())
    batch.update(doc(alice, 'spaces/s1'), { reward: 'Sushi', penalty: 'Dishes', stakesNote: { by: 'alice', at: serverTimestamp() } })
    batch.update(doc(alice, `invites/${CODE}`), { reward: 'Sushi', penalty: 'Dishes' })
    await allowed(batch.commit())
    expect((await getDoc(ref(alice, C))).data()).toMatchObject(SPACE_STAKES)
    expect((await getDoc(ref(alice, P))).data()).toMatchObject(SPACE_STAKES)
    // A freeze can't carry the new stakes.
    await seed({ 'spaces/s1': spaceDoc(ABC, { createdAt: ts(Date.now() - 90 * DAY) }) })
    await denied((() => {
      const b = writeBatch(alice)
      b.set(ref(alice, addMonths(C, -2)), freezeOf({ reward: 'Sushi', penalty: 'Dishes' }))
      b.update(doc(alice, 'spaces/s1'), { reward: 'Sushi', penalty: 'Dishes' })
      return b.commit()
    })())
  })

  test('members read; others don\'t', async () => {
    await seed({ 'spaces/s1': spaceDoc(ABC), [`spaces/s1/months/${C}`]: { ...SPACE_STAKES, createdAt: Timestamp.now() } })
    await allowed(getDoc(ref(db('bob'), C)))
    await allowed(getDocs(collection(db('bob'), 'spaces/s1/months')))
    await denied(getDoc(ref(db('zoe'), C)))
    await denied(getDoc(ref(db(), C)))
  })
})

describe('re-freezing the previous app\'s early freeze', () => {
  // This month ('2026-10' or later): the previous app froze it at its first lock, 20 days ago.
  const early = { reward: 'Old dinner', penalty: 'Old coffee', createdAt: ts(Date.now() - 20 * DAY) }

  test('overwritten once, at completion, with the space\'s stakes', async () => {
    await seed({ 'spaces/s1': spaceDoc(ABC), [`spaces/s1/months/${C}`]: early, [lastWeekPath(C)]: weekEnding(Date.now() + HOUR) })
    // Not before the month is complete.
    await denied(freeze(db('bob'), C))
    await seed({ [lastWeekPath(C)]: weekEnding(Date.now() - HOUR) })
    await allDenied({
      'other values': () => freeze(db('bob'), C, { reward: 'Old dinner', penalty: 'Old coffee' }),
      'an extra key': () => freeze(db('bob'), C, { refrozen: true }),
      'a client createdAt': () => freeze(db('bob'), C, { createdAt: Timestamp.now() }),
      'a non-member': () => freeze(db('zoe'), C),
      'a partial update': () => updateDoc(ref(db('bob'), C), { reward: SPACE_STAKES.reward, createdAt: serverTimestamp() }),
    })
    await allowed(freeze(db('bob'), C))
    expect((await getDoc(ref(db('bob'), C))).data()).toMatchObject(SPACE_STAKES)
    // Its createdAt is now after completion: never again.
    await seed({ 'spaces/s1': spaceDoc(ABC, { reward: 'Sushi' }) })
    await denied(freeze(db('bob'), C, { reward: 'Sushi' }))
    await denied(deleteDoc(ref(db('alice'), C)))
  })

  test('a freeze made at completion is never overwritten', async () => {
    await seed({
      'spaces/s1': spaceDoc(ABC, { reward: 'Sushi' }),
      [`spaces/s1/months/${C}`]: { ...SPACE_STAKES, createdAt: ts(Date.now() - 30 * 60_000) },
      [lastWeekPath(C)]: weekEnding(Date.now() - HOUR),
    })
    await denied(freeze(db('bob'), C, { reward: 'Sushi' }))
  })

  test('months before 2026-10 keep the freeze the previous app made', async () => {
    await seed({
      'spaces/s1': spaceDoc(ABC),
      'spaces/s1/months/2026-09': { ...early, createdAt: ts(Date.parse('2026-09-01T22:00:00Z')) },
      [lastWeekPath('2026-09')]: weekEnding(Date.parse('2026-09-26T00:00:00+02:00')),
    })
    await denied(freeze(db('bob'), '2026-09'))
    await denied(deleteDoc(ref(db('bob'), '2026-09')))
  })
})
