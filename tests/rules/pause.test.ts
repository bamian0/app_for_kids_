// Pausing a week (SPEC §9.3): one request at a time in space.pause, completed pauses in space.paused.
import { describe, expect, test } from 'vitest'
import {
  arrayRemove, arrayUnion, deleteField, doc, getDoc, runTransaction, serverTimestamp, Timestamp, updateDoc, writeBatch,
  type DocumentData, type Firestore,
} from 'firebase/firestore'
import { allDenied, allowed, CODE, denied, HOUR, inviteDoc, spaceDoc, ts, useRulesEnv, weekDoc } from './helpers.ts'

const { db, seed } = useRulesEnv()

const ABC = ['alice', 'bob', 'carol']
// Week ids decide the month (its Friday's); the bounds are seeded relative to now.
const NOV_A = '2026-11-16' // Friday Nov 20: November
const NOV_B = '2026-11-23' // Friday Nov 27: November
const DEC_A = '2026-11-30' // Friday Dec 4: December, though it starts in November
const DEC_B = '2026-12-07'

const spaceRef = (fs: Firestore, id = 's1') => doc(fs, `spaces/${id}`)
const at = (ms: number) => ts(Date.now() - ms)

/** A request as asked, `ago` ms ago. */
const request = (weekId: string, by: string, oks: string[], extra: DocumentData = {}, ago = HOUR): DocumentData =>
  ({ weekId, by, at: at(ago), oks, ...extra })

/** askToPause's write: a fresh request, and the record when nobody else needs to say OK. */
function ask(fs: Firestore, uid: string, weekId: string, opts: { record?: string; space?: string; pause?: DocumentData } = {}) {
  return updateDoc(spaceRef(fs, opts.space), {
    pause: { weekId, by: uid, at: serverTimestamp(), oks: [uid], ...opts.pause },
    ...(opts.record ? { [`paused.${opts.record}`]: weekId } : {}),
  })
}

/** answerPause('ok'): the whole request back with self appended, and the record when it completes. */
function ok(fs: Firestore, uid: string, p: DocumentData, record?: string, space = 's1') {
  return updateDoc(spaceRef(fs, space), {
    pause: { ...p, oks: [...(p.oks as string[]), uid] },
    ...(record ? { [`paused.${record}`]: p.weekId } : {}),
  })
}

/** answerPause('not-now') and withdrawPause: the request gains declinedBy. */
const decline = (fs: Firestore, uid: string, p: DocumentData, space = 's1') =>
  updateDoc(spaceRef(fs, space), { pause: { ...p, declinedBy: uid } })

/** Space s1 = alice, bob, carol; next week NOV_B (planning) and this week NOV_A (active) have everyone. */
async function setup(extra: DocumentData = {}, weeks: Record<string, DocumentData> = {}) {
  await seed({
    'spaces/s1': spaceDoc(ABC, extra),
    [`spaces/s1/weeks/${NOV_A}`]: weekDoc('active', ABC),
    [`spaces/s1/weeks/${NOV_B}`]: weekDoc('planning', ABC),
    [`spaces/s1/weeks/${DEC_A}`]: weekDoc('planning', ABC),
    ...Object.fromEntries(Object.entries(weeks).map(([w, d]) => [`spaces/s1/weeks/${w}`, d])),
  })
}

const pauseOf = async (space = 's1') => (await getDoc(spaceRef(db('alice'), space))).data()!

