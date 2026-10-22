// Deals (SPEC §12.4, §12.7): spaces/{id}/deals/{uid}_{seq}. Its person proposes it (one deal in play at a
// time, proved by the seq chain), each friend agrees for themselves, the person withdraws it while it
// waits, its person and the friends who agreed tap Call Off, any member marks pairs Settled once it's won
// or lost. Only the reminders job (admin) writes agreedAt, start, track, checkedAt and an end other than a
// withdrawal. Nobody deletes a deal. The worst cases' costs are measured in budget.test.ts.
import { describe, expect, test } from 'vitest'
import {
  collection, collectionGroup, deleteDoc, deleteField, doc, FieldPath, getDoc, getDocs, query, runTransaction, serverTimestamp, setDoc,
  Timestamp, updateDoc, where, writeBatch, type DocumentData, type Firestore,
} from 'firebase/firestore'
import { allDenied, allowed, DAY, denied, HOUR, profileDoc, spaceDoc, ts, useRulesEnv } from './helpers.ts'

const { db, seed, clear } = useRulesEnv()

/** s1: alice, bob and carol play; dan only rates (judges). */
const S1 = ['alice', 'bob', 'carol', 'dan']
const M8 = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8']
const ago = (ms: number) => ts(Date.now() - ms)
/** `d` without `key` (a doc missing one of its keys). */
const omit = (d: DocumentData, key: string): DocumentData => Object.fromEntries(Object.entries(d).filter(([k]) => k !== key))

type Mode = 'group' | 'each'
/** What proposeDeal writes (SPEC §12.4): `uid`'s deal number `seq` with `friends`, Same for Everyone on
 *  both lines unless the modes say otherwise ('' for a line that isn't per friend's own text). */
function proposal(uid: string, seq: number, friends: string[], rewardMode: Mode = 'group', penaltyMode: Mode = 'group', extra: DocumentData = {}): DocumentData {
  return {
    uid, seq, unit: 'week', count: 4, rewardMode, penaltyMode,
    reward: rewardMode === 'group' ? 'Dinner, on them' : '',
    penalty: penaltyMode === 'group' ? 'Coffee for a week' : '',
    per: rewardMode === 'group' && penaltyMode === 'group' ? {} : Object.fromEntries(friends.map((f) => [f, {
      reward: rewardMode === 'each' ? `Lunch from ${f}` : '',
      penalty: penaltyMode === 'each' ? `A coffee for ${f}` : '',
    }])),
    friends, agreed: {}, off: {}, settled: {}, createdAt: serverTimestamp(), ended: null,
    ...extra,
  }
}
/** alice's first deal in s1 as stored: with bob and carol, waiting, unless `extra` says otherwise. */
const storedDeal = (extra: DocumentData = {}): DocumentData => ({ ...proposal('alice', 1, ['bob', 'carol']), createdAt: ago(3 * DAY), ...extra })

// The job's fields (admin) and its ends.
const STAMPS = { agreedAt: ago(2 * DAY), start: '2026-11-16' }
const TRACK = [{ id: '2026-11-16', result: 'pass', score: 95, missed: 0 }]
const WON = { outcome: 'won', at: ago(HOUR), period: '2026-11-23' }
const LOST = { outcome: 'lost', at: ago(HOUR), period: '2026-11-23', score: 84 }
const OFF = { outcome: 'off', at: ago(HOUR), reason: 'called-off' }
const withdrawnBy = (by = 'alice') => ({ outcome: 'withdrawn', at: ago(HOUR), by })
/** Agreed by bob and carol, stamped and running. */
const agreedDeal = (extra: DocumentData = {}) => storedDeal({ agreed: { bob: ago(3 * DAY), carol: ago(2 * DAY) }, ...STAMPS, track: TRACK, ...extra })

const dealRef = (fs: Firestore, id = 'alice_1', space = 's1') => doc(fs, `spaces/${space}/deals/${id}`)
const propose = (fs: Firestore, d: DocumentData, id = `${d.uid}_${d.seq}`, space = 's1') => setDoc(dealRef(fs, id, space), d)
/** agreeToDeal's write: agreed.{me} only. */
const agree = (fs: Firestore, me: string, id = 'alice_1', space = 's1') => updateDoc(dealRef(fs, id, space), new FieldPath('agreed', me), serverTimestamp())
/** withdrawDeal's write: `ended` only. */
const withdraw = (fs: Firestore, by = 'alice', id = 'alice_1', extra: DocumentData = {}) =>
  updateDoc(dealRef(fs, id), { ended: { outcome: 'withdrawn', at: serverTimestamp(), by, ...extra } })
/** callOffDeal's write: off.{me} only. */
const callOff = (fs: Firestore, me: string, id = 'alice_1', space = 's1') => updateDoc(dealRef(fs, id, space), new FieldPath('off', me), serverTimestamp())
/** settleDeal's write: one mark per friend of the line, in one update. */
function settle(fs: Firestore, me: string, friends: string[], settled = true, id = 'alice_1', space = 's1', mark: DocumentData = {}) {
  const [first, ...rest] = friends.flatMap((f) => [new FieldPath('settled', f), { settled, by: me, at: serverTimestamp(), ...mark }])
  return updateDoc(dealRef(fs, id, space), first as FieldPath, rest[0], ...rest.slice(1))
}

/** A fresh database with s1 (S1, dan judges, with deals; `space` overrides), s2 (zoe and yan) and `docs`
 *  (paths under spaces/s1/ unless they start with spaces/). */
async function setup(space: DocumentData = {}, docs: Record<string, DocumentData> = {}) {
  await clear()
  await seed({
    'spaces/s1': spaceDoc(S1, { judges: ['dan'], hasDeals: true, ...space }),
    'spaces/s2': spaceDoc(['zoe', 'yan']),
    ...Object.fromEntries(Object.entries(docs).map(([p, d]) => [p.startsWith('spaces/') ? p : `spaces/s1/${p}`, d])),
  })
}
/** s1 after `who` left or was removed (the space doc looks the same): out of memberIds and joinedAt, leftAt
 *  recorded, the space owned by the first one left. */
function without(who: string[], extra: DocumentData = {}): DocumentData {
  const members = S1.filter((u) => !who.includes(u))
  return { memberIds: members, ownerId: members[0], joinedAt: Object.fromEntries(members.map((u) => [u, ago(30 * DAY)])), leftAt: Object.fromEntries(who.map((u) => [u, ago(HOUR)])), ...extra }
}
const stored = async (id = 'alice_1') => (await getDoc(dealRef(db('alice'), id))).data()!
/** s1 as before its first deal: no hasDeals. */
const withoutFlag = () => seed({ 'spaces/s1': spaceDoc(S1, { judges: ['dan'] }) })

describe('deals: propose (SPEC §12.2 Making a deal)', () => {
  test('the person proposes with every other member who plays, in each mode', async () => {
    await setup()
    await seed({ 'spaces/s3': spaceDoc(['alice', 'bob']), 'spaces/s8': spaceDoc(M8, { judges: ['x9'] }) })
    // Same for Everyone on both lines, one friend.
    await allowed(propose(db('alice'), proposal('alice', 1, ['bob']), 'alice_1', 's3'))
    // Different per Friend on both lines with 7 friends: each entry's texts required, the group texts ''.
    await allowed(propose(db('m1'), proposal('m1', 1, M8.slice(1), 'each', 'each', { unit: 'month', count: 12 }), 'm1_1', 's8'))
    // Mixed, both ways; a judge isn't in it, and the friends' order is free.
    await allowed(propose(db('alice'), proposal('alice', 1, ['bob', 'carol'], 'group', 'each')))
    await allowed(propose(db('bob'), proposal('bob', 1, ['carol', 'alice'], 'each', 'group', { count: 1 })))
    // An 'each' line may keep the text it had as a group line (up to 120 characters).
    await allowed(propose(db('carol'), proposal('carol', 1, ['alice', 'bob'], 'each', 'group', { reward: 'R'.repeat(120), unit: 'month' })))
    expect(await stored()).toMatchObject({ uid: 'alice', seq: 1, friends: ['bob', 'carol'], agreed: {}, off: {}, settled: {}, ended: null })
  })

  test('the first deal and the space flag in one transaction (proposeDeal)', async () => {
    await setup()
    await withoutFlag()
    const fs = db('alice')
    await allowed(runTransaction(fs, async (tx) => {
      await tx.get(doc(fs, 'spaces/s1'))
      await tx.get(dealRef(fs, 'alice_1'))
      tx.set(dealRef(fs, 'alice_1'), proposal('alice', 1, ['bob', 'carol']))
      tx.update(doc(fs, 'spaces/s1'), { hasDeals: true })
    }))
    expect((await getDoc(doc(fs, 'spaces/s1'))).get('hasDeals')).toBe(true)
  })

  test('the id, the seq and the person are checked', async () => {
    await setup()
    const alice = db('alice')
    const d = proposal('alice', 1, ['bob', 'carol'])
    await allDenied({
      'an id of another seq': () => propose(alice, d, 'alice_2'),
      'an id of another person': () => propose(alice, d, 'bob_1'),
      'an id without the underscore': () => propose(alice, d, 'alice1'),
      'seq 0': () => propose(alice, { ...d, seq: 0 }, 'alice_0'),
      'seq 10000': () => propose(alice, { ...d, seq: 10000 }, 'alice_10000'),
      'seq 1.5': () => propose(alice, { ...d, seq: 1.5 }, 'alice_1.5'),
      'seq \'1\'': () => propose(alice, { ...d, seq: '1' }),
      'seq -1': () => propose(alice, { ...d, seq: -1 }, 'alice_-1'),
      'uid of someone else (bob proposes alice\'s)': () => propose(db('bob'), d),
      'uid of someone else (alice proposes bob\'s)': () => propose(alice, proposal('bob', 1, ['alice', 'carol'])),
      'a non-member': () => propose(db('zoe'), proposal('zoe', 1, ['alice', 'bob', 'carol'])),
      'the proposer judges': () => propose(db('dan'), proposal('dan', 1, ['alice', 'bob', 'carol'])),
      'signed out': () => propose(db(), d),
    })
  })

  test('the friends are every other member who doesn\'t judge, each once', async () => {
    await setup()
    await seed({ 'spaces/s4': spaceDoc(['alice']), 'spaces/s5': spaceDoc(['alice', 'dan'], { judges: ['dan'] }) })
    const alice = db('alice')
    const with_ = (friends: unknown) => propose(alice, proposal('alice', 1, friends as string[]))
    await allDenied({
      'missing a member who plays': () => with_(['bob']),
      'with a judge': () => with_(['bob', 'carol', 'dan']),
      'with a judge instead of a player': () => with_(['bob', 'dan']),
      'with self': () => with_(['alice', 'bob', 'carol']),
      'self instead of a player': () => with_(['alice', 'bob']),
      'a duplicate': () => with_(['bob', 'carol', 'carol']),
      'a duplicate instead of a player': () => with_(['bob', 'bob']),
      'with a non-member': () => with_(['bob', 'carol', 'zoe']),
      'a non-member instead of a player': () => with_(['bob', 'zoe']),
      'not a list': () => with_('bob,carol'),
      'a map': () => with_({ bob: true, carol: true }),
      'empty, with players': () => with_([]),
      'alone: nobody to make a deal with': () => propose(alice, proposal('alice', 1, []), 'alice_1', 's4'),
      'everyone else judges': () => propose(alice, proposal('alice', 1, []), 'alice_1', 's5'),
      'alone, naming a judge': () => propose(alice, proposal('alice', 1, ['dan']), 'alice_1', 's5'),
      'per-friend lines for the wrong friends': () => propose(alice, proposal('alice', 1, ['bob', 'carol'], 'each', 'each', { friends: ['bob'] })),
    })
  })

  test('the length: 1 to 12 weeks or months', async () => {
    await setup()
    const alice = db('alice')
    const d = (extra: DocumentData) => propose(alice, proposal('alice', 1, ['bob', 'carol'], 'group', 'group', extra))
    await allDenied({
      'count 0': () => d({ count: 0 }),
      'count 13': () => d({ count: 13 }),
      'count 2.5': () => d({ count: 2.5 }),
      'count \'4\'': () => d({ count: '4' }),
      'count missing': () => propose(alice, omit(proposal('alice', 1, ['bob', 'carol']), 'count')),
      'unit day': () => d({ unit: 'day' }),
      'unit weeks': () => d({ unit: 'weeks' }),
      'unit null': () => d({ unit: null }),
    })
    await allowed(d({ count: 12, unit: 'month' }))
  })

  test('the lines: a group text is required, an each line needs every friend\'s text', async () => {
    await setup()
    const alice = db('alice')
    const d = (r: Mode, p: Mode, extra: DocumentData) => propose(alice, proposal('alice', 1, ['bob', 'carol'], r, p, extra))
    const per = (bob: DocumentData, carol: DocumentData = { reward: 'Lunch', penalty: 'A coffee' }) => ({ per: { bob, carol } })
    await allDenied({
      'group reward blank': () => d('group', 'group', { reward: '' }),
      'group reward whitespace only': () => d('group', 'group', { reward: '  \t ' }),
      'group reward 121 characters': () => d('group', 'group', { reward: 'R'.repeat(121) }),
      'group reward not a string': () => d('group', 'group', { reward: 42 }),
      'group reward null': () => d('group', 'group', { reward: null }),
      'group penalty blank': () => d('group', 'group', { penalty: '' }),
      'group penalty whitespace only': () => d('group', 'group', { penalty: '   ' }),
      'group penalty 121 characters': () => d('group', 'group', { penalty: 'P'.repeat(121) }),
      'group penalty not a string': () => d('group', 'group', { penalty: ['Coffee'] }),
      'group penalty with an each reward, blank': () => d('each', 'group', { penalty: ' ' }),
      'an unknown mode': () => d('group', 'group', { rewardMode: 'both' }),
      'a mode missing': () => propose(alice, omit(proposal('alice', 1, ['bob', 'carol']), 'penaltyMode')),
      'each line without an entry for a friend': () => d('each', 'each', { per: { bob: { reward: 'Lunch', penalty: 'A coffee' } } }),
      'each line with an extra per key (a judge)': () => d('each', 'group', { per: { ...proposal('alice', 1, ['bob', 'carol'], 'each').per, dan: { reward: 'X', penalty: '' } } }),
      'each line with an extra per key (self)': () => d('each', 'group', { per: { ...proposal('alice', 1, ['bob', 'carol'], 'each').per, alice: { reward: 'X', penalty: '' } } }),
      'each line, an entry of a non-member instead': () => d('each', 'each', { per: { bob: { reward: 'Lunch', penalty: 'A coffee' }, zoe: { reward: 'Lunch', penalty: 'A coffee' } } }),
      'per non-empty while both lines are group': () => d('group', 'group', per({ reward: '', penalty: '' }, { reward: '', penalty: '' })),
      'per not a map': () => d('each', 'each', { per: [] }),
      'an entry with 3 keys': () => d('each', 'each', per({ reward: 'Lunch', penalty: 'A coffee', note: 'x' })),
      'an entry with 1 key': () => d('each', 'group', per({ reward: 'Lunch' })),
      'an each reward text blank': () => d('each', 'group', per({ reward: '', penalty: '' }, { reward: 'Lunch', penalty: '' })),
      'an each penalty text whitespace only': () => d('group', 'each', per({ reward: '', penalty: '  ' }, { reward: '', penalty: 'Coffee' })),
      'an each text 121 characters': () => d('each', 'each', per({ reward: 'R'.repeat(121), penalty: 'A coffee' })),
      'an each text not a string': () => d('each', 'each', per({ reward: 7, penalty: 'A coffee' })),
      'the other line\'s kept text 121 characters': () => d('each', 'group', per({ reward: 'Lunch', penalty: 'P'.repeat(121) }, { reward: 'Lunch', penalty: '' })),
      'an each line\'s kept group text 121 characters': () => d('each', 'each', { reward: 'R'.repeat(121) }),
      'an each line\'s kept group text not a string': () => d('each', 'each', { penalty: null }),
    })
  })

  test('nothing agreed, tapped, settled or decided yet, and only the 15 keys', async () => {
    await setup()
    const alice = db('alice')
    const d = (extra: DocumentData) => propose(alice, proposal('alice', 1, ['bob', 'carol'], 'group', 'group', extra))
    await allDenied({
      'agreed for a friend': () => d({ agreed: { bob: serverTimestamp() } }),
      'agreed not a map': () => d({ agreed: [] }),
      'a Call Off tap': () => d({ off: { alice: serverTimestamp() } }),
      'a settled mark': () => d({ settled: { bob: { settled: true, by: 'alice', at: serverTimestamp() } } }),
      'createdAt a client time': () => d({ createdAt: Timestamp.now() }),
      'createdAt missing (14 keys)': () => propose(alice, omit(proposal('alice', 1, ['bob', 'carol']), 'createdAt')),
      'ended withdrawn': () => d({ ended: { outcome: 'withdrawn', at: serverTimestamp(), by: 'alice' } }),
      'ended won': () => d({ ended: { outcome: 'won', at: serverTimestamp() } }),
      'ended missing': () => propose(alice, omit(proposal('alice', 1, ['bob', 'carol']), 'ended')),
      'a 16th key: start': () => d({ start: '2026-11-16' }),
      'a 16th key: track': () => d({ track: [] }),
      'a 16th key: agreedAt': () => d({ agreedAt: serverTimestamp() }),
      'a 16th key: checkedAt': () => d({ checkedAt: serverTimestamp() }),
      'a 16th key: anything': () => d({ note: 'hi' }),
      'a key renamed': () => propose(alice, { ...omit(proposal('alice', 1, ['bob', 'carol']), 'friends'), with: ['bob', 'carol'] }),
    })
  })

  test('one deal in play at a time: the previous one must have ended (the seq chain)', async () => {
    await setup()
    const alice = db('alice')
    const second = proposal('alice', 2, ['bob', 'carol'])
    // No first deal.
    await denied(propose(alice, second))
    // The first one in play: waiting, fully agreed, or stamped and running.
    for (const first of [storedDeal(), storedDeal({ agreed: { bob: ago(DAY), carol: ago(DAY) } }), agreedDeal()]) {
      await setup({}, { 'deals/alice_1': first })
      await denied(propose(alice, second))
    }
    // A first deal can't be made again over an ended one (that's an update), nor a third skip the second.
    await setup({}, { 'deals/alice_1': storedDeal({ ended: withdrawnBy() }) })
    await denied(propose(alice, proposal('alice', 1, ['bob', 'carol'])))
    await denied(propose(alice, proposal('alice', 3, ['bob', 'carol'])))
    // Someone else's ended deal doesn't stand in for yours, nor yours in another space.
    await setup({}, { 'deals/bob_1': { ...proposal('bob', 1, ['alice', 'carol']), createdAt: ago(DAY), ended: WON } })
    await denied(propose(alice, second))
    await setup({}, { 'spaces/s2/deals/alice_1': storedDeal({ ended: WON }) })
    await denied(propose(alice, second))
    // Ended by the job (won, lost, off, or withdrawn for a person who had left) or withdrawn: the next one.
    for (const ended of [WON, LOST, OFF, { outcome: 'off', at: ago(HOUR), reason: 'alone' }, withdrawnBy()]) {
      await setup({}, { 'deals/alice_1': agreedDeal({ ended }) })
      await allowed(propose(alice, second))
    }
    // Other people's deals in play don't block yours.
    await setup({}, { 'deals/bob_1': { ...proposal('bob', 1, ['alice', 'carol']), createdAt: ago(DAY) } })
    await allowed(propose(alice, proposal('alice', 1, ['bob', 'carol'])))
    // The chain's end: 9999.
    await setup({}, { 'deals/alice_9998': storedDeal({ seq: 9998, ended: WON }), 'deals/alice_9999': storedDeal({ seq: 9999, ended: WON }) })
    await denied(propose(alice, { ...second, seq: 10000 }, 'alice_10000'))
    await setup({}, { 'deals/alice_9998': storedDeal({ seq: 9998, ended: WON }) })
    await allowed(propose(alice, { ...second, seq: 9999 }, 'alice_9999'))
  })

  test('Edit: the withdrawal and the new deal in one transaction or batch (getAfter)', async () => {
    await setup({}, { 'deals/alice_1': storedDeal({ agreed: { bob: ago(DAY) } }) })
    const fs = db('alice')
    await allowed(runTransaction(fs, async (tx) => {
      await tx.get(doc(fs, 'spaces/s1'))
      await tx.get(dealRef(fs, 'alice_1'))
      await tx.get(dealRef(fs, 'alice_2'))
      tx.update(dealRef(fs, 'alice_1'), { ended: { outcome: 'withdrawn', at: serverTimestamp(), by: 'alice' } })
      tx.set(dealRef(fs, 'alice_2'), proposal('alice', 2, ['bob', 'carol'], 'group', 'group', { count: 2 }))
    }))
    expect((await stored('alice_1')).ended.outcome).toBe('withdrawn')
    expect((await stored('alice_2')).count).toBe(2)
    // The same as a batch, with the flag of a space that lacks it (a deal seeded before the flag).
    await setup({}, { 'deals/alice_1': storedDeal() })
    await withoutFlag()
    const b = writeBatch(fs)
    b.update(dealRef(fs, 'alice_1'), { ended: { outcome: 'withdrawn', at: serverTimestamp(), by: 'alice' } })
    b.set(dealRef(fs, 'alice_2'), proposal('alice', 2, ['bob', 'carol']))
    b.update(doc(fs, 'spaces/s1'), { hasDeals: true })
    await allowed(b.commit())
    // A fully agreed deal can't be withdrawn, so the Edit fails whole.
    await setup({}, { 'deals/alice_1': storedDeal({ agreed: { bob: ago(DAY), carol: ago(DAY) } }) })
    const c = writeBatch(fs)
    c.update(dealRef(fs, 'alice_1'), { ended: { outcome: 'withdrawn', at: serverTimestamp(), by: 'alice' } })
    c.set(dealRef(fs, 'alice_2'), proposal('alice', 2, ['bob', 'carol']))
    await denied(c.commit())
    expect((await getDoc(dealRef(fs, 'alice_2'))).exists()).toBe(false)
  })

  test('another space\'s members and deals', async () => {
    await setup()
    await allDenied({
      'a member of s2 proposes in s1': () => propose(db('zoe'), proposal('zoe', 1, ['alice', 'bob', 'carol'])),
      'a member of s2 proposes in s1 with s2\'s members': () => propose(db('zoe'), proposal('zoe', 1, ['yan'])),
      'a member of s1 proposes in s2': () => propose(db('alice'), proposal('alice', 1, ['zoe', 'yan']), 'alice_1', 's2'),
      'a member of s1 proposes in s2 with s1\'s members': () => propose(db('alice'), proposal('alice', 1, ['bob', 'carol']), 'alice_1', 's2'),
      'a space that doesn\'t exist': () => propose(db('alice'), proposal('alice', 1, ['bob', 'carol']), 'alice_1', 'nope'),
    })
  })
})