describe('asking', () => {
  test('a member asks to pause next week, or this week until its reviews open', async () => {
    await setup()
    await allowed(ask(db('alice'), 'alice', NOV_B))
    expect((await pauseOf()).pause.oks).toEqual(['alice'])
    await seed({ 'spaces/s2': spaceDoc(ABC), [`spaces/s2/weeks/${NOV_A}`]: weekDoc('active', ABC) })
    await allowed(ask(db('bob'), 'bob', NOV_A, { space: 's2' }))
  })

  test('alone in the space, asking pauses at once (and must record it)', async () => {
    await seed({ 'spaces/s1': spaceDoc(['alice']), [`spaces/s1/weeks/${DEC_A}`]: weekDoc('planning', ['alice']) })
    await denied(ask(db('alice'), 'alice', DEC_A))
    // The week's month is its Friday's: December, though the week starts in November.
    await denied(ask(db('alice'), 'alice', DEC_A, { record: '2026-11' }))
    await allowed(ask(db('alice'), 'alice', DEC_A, { record: '2026-12' }))
    expect((await pauseOf()).paused).toEqual({ '2026-12': DEC_A })
  })

  test('a request with others to ask can\'t record the pause', async () => {
    await setup()
    await denied(ask(db('alice'), 'alice', NOV_B, { record: '2026-11' }))
  })

  test('refused when the week can\'t be paused', async () => {
    await setup({ paused: { '2026-12': DEC_B } }, { [NOV_A]: weekDoc('review', ABC) })
    const alice = db('alice')
    await allDenied({
      'reviews have opened': () => ask(alice, 'alice', NOV_A),
      'no week doc': () => ask(alice, 'alice', '2026-11-09'),
      // DEC_A's Friday is in December, which already has its pause.
      'the month has its pause (the Friday rule)': () => ask(alice, 'alice', DEC_A),
      'a non-member': () => ask(db('zoe'), 'zoe', NOV_B),
      'signed out': () => ask(db(), 'alice', NOV_B),
    })
    // November has no pause yet.
    await allowed(ask(alice, 'alice', NOV_B))
  })

  test('the request is exactly {weekId, by, at, oks: [me]}', async () => {
    await setup()
    const alice = db('alice')
    await allDenied({
      'oks empty': () => ask(alice, 'alice', NOV_B, { pause: { oks: [] } }),
      'oks with someone else': () => ask(alice, 'alice', NOV_B, { pause: { oks: ['alice', 'bob'] } }),
      'by someone else': () => ask(alice, 'alice', NOV_B, { pause: { by: 'bob' } }),
      'a client time': () => ask(alice, 'alice', NOV_B, { pause: { at: Timestamp.now() } }),
      'already declined': () => ask(alice, 'alice', NOV_B, { pause: { declinedBy: 'bob' } }),
      'an extra key': () => ask(alice, 'alice', NOV_B, { pause: { reason: 'holiday' } }),
      'a malformed week id': () => ask(alice, 'alice', 'next-week'),
      'with a rename': () => updateDoc(spaceRef(alice), {
        pause: { weekId: NOV_B, by: 'alice', at: serverTimestamp(), oks: ['alice'] }, name: 'Break',
      }),
    })
  })

  test('one request at a time; a new one once the last is over', async () => {
    const cases: Array<[string, DocumentData, DocumentData, boolean]> = [
      // [name, previous request, extra space fields, can carol ask?]
      ['pending', request(NOV_A, 'bob', ['bob']), {}, false],
      ['declined', request(NOV_A, 'bob', ['bob'], { declinedBy: 'alice' }), {}, true],
      ['withdrawn', request(NOV_A, 'bob', ['bob'], { declinedBy: 'bob' }), {}, true],
      ['recorded', request(NOV_A, 'bob', ABC), { paused: { '2026-11': NOV_A } }, true],
      ['lapsed (its reviews opened)', request('2026-11-02', 'bob', ['bob']), {}, true],
    ]
    for (const [name, prev, extra, can] of cases) {
      await setup({ pause: prev, ...extra }, { '2026-11-02': weekDoc('review', ABC) })
      const op = ask(db('carol'), 'carol', DEC_A)
      try {
        await (can ? allowed : denied)(op)
      } catch (e) {
        throw new Error(`${name}: ${String(e)}`)
      }
    }
  })

  test('each person asks at most once every 12 hours, cancelled requests included', async () => {
    // alice's own request, Not Now'd by bob 11 hours after she asked.
    await setup({ pause: request(NOV_A, 'alice', ['alice'], { declinedBy: 'bob' }, 11 * HOUR) })
    await denied(ask(db('alice'), 'alice', NOV_B))
    // Someone else may ask.
    await allowed(ask(db('carol'), 'carol', NOV_B))
    // Withdrawn an hour ago: still waiting.
    await setup({ pause: request(NOV_A, 'alice', ['alice'], { declinedBy: 'alice' }) })
    await denied(ask(db('alice'), 'alice', NOV_B))
    // 13 hours later she may ask again.
    await setup({ pause: request(NOV_A, 'alice', ['alice'], { declinedBy: 'alice' }, 13 * HOUR) })
    await allowed(ask(db('alice'), 'alice', NOV_B))
  })
})