describe('deals: edit terms after proposing (SPEC §12.17 2: terms never change)', () => {
  test('nobody changes a deal\'s terms, length, friends or identity', async () => {
    // carol agreed; bob hasn't yet, so his Agree alone would pass (below).
    await setup({}, { 'deals/alice_1': storedDeal({ agreed: { carol: ago(DAY) } }) })
    const cases: Record<string, () => Promise<unknown>> = {}
    for (const who of ['alice', 'bob', 'dan']) {
      const ref = dealRef(db(who), 'alice_1')
      Object.assign(cases, {
        [`${who}: the reward`]: () => updateDoc(ref, { reward: 'Sushi' }),
        [`${who}: the penalty`]: () => updateDoc(ref, { penalty: 'Nothing' }),
        [`${who}: a mode`]: () => updateDoc(ref, { rewardMode: 'each', per: { bob: { reward: 'A', penalty: '' }, carol: { reward: 'B', penalty: '' } } }),
        [`${who}: per`]: () => updateDoc(ref, { per: { bob: { reward: 'A', penalty: 'B' } } }),
        [`${who}: the length`]: () => updateDoc(ref, { count: 1 }),
        [`${who}: the unit`]: () => updateDoc(ref, { unit: 'month' }),
        [`${who}: the friends`]: () => updateDoc(ref, { friends: ['bob'] }),
        [`${who}: the person`]: () => updateDoc(ref, { uid: 'bob' }),
        [`${who}: the seq`]: () => updateDoc(ref, { seq: 7 }),
        [`${who}: createdAt`]: () => updateDoc(ref, { createdAt: serverTimestamp() }),
        [`${who}: a new key`]: () => updateDoc(ref, { note: 'easy' }),
        [`${who}: a whole new doc`]: () => setDoc(ref, proposal('alice', 1, ['bob', 'carol'], 'group', 'group', { reward: 'Sushi' })),
        [`${who}: the terms with an Agree`]: () => updateDoc(ref, new FieldPath('agreed', who), serverTimestamp(), 'reward', 'Sushi'),
      })
    }
    await allDenied(cases)
    await allowed(agree(db('bob'), 'bob'))
  })
})

describe('deals: agree', () => {
  test('each friend agrees once, for themselves, with the server time', async () => {
    await setup({}, { 'deals/alice_1': storedDeal() })
    await allowed(agree(db('bob'), 'bob'))
    await denied(agree(db('bob'), 'bob'))
    // agreeToDeal's transaction.
    const fs = db('carol')
    await allowed(runTransaction(fs, async (tx) => {
      await tx.get(doc(fs, 'spaces/s1'))
      await tx.get(dealRef(fs))
      tx.update(dealRef(fs), new FieldPath('agreed', 'carol'), serverTimestamp())
    }))
    expect(Object.keys((await stored()).agreed).sort()).toEqual(['bob', 'carol'])
  })

  test('only a friend in it, for themselves, and nothing else in the write', async () => {
    await seed({ 'spaces/s1': spaceDoc([...S1, 'erin'], { judges: ['dan'], hasDeals: true }), 'spaces/s2': spaceDoc(['zoe']) })
    await seed({ 'spaces/s1/deals/alice_1': storedDeal({ agreed: { carol: ago(DAY) } }) })
    const bob = dealRef(db('bob'))
    await allDenied({
      'a judge (not asked)': () => agree(db('dan'), 'dan'),
      'a member who joined after the proposal': () => agree(db('erin'), 'erin'),
      'the person': () => agree(db('alice'), 'alice'),
      'a non-member': () => agree(db('zoe'), 'zoe'),
      'signed out': () => agree(db(), 'bob'),
      'twice (carol)': () => agree(db('carol'), 'carol'),
      'a client time': () => updateDoc(bob, new FieldPath('agreed', 'bob'), Timestamp.now()),
      'a time an hour ago': () => updateDoc(bob, new FieldPath('agreed', 'bob'), ago(HOUR)),
      'not a time': () => updateDoc(bob, new FieldPath('agreed', 'bob'), true),
      'another friend\'s key': () => updateDoc(dealRef(db('carol')), new FieldPath('agreed', 'bob'), serverTimestamp()),
      'own and another\'s key': () => updateDoc(bob, new FieldPath('agreed', 'bob'), serverTimestamp(), new FieldPath('agreed', 'erin'), serverTimestamp()),
      'dropping carol\'s Agree': () => updateDoc(bob, { agreed: { bob: serverTimestamp() } }),
      'with another field (off)': () => updateDoc(bob, new FieldPath('agreed', 'bob'), serverTimestamp(), new FieldPath('off', 'bob'), serverTimestamp()),
      'with another field (count)': () => updateDoc(bob, new FieldPath('agreed', 'bob'), serverTimestamp(), 'count', 1),
      'with another field (agreedAt)': () => updateDoc(bob, new FieldPath('agreed', 'bob'), serverTimestamp(), 'agreedAt', serverTimestamp()),
    })
    await allowed(agree(db('bob'), 'bob'))
  })

  test('a friend who turned judge after the proposal is still in it and agrees (SPEC §12.2)', async () => {
    await setup({ judges: ['dan', 'bob'] }, { 'deals/alice_1': storedDeal() })
    await allowed(agree(db('bob'), 'bob'))
  })

  test('a friend who left can\'t agree, nor anyone once its person left or was removed', async () => {
    await setup(without(['carol']), { 'deals/alice_1': storedDeal() })
    await denied(agree(db('carol'), 'carol'))
    await allowed(agree(db('bob'), 'bob'))
    // alice left (ownership handed on), or the owner removed her: her waiting deal never starts.
    await setup(without(['alice']), { 'deals/alice_1': storedDeal() })
    await allDenied({ 'bob': () => agree(db('bob'), 'bob'), 'carol': () => agree(db('carol'), 'carol') })
    // Back in the space: her deal can be agreed to again.
    await setup({ leftAt: { alice: ago(DAY) } }, { 'deals/alice_1': storedDeal() })
    await allowed(agree(db('bob'), 'bob'))
  })

  test('not after the job stamped its start, nor after it ended', async () => {
    // carol left before agreeing, the job stamped the start, and she came back.
    await setup({ leftAt: { carol: ago(DAY) } }, { 'deals/alice_1': storedDeal({ agreed: { bob: ago(2 * DAY) }, ...STAMPS }) })
    await denied(agree(db('carol'), 'carol'))
    await setup({}, { 'deals/alice_1': storedDeal({ start: '2026-11-16' }) })
    await denied(agree(db('carol'), 'carol'))
    for (const ended of [withdrawnBy(), WON, LOST, OFF]) {
      await setup({}, { 'deals/alice_1': storedDeal({ ended }) })
      await denied(agree(db('bob'), 'bob'))
    }
  })
})