describe('saying OK', () => {
  const pending = request(NOV_B, 'alice', ['alice'])

  test('OKs append; the completing OK records the pause in the same write', async () => {
    await setup({ pause: pending })
    await allowed(ok(db('bob'), 'bob', pending))
    const afterBob = { ...pending, oks: ['alice', 'bob'] }
    expect((await pauseOf()).pause.oks).toEqual(['alice', 'bob'])
    // A plain arrayUnion that completes it without recording is refused.
    await denied(updateDoc(spaceRef(db('carol')), { 'pause.oks': arrayUnion('carol') }))
    await denied(ok(db('carol'), 'carol', afterBob))
    await denied(ok(db('carol'), 'carol', afterBob, '2026-12'))
    await allowed(ok(db('carol'), 'carol', afterBob, '2026-11'))
    expect((await pauseOf()).paused).toEqual({ '2026-11': NOV_B })
    // A completed pause is final.
    await allDenied({
      'decline it': () => decline(db('bob'), 'bob', { ...afterBob, oks: ABC }),
      'withdraw it': () => decline(db('alice'), 'alice', { ...afterBob, oks: ABC }),
      'ask again for November': () => ask(db('bob'), 'bob', NOV_A),
      'drop the record': () => updateDoc(spaceRef(db('alice')), { paused: deleteField() }),
    })
  })

  test('refused OKs', async () => {
    await setup({ pause: { ...pending, oks: ['alice', 'bob'] } })
    const bobs = { ...pending, oks: ['alice', 'bob'] }
    await allDenied({
      'OK twice': () => ok(db('bob'), 'bob', bobs),
      'for someone else': () => updateDoc(spaceRef(db('bob')), { pause: { ...bobs, oks: ['alice', 'bob', 'carol'] }, 'paused.2026-11': NOV_B }),
      'changing the week': () => ok(db('carol'), 'carol', { ...bobs, weekId: NOV_A }, '2026-11'),
      'changing the time': () => ok(db('carol'), 'carol', { ...bobs, at: Timestamp.now() }, '2026-11'),
      'a non-member': () => ok(db('zoe'), 'zoe', bobs),
    })
    // On a declined request.
    await setup({ pause: { ...pending, declinedBy: 'carol' } })
    await denied(ok(db('bob'), 'bob', { ...pending, declinedBy: 'carol' }))
    // After its reviews opened (lapsed).
    await setup({ pause: pending }, { [NOV_B]: weekDoc('review', ABC) })
    await denied(ok(db('bob'), 'bob', pending))
  })

  test('two OKs from the same state: the second is refused, its retry completes and records it once', async () => {
    // alice asked, nobody else has answered; bob and carol answer at the same time from that state.
    await setup({ pause: pending })
    await allowed(ok(db('bob'), 'bob', pending))
    // carol's write was computed before bob's landed: it would drop bob's OK.
    await denied(ok(db('carol'), 'carol', pending))
    await denied(ok(db('carol'), 'carol', pending, '2026-11'))
    // Her transaction retries from the new state, which her OK completes.
    const both = { ...pending, oks: ['alice', 'bob'] }
    await allowed(ok(db('carol'), 'carol', both, '2026-11'))
    // November's pause is used: nothing records another week for it.
    await denied(updateDoc(spaceRef(db('bob')), { 'paused.2026-11': NOV_A }))
    await denied(ok(db('dave'), 'dave', { ...both, oks: ABC }, '2026-11'))
    expect((await pauseOf()).paused).toEqual({ '2026-11': NOV_B })
  })

  test('answering in a transaction', async () => {
    await setup({ pause: { ...pending, oks: ['alice', 'bob'] } })
    const fs = db('carol')
    await allowed(runTransaction(fs, async (tx) => {
      const p = (await tx.get(spaceRef(fs))).data()!.pause as DocumentData
      const oks = [...(p.oks as string[]), 'carol']
      tx.update(spaceRef(fs), { pause: { ...p, oks }, ...(ABC.every((u) => oks.includes(u)) ? { 'paused.2026-11': p.weekId } : {}) })
    }))
    expect((await pauseOf()).paused).toEqual({ '2026-11': NOV_B })
  })
})

describe('Not Now and cancelling', () => {
  const pending = request(NOV_B, 'alice', ['alice', 'bob'])

  test('a member who hasn\'t said OK says Not Now; the request stays, declined', async () => {
    await setup({ pause: pending })
    await allowed(decline(db('carol'), 'carol', pending))
    expect((await pauseOf()).pause.declinedBy).toBe('carol')
  })

  test('the asker cancels by declining their own request (withdrawn)', async () => {
    await setup({ pause: pending })
    await allowed(decline(db('alice'), 'alice', pending))
    // Asking again within 12 hours is refused.
    await denied(ask(db('alice'), 'alice', NOV_B))
  })

  test('refused declines', async () => {
    await setup({ pause: pending })
    await allDenied({
      'by someone who said OK': () => decline(db('bob'), 'bob', pending),
      'in someone else\'s name': () => decline(db('carol'), 'bob', pending),
      'changing the OKs': () => updateDoc(spaceRef(db('carol')), { pause: { ...pending, oks: ['alice'], declinedBy: 'carol' } }),
      'deleting the request': () => updateDoc(spaceRef(db('alice')), { pause: deleteField() }),
      'deleting it by its field': () => updateDoc(spaceRef(db('carol')), { 'pause.oks': deleteField() }),
      'a non-member': () => decline(db('zoe'), 'zoe', pending),
    })
    await setup({ pause: { ...pending, declinedBy: 'carol' } })
    await denied(decline(db('alice'), 'alice', { ...pending, declinedBy: 'carol' }))
  })
})