describe('deals: withdraw', () => {
  test('its person withdraws it while some friend still in the space hasn\'t agreed', async () => {
    await setup({}, { 'deals/alice_1': storedDeal() })
    await allowed(withdraw(db('alice')))
    expect((await stored()).ended).toMatchObject({ outcome: 'withdrawn', by: 'alice' })
    await setup({}, { 'deals/alice_1': storedDeal({ agreed: { bob: ago(DAY) } }) })
    await allowed(withdraw(db('alice')))
    // A friend who agreed and left doesn't count: carol is still needed.
    await setup(without(['bob']), { 'deals/alice_1': storedDeal({ agreed: { bob: ago(DAY) } }) })
    await allowed(withdraw(db('alice')))
  })

  test('every friend left: nobody is needed, so it can be withdrawn', async () => {
    await setup(without(['bob', 'carol']), { 'deals/alice_1': storedDeal() })
    await allowed(withdraw(db('alice')))
    await setup(without(['bob', 'carol']), { 'deals/alice_1': storedDeal({ agreed: { bob: ago(DAY), carol: ago(DAY) } }) })
    await allowed(withdraw(db('alice')))
  })

  test('not once everyone still in it agreed, nor after the start, nor by anyone else', async () => {
    await setup({}, { 'deals/alice_1': storedDeal({ agreed: { bob: ago(DAY), carol: ago(DAY) } }) })
    await denied(withdraw(db('alice')))
    // carol left without agreeing and bob agreed: fully agreed.
    await setup(without(['carol']), { 'deals/alice_1': storedDeal({ agreed: { bob: ago(DAY) } }) })
    await denied(withdraw(db('alice')))
    // Stamped by the job, then carol left and came back without agreeing: still not withdrawable.
    await setup({ leftAt: { carol: ago(HOUR) } }, { 'deals/alice_1': storedDeal({ agreed: { bob: ago(DAY) }, ...STAMPS }) })
    await denied(withdraw(db('alice')))
    await setup({}, { 'deals/alice_1': storedDeal({ start: '2026-11-16' }) })
    await denied(withdraw(db('alice')))
    // Its person left: the job withdraws it, not a client.
    await setup(without(['alice'], { ownerId: 'bob' }), { 'deals/alice_1': storedDeal() })
    await allDenied({ 'alice': () => withdraw(db('alice')), 'bob for alice': () => withdraw(db('bob')) })

    await setup({}, { 'deals/alice_1': storedDeal({ agreed: { bob: ago(DAY) } }) })
    const ref = dealRef(db('alice'))
    await allDenied({
      'a friend': () => withdraw(db('bob'), 'bob'),
      'a friend, as the person': () => withdraw(db('bob'), 'alice'),
      'a judge': () => withdraw(db('dan'), 'dan'),
      'a non-member': () => withdraw(db('zoe'), 'zoe'),
      'outcome won': () => updateDoc(ref, { ended: { outcome: 'won', at: serverTimestamp(), by: 'alice' } }),
      'outcome off': () => updateDoc(ref, { ended: { outcome: 'off', at: serverTimestamp(), by: 'alice' } }),
      'by someone else': () => withdraw(db('alice'), 'bob'),
      'at a client time': () => updateDoc(ref, { ended: { outcome: 'withdrawn', at: Timestamp.now(), by: 'alice' } }),
      'without at': () => updateDoc(ref, { ended: { outcome: 'withdrawn', by: 'alice' } }),
      'with a reason': () => withdraw(db('alice'), 'alice', 'alice_1', { reason: 'called-off' }),
      'with checkedAt': () => updateDoc(ref, { ended: { outcome: 'withdrawn', at: serverTimestamp(), by: 'alice' }, checkedAt: serverTimestamp() }),
      'with an Agree dropped': () => updateDoc(ref, { ended: { outcome: 'withdrawn', at: serverTimestamp(), by: 'alice' }, agreed: {} }),
    })
    for (const ended of [withdrawnBy(), WON, LOST, OFF]) {
      await setup({}, { 'deals/alice_1': storedDeal({ ended }) })
      await denied(withdraw(db('alice')))
    }
  })
})

describe('deals: call off', () => {
  test('its person and each friend who agreed tap Call Off, once; the job decides the end', async () => {
    await setup({}, { 'deals/alice_1': agreedDeal() })
    await allowed(callOff(db('alice'), 'alice'))
    await allowed(callOff(db('bob'), 'bob'))
    await allowed(callOff(db('carol'), 'carol'))
    const d = await stored()
    expect(Object.keys(d.off).sort()).toEqual(['alice', 'bob', 'carol'])
    expect(d.ended).toBeNull()
  })

  test('only the person or a friend who agreed, once, for themselves, while it\'s in play', async () => {
    // erin joined later; carol never agreed (the deal waits on her).
    await seed({ 'spaces/s1': spaceDoc([...S1, 'erin'], { judges: ['dan'], hasDeals: true }), 'spaces/s2': spaceDoc(['zoe']) })
    await seed({ 'spaces/s1/deals/alice_1': storedDeal({ agreed: { bob: ago(DAY) }, off: { bob: ago(HOUR) } }) })
    const alice = dealRef(db('alice'))
    await allDenied({
      'a friend who never agreed': () => callOff(db('carol'), 'carol'),
      'a second tap': () => callOff(db('bob'), 'bob'),
      'a judge': () => callOff(db('dan'), 'dan'),
      'a later joiner': () => callOff(db('erin'), 'erin'),
      'a non-member': () => callOff(db('zoe'), 'zoe'),
      'signed out': () => callOff(db(), 'alice'),
      'someone else\'s key': () => updateDoc(alice, new FieldPath('off', 'carol'), serverTimestamp()),
      'own and someone else\'s key': () => updateDoc(alice, new FieldPath('off', 'alice'), serverTimestamp(), new FieldPath('off', 'carol'), serverTimestamp()),
      'removing a tap (deleteField)': () => updateDoc(dealRef(db('bob')), new FieldPath('off', 'bob'), deleteField()),
      'removing a tap (a new map)': () => updateDoc(alice, { off: { alice: serverTimestamp() } }),
      'a client time': () => updateDoc(alice, new FieldPath('off', 'alice'), Timestamp.now()),
      'with another field': () => updateDoc(alice, new FieldPath('off', 'alice'), serverTimestamp(), 'checkedAt', serverTimestamp()),
    })
    await allowed(callOff(db('alice'), 'alice'))
    // A party who left can't tap (nor needs to).
    await setup(without(['carol']), { 'deals/alice_1': agreedDeal() })
    await denied(callOff(db('carol'), 'carol'))
    // Its person, once no longer a member, can't either.
    await setup(without(['alice'], { ownerId: 'bob' }), { 'deals/alice_1': agreedDeal() })
    await denied(callOff(db('alice'), 'alice'))
    for (const ended of [withdrawnBy(), WON, LOST, OFF]) {
      await setup({}, { 'deals/alice_1': agreedDeal({ ended }) })
      await denied(callOff(db('alice'), 'alice'))
    }
  })

  test('nobody calls it off alone: no client writes the end, even with every friend gone', async () => {
    const offNow = { outcome: 'off', at: serverTimestamp(), reason: 'called-off' }
    // Every party left: the person's tap is only a tap (the job ends it 'alone' at the next lock).
    await setup(without(['bob', 'carol']), { 'deals/alice_1': agreedDeal() })
    const ref = dealRef(db('alice'))
    await allDenied({
      'the end alone': () => updateDoc(ref, { ended: offNow }),
      'the end with the tap': () => updateDoc(ref, new FieldPath('off', 'alice'), serverTimestamp(), 'ended', offNow),
      'the end as alone': () => updateDoc(ref, { ended: { outcome: 'off', at: serverTimestamp(), reason: 'alone' } }),
      'withdrawing a running deal instead': () => withdraw(db('alice')),
    })
    await allowed(callOff(db('alice'), 'alice'))
    expect((await stored()).ended).toBeNull()
    // Everyone tapped: still the job's to end.
    await setup({}, { 'deals/alice_1': agreedDeal({ off: { alice: ago(DAY), bob: ago(DAY) } }) })
    await allowed(callOff(db('carol'), 'carol'))
    await allDenied({
      'the person': () => updateDoc(dealRef(db('alice')), { ended: offNow }),
      'a party': () => updateDoc(dealRef(db('carol')), { ended: offNow }),
    })
    expect((await stored()).ended).toBeNull()
  })
})