describe('finalizing', () => {
  const twoOks = request(NOV_B, 'alice', ['alice', 'bob'])
  const finalize = (fs: Firestore, month = '2026-11', weekId = NOV_B) => updateDoc(spaceRef(fs), { [`paused.${month}`]: weekId })

  test('once the last holdout has left the space, any member records the pause', async () => {
    // carol left: she is still in the week doc, but no longer needed.
    await setup({ pause: twoOks, memberIds: ['alice', 'bob'], leftAt: { carol: at(HOUR) } })
    await denied(finalize(db('bob'), '2026-12'))
    await denied(finalize(db('bob'), '2026-11', NOV_A))
    await allowed(finalize(db('bob')))
  })

  test('refused while someone needed hasn\'t said OK, once declined, or after the reviews opened', async () => {
    await setup({ pause: twoOks })
    await denied(finalize(db('alice')))
    await setup({ pause: { ...twoOks, declinedBy: 'carol' }, memberIds: ['alice', 'bob'] })
    await denied(finalize(db('alice')))
    await setup({ pause: twoOks, memberIds: ['alice', 'bob'] }, { [NOV_B]: weekDoc('review', ABC) })
    await denied(finalize(db('alice')))
    await setup({ pause: twoOks, memberIds: ['alice', 'bob'] })
    await denied(finalize(db('zoe')))
  })

  test('someone who joins before the lock must say OK too; someone who joined after it isn\'t asked', async () => {
    // dave joined before the lock: the week holds him, so he is needed.
    const two = request(NOV_B, 'alice', ['alice', 'bob'])
    await seed({
      'spaces/s1': spaceDoc([...ABC, 'dave'], { pause: two }),
      [`spaces/s1/weeks/${NOV_B}`]: weekDoc('planning', [...ABC, 'dave']),
    })
    await denied(ok(db('carol'), 'carol', two, '2026-11'))
    await allowed(ok(db('carol'), 'carol', two))
    await allowed(ok(db('dave'), 'dave', { ...two, oks: ['alice', 'bob', 'carol'] }, '2026-11'))
    // erin joined after this week locked: the week doesn't hold her, and the last needed OK records it.
    const thisWeek = request(NOV_A, 'alice', ['alice', 'bob'])
    await seed({
      'spaces/s1': spaceDoc([...ABC, 'erin'], { pause: thisWeek }),
      [`spaces/s1/weeks/${NOV_A}`]: weekDoc('active', ABC),
    })
    await allowed(ok(db('carol'), 'carol', thisWeek, '2026-11'))
  })
})

describe('older clients on a space with a pause', () => {
  test('leave, remove, join, rotate the code and rename still work, and can\'t touch the pause', async () => {
    const pause = request(NOV_B, 'alice', ['alice'])
    await setup({ pause, paused: { '2026-10': '2026-10-19' } })
    await seed({ [`invites/${CODE}`]: inviteDoc('s1', 'alice') })
    const leave = (fs: Firestore, uid: string, extra: DocumentData = {}) =>
      updateDoc(spaceRef(fs), { memberIds: arrayRemove(uid), [`joinedAt.${uid}`]: deleteField(), [`leftAt.${uid}`]: serverTimestamp(), ...extra })
    const join = (fs: Firestore, uid: string, extra: DocumentData = {}) => {
      const batch = writeBatch(fs)
      batch.set(doc(fs, `spaces/s1/joins/${uid}`), { code: CODE, createdAt: serverTimestamp() })
      batch.update(spaceRef(fs), { memberIds: arrayUnion(uid), [`joinedAt.${uid}`]: serverTimestamp(), ...extra })
      return batch.commit()
    }
    await allDenied({
      'rename and decline': () => updateDoc(spaceRef(db('bob')), { name: 'Crew', 'pause.declinedBy': 'bob' }),
      'leave and drop the pause': () => leave(db('carol'), 'carol', { pause: deleteField() }),
      'join and record a pause': () => join(db('dave'), 'dave', { 'paused.2026-11': NOV_B }),
      'remove and drop the record': () => leave(db('alice'), 'bob', { paused: {} }),
      'rotate and drop the pause': () => updateDoc(spaceRef(db('alice')), { inviteCode: 'QQQQ2222', pause: deleteField() }),
    })
    await allowed(updateDoc(spaceRef(db('bob')), { name: 'Crew' }))
    await allowed(join(db('dave'), 'dave'))
    await allowed(leave(db('carol'), 'carol'))
    await allowed(leave(db('alice'), 'bob'))
    await allowed(updateDoc(spaceRef(db('alice')), { inviteCode: 'QQQQ2222' }))
    const after = await pauseOf()
    expect(after.pause).toEqual(pause)
    expect(after.paused).toEqual({ '2026-10': '2026-10-19' })
  })
})