describe('deals: settle', () => {
  const F7 = M8.slice(1)
  /** s8: m1 … m8; m1's first deal with the 7 others, agreed by all, ended `ended`. */
  async function setup8(ended: DocumentData | null, extra: DocumentData = {}, space: DocumentData = {}) {
    await clear()
    await seed({
      'spaces/s8': spaceDoc(M8, { hasDeals: true, ...space }),
      'spaces/s2': spaceDoc(['zoe']),
      'spaces/s8/deals/m1_1': {
        ...proposal('m1', 1, F7), createdAt: ago(40 * DAY), agreed: Object.fromEntries(F7.map((f) => [f, ago(39 * DAY)])),
        ...(ended ? { ...STAMPS, track: TRACK } : {}), ended, ...extra,
      },
    })
  }
  const settle8 = (me: string, friends: string[], settled = true, mark: DocumentData = {}) => settle(db(me), me, friends, settled, 'm1_1', 's8', mark)
  const marks = async () => (await getDoc(dealRef(db('m1'), 'm1_1', 's8'))).data()!.settled

  test('once won or lost, any member marks pairs, a together line of 7 in one write, and unsettles', async () => {
    await setup8(WON)
    await allowed(settle8('m1', ['m2']))
    await allowed(settle8('m5', ['m3']))
    await allowed(settle8('m1', F7))
    expect(Object.keys(await marks()).sort()).toEqual(F7)
    await allowed(settle8('m2', ['m2'], false))
    expect((await marks()).m2).toMatchObject({ settled: false, by: 'm2' })
    await setup8(LOST)
    await allowed(settle8('m4', F7))
  })

  test('not before the job ended it, nor for a withdrawn or called-off deal', async () => {
    for (const ended of [null, withdrawnBy('m1'), OFF, { outcome: 'off', at: ago(HOUR), reason: 'alone' }]) {
      await setup8(ended)
      await denied(settle8('m1', ['m2']))
    }
    // Running: stamped by the job, not ended.
    await setup8(null, { ...STAMPS, track: TRACK })
    await denied(settle8('m1', F7))
  })

  test('only marks of friends who agreed, each `{ settled, by: me, at: now }`, never removed', async () => {
    await setup8(WON, { agreed: Object.fromEntries(F7.slice(0, 6).map((f) => [f, ago(39 * DAY)])), settled: { m2: { settled: true, by: 'm1', at: ago(HOUR) } } }, { leftAt: { x9: ago(DAY) } })
    const ref = dealRef(db('m1'), 'm1_1', 's8')
    await allDenied({
      'a friend who never agreed': () => settle8('m1', ['m8']),
      'with a friend who never agreed': () => settle8('m1', F7),
      'the person': () => settle8('m1', ['m1']),
      'a non-friend': () => settle8('m1', ['zoe']),
      'by someone else': () => settle8('m1', ['m3'], true, { by: 'm3' }),
      'at a client time': () => settle8('m1', ['m3'], true, { at: Timestamp.now() }),
      'without at': () => updateDoc(ref, new FieldPath('settled', 'm3'), { settled: true, by: 'm1' }),
      'a 4th field': () => settle8('m1', ['m3'], true, { note: 'paid' }),
      'settled not a bool': () => updateDoc(ref, new FieldPath('settled', 'm3'), { settled: 'yes', by: 'm1', at: serverTimestamp() }),
      'not a map': () => updateDoc(ref, new FieldPath('settled', 'm3'), true),
      'removing a mark (deleteField)': () => updateDoc(ref, new FieldPath('settled', 'm2'), deleteField()),
      'removing a mark (a new map)': () => updateDoc(ref, { settled: { m3: { settled: true, by: 'm1', at: serverTimestamp() } } }),
      'nothing changed': async () => updateDoc(ref, { settled: (await getDoc(ref)).get('settled') }),
      'with another field': () => updateDoc(ref, new FieldPath('settled', 'm3'), { settled: true, by: 'm1', at: serverTimestamp() }, 'checkedAt', serverTimestamp()),
      'a non-member': () => settle(db('zoe'), 'zoe', ['m3'], true, 'm1_1', 's8'),
      'signed out': () => settle(db(), 'm1', ['m3'], true, 'm1_1', 's8'),
    })
    // A member who left can't mark any more (the others still can, for them).
    await setup8(WON, {}, { memberIds: M8.slice(0, 7), leftAt: { m8: ago(HOUR) } })
    await denied(settle8('m8', ['m8']))
    await allowed(settle8('m1', ['m8']))
  })
})

describe('deals: what only the reminders job writes (SPEC §12.6)', () => {
  test('no client writes agreedAt, start, track, checkedAt or an end other than a withdrawal', async () => {
    const t = serverTimestamp()
    const ended = (outcome: string) => ({ outcome, at: t, ...(outcome === 'off' ? { reason: 'called-off' } : { period: '2026-11-16' }) })
    const cases: Record<string, () => Promise<unknown>> = {}
    // On a waiting deal (bob agreed) and on a running one, by its person, a friend, a judge.
    for (const [state, deal] of [['waiting', storedDeal({ agreed: { bob: ago(DAY) } })], ['running', agreedDeal()]] as const) {
      await setup({}, { 'deals/alice_1': deal })
      for (const who of ['alice', 'carol', 'dan']) {
        const ref = dealRef(db(who))
        const tag = `${state}, ${who}`
        Object.assign(cases, {
          [`${tag}: agreedAt`]: () => updateDoc(ref, { agreedAt: t }),
          [`${tag}: start`]: () => updateDoc(ref, { start: '2026-11-23' }),
          [`${tag}: track`]: () => updateDoc(ref, { track: [{ id: '2026-11-23', result: 'pass', score: 100 }] }),
          [`${tag}: track emptied`]: () => updateDoc(ref, { track: [] }),
          [`${tag}: checkedAt`]: () => updateDoc(ref, { checkedAt: t }),
          [`${tag}: ended won`]: () => updateDoc(ref, { ended: ended('won') }),
          [`${tag}: ended lost`]: () => updateDoc(ref, { ended: ended('lost') }),
          [`${tag}: ended off`]: () => updateDoc(ref, { ended: ended('off') }),
          [`${tag}: an Agree with agreedAt`]: () => updateDoc(ref, new FieldPath('agreed', who), t, 'agreedAt', t),
          [`${tag}: an Agree with start`]: () => updateDoc(ref, new FieldPath('agreed', who), t, 'start', '2026-11-23'),
          [`${tag}: a tap with ended off`]: () => updateDoc(ref, new FieldPath('off', who), t, 'ended', ended('off')),
          [`${tag}: a tap with track`]: () => updateDoc(ref, new FieldPath('off', who), t, 'track', []),
          [`${tag}: a withdrawal with checkedAt`]: () => updateDoc(ref, { ended: { outcome: 'withdrawn', at: t, by: 'alice' }, checkedAt: t }),
        })
        // Only a running deal has a start to remove.
        if (state === 'running') Object.assign(cases, {
          [`${tag}: start removed`]: () => updateDoc(ref, { start: deleteField() }),
          [`${tag}: a withdrawal with start removed`]: () => updateDoc(ref, { ended: { outcome: 'withdrawn', at: t, by: 'alice' }, start: deleteField() }),
        })
      }
      await allDenied(cases)
      for (const k of Object.keys(cases)) delete cases[k]
    }
    // After the end: settling can't carry a job field either, nor rewrite the end.
    await setup({}, { 'deals/alice_1': agreedDeal({ ended: LOST }) })
    const ref = dealRef(db('bob'))
    await allDenied({
      'a mark with checkedAt': () => updateDoc(ref, new FieldPath('settled', 'bob'), { settled: true, by: 'bob', at: t }, 'checkedAt', t),
      'a mark with ended won': () => updateDoc(ref, new FieldPath('settled', 'bob'), { settled: true, by: 'bob', at: t }, 'ended', ended('won')),
      'the end changed to won': () => updateDoc(dealRef(db('alice')), { ended: ended('won') }),
      'the end changed to withdrawn': () => withdraw(db('alice')),
      'the end removed': () => updateDoc(dealRef(db('alice')), { ended: null }),
    })
  })
})

describe('deals: never deleted (SPEC §12.4)', () => {
  test('nobody deletes a deal: ended or waiting, own or someone else\'s, with or without a profile', async () => {
    await setup({}, {
      'deals/alice_1': agreedDeal({ ended: LOST }),
      'deals/alice_2': storedDeal({ seq: 2 }),
      'deals/bob_1': { ...proposal('bob', 1, ['alice', 'carol']), createdAt: ago(DAY), ended: withdrawnBy('bob') },
    })
    await allDenied({
      'alice, her ended deal, without a profile': () => deleteDoc(dealRef(db('alice'), 'alice_1')),
      'alice, her waiting deal': () => deleteDoc(dealRef(db('alice'), 'alice_2')),
      'alice, bob\'s': () => deleteDoc(dealRef(db('alice'), 'bob_1')),
      'bob, alice\'s': () => deleteDoc(dealRef(db('bob'), 'alice_1')),
      'dan (a judge), alice\'s': () => deleteDoc(dealRef(db('dan'), 'alice_1')),
      'a non-member': () => deleteDoc(dealRef(db('zoe'), 'alice_1')),
      'alice resets her chain in a batch': () => {
        const fs = db('alice')
        const b = writeBatch(fs)
        b.delete(dealRef(fs, 'alice_1'))
        b.delete(dealRef(fs, 'alice_2'))
        b.set(dealRef(fs, 'alice_1'), proposal('alice', 1, ['bob', 'carol']))
        return b.commit()
      },
    })
    await seed({ 'users/alice': profileDoc('Alice'), 'users/bob': profileDoc('Bob') })
    await allDenied({
      'alice, her ended deal, with a profile': () => deleteDoc(dealRef(db('alice'), 'alice_1')),
      'alice deletes her profile and her deal in one batch': () => {
        const fs = db('alice')
        const b = writeBatch(fs)
        b.delete(doc(fs, 'users/alice'))
        b.delete(dealRef(fs, 'alice_1'))
        return b.commit()
      },
      'bob, his own withdrawn deal': () => deleteDoc(dealRef(db('bob'), 'bob_1')),
    })
    // A deleted account's deals stay: its profile is gone, it left, and still nothing deletes them.
    await setup(without(['alice'], { ownerId: 'bob' }), { 'deals/alice_1': agreedDeal({ ended: LOST }) })
    await denied(deleteDoc(dealRef(db('alice'), 'alice_1')))
    expect((await getDoc(dealRef(db('bob'), 'alice_1'))).exists()).toBe(true)
  })
})

describe('deals: read', () => {
  test('members get and query a space\'s deals; nobody else does', async () => {
    await setup({}, {
      'deals/alice_1': agreedDeal({ ended: WON }),
      'deals/alice_2': storedDeal({ seq: 2 }),
      'deals/bob_1': { ...proposal('bob', 1, ['alice', 'carol']), createdAt: ago(DAY) },
    })
    const coll = (fs: Firestore) => collection(fs, 'spaces/s1/deals')
    for (const who of ['alice', 'bob', 'dan']) {
      const fs = db(who)
      await allowed(getDoc(dealRef(fs, 'alice_1')))
      expect((await getDocs(query(coll(fs), where('ended', '==', null)))).size).toBe(2)
      expect((await getDocs(query(coll(fs), where('ended.at', '>=', ago(60 * DAY))))).size).toBe(1)
      expect((await getDocs(query(coll(fs), where('uid', '==', 'alice')))).size).toBe(2)
      expect((await getDocs(coll(fs))).size).toBe(3)
    }
    await seed({ 'spaces/s1': spaceDoc(S1.filter((u) => u !== 'carol'), { judges: ['dan'], hasDeals: true, leftAt: { carol: ago(HOUR) } }) })
    await allDenied({
      'a non-member gets': () => getDoc(dealRef(db('zoe'), 'alice_1')),
      'a non-member lists': () => getDocs(coll(db('zoe'))),
      'a non-member queries the open ones': () => getDocs(query(coll(db('zoe')), where('ended', '==', null))),
      'a member who left gets': () => getDoc(dealRef(db('carol'), 'alice_1')),
      'a member who left queries': () => getDocs(query(coll(db('carol')), where('uid', '==', 'alice'))),
      'signed out gets': () => getDoc(dealRef(db(), 'alice_1')),
      'signed out lists': () => getDocs(coll(db())),
      'a collection-group query': () => getDocs(query(collectionGroup(db('alice'), 'deals'), where('uid', '==', 'alice'))),
    })
  })
})
