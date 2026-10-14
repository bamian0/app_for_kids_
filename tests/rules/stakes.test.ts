// Per-person stakes (SPEC §9.7): spaces/{id}/stakes/{uid}, a mode per line, Agree stamped with the
// server time. The worst-case docs' costs are measured in budget.test.ts.
import { describe, expect, test } from 'vitest'
import {
  collection, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc, Timestamp, updateDoc,
  type DocumentData, type Firestore,
} from 'firebase/firestore'
import { allDenied, allowed, DAY, denied, spaceDoc, ts, useRulesEnv } from './helpers.ts'

const { db, seed } = useRulesEnv()

const ABC = ['alice', 'bob', 'carol']
const ref = (fs: Firestore, uid = 'alice') => doc(fs, `spaces/s1/stakes/${uid}`)

type Mode = 'group' | 'each'
/** alice's stakes: Same for everyone on both lines unless the modes say otherwise. */
function stakes(rewardMode: Mode = 'group', penaltyMode: Mode = 'group', extra: DocumentData = {}): DocumentData {
  return {
    rewardMode,
    penaltyMode,
    reward: rewardMode === 'group' ? 'Dinner, on them' : '',
    penalty: penaltyMode === 'group' ? 'Coffee for everyone' : '',
    per: rewardMode === 'group' && penaltyMode === 'group' ? {} : {
      bob: { reward: rewardMode === 'each' ? 'Lunch' : '', penalty: penaltyMode === 'each' ? 'A coffee' : '' },
      carol: { reward: rewardMode === 'each' ? 'A movie' : '', penalty: penaltyMode === 'each' ? 'A beer' : '' },
    },
    tiers: [{ months: 3, reward: 'Weekend away' }],
    agreed: {},
    updatedAt: serverTimestamp(),
    ...extra,
  }
}
/** The stored version of `stakes(...)` (server timestamps resolved), for seeding. */
const stored = (d: DocumentData, extra: DocumentData = {}): DocumentData => ({ ...d, updatedAt: ts(Date.now() - DAY), ...extra })
/** The pair terms of `d` for `friend`, as the Agree copies them. */
function termsFor(d: DocumentData, friend: string): DocumentData {
  return {
    rewardMode: d.rewardMode,
    penaltyMode: d.penaltyMode,
    reward: d.rewardMode === 'group' ? d.reward : d.per[friend].reward,
    penalty: d.penaltyMode === 'group' ? d.penalty : d.per[friend].penalty,
    tiers: d.tiers,
  }
}
/** The owner's edit: everything but `agreed`. */
const edit = (fs: Firestore, d: DocumentData) => {
  const { agreed: _, ...terms } = d
  return updateDoc(ref(fs), terms)
}
/** agreeToStakes' write: agreed.{me} only. */
const agree = (fs: Firestore, me: string, agreement: DocumentData, owner = 'alice') =>
  updateDoc(ref(fs, owner), { [`agreed.${me}`]: agreement })

const MODES: Array<[Mode, Mode]> = [['group', 'group'], ['group', 'each'], ['each', 'group'], ['each', 'each']]

describe('own stakes', () => {
  test.each(MODES)('created and edited with reward %s, penalty %s', async (r, p) => {
    await seed({ 'spaces/s1': spaceDoc(ABC) })
    const alice = db('alice')
    await allowed(setDoc(ref(alice), stakes(r, p)))
    // Back from any combination to any other, keeping the per-friend texts for switching back.
    for (const [r2, p2] of MODES) await allowed(edit(alice, { ...stakes(r2, p2), per: stakes('each', 'each').per }))
    await allowed(edit(alice, stakes(r, p)))
  })

  test('a per-friend line may leave a friend out (no terms with them yet)', async () => {
    await seed({ 'spaces/s1': spaceDoc(ABC) })
    const d = stakes('group', 'each')
    await allowed(setDoc(ref(db('alice')), { ...d, per: { bob: d.per.bob } }))
  })

  test('invalid stakes are refused', async () => {
    await seed({ 'spaces/s1': spaceDoc([...ABC, 'dave', 'erin', 'fred', 'gina', 'hank', 'ivan']) })
    const alice = db('alice')
    const create = (d: DocumentData) => () => setDoc(ref(alice), d)
    const each = stakes('each', 'each')
    const nine = ['bob', 'carol', 'dave', 'erin', 'fred', 'gina', 'hank', 'ivan']
    await allDenied({
      'a blank group reward': create(stakes('group', 'group', { reward: '  ' })),
      'an empty group penalty': create(stakes('group', 'group', { penalty: '' })),
      'a group text of 121': create(stakes('group', 'group', { reward: 'x'.repeat(121) })),
      'a blank per-friend reward for a listed friend': create({ ...each, per: { ...each.per, bob: { reward: ' ', penalty: 'A coffee' } } }),
      'an empty per-friend penalty for a listed friend': create({ ...each, per: { ...each.per, carol: { reward: 'A movie', penalty: '' } } }),
      'a per-friend text of 121': create({ ...each, per: { ...each.per, bob: { reward: 'x'.repeat(121), penalty: 'A coffee' } } }),
      'per for a non-member': create({ ...each, per: { ...each.per, zoe: { reward: 'Lunch', penalty: 'Tea' } } }),
      'per for the owner': create({ ...each, per: { ...each.per, alice: { reward: 'Lunch', penalty: 'Tea' } } }),
      '8 per entries': create({ ...each, per: Object.fromEntries(nine.map((u) => [u, { reward: 'Lunch', penalty: 'Tea' }])) }),
      'a per entry with one text': create({ ...each, per: { ...each.per, bob: { reward: 'Lunch' } } }),
      'a per entry with an extra key': create({ ...each, per: { ...each.per, bob: { reward: 'Lunch', penalty: 'Tea', tier: 'x' } } }),
      'per not a map': create({ ...each, per: [] }),
      'a bad mode': create(stakes('group', 'group', { rewardMode: 'both' })),
      'the first draft\'s single mode key': create((({ rewardMode: _r, penaltyMode: _p, ...rest }) => ({ ...rest, mode: 'group' }))(stakes())),
      'one mode missing': create((({ penaltyMode: _, ...rest }) => rest)(stakes())),
      'an extra key': create(stakes('group', 'group', { from: '2026-11' })),
      'agreements on create': create(stakes('group', 'group', { agreed: { bob: {} } })),
      'a client updatedAt': create(stakes('group', 'group', { updatedAt: Timestamp.now() })),
      '6 streak rewards': create(stakes('group', 'group', { tiers: [2, 3, 4, 6, 9, 12].map((months) => ({ months, reward: 'Trip' })) })),
      'a 1-month streak': create(stakes('group', 'group', { tiers: [{ months: 1, reward: 'Trip' }] })),
      'a 37-month streak': create(stakes('group', 'group', { tiers: [{ months: 37, reward: 'Trip' }] })),
      'a fractional streak': create(stakes('group', 'group', { tiers: [{ months: 2.5, reward: 'Trip' }] })),
      'streaks out of order': create(stakes('group', 'group', { tiers: [{ months: 6, reward: 'Trip' }, { months: 3, reward: 'Spa' }] })),
      'the same streak twice': create(stakes('group', 'group', { tiers: [{ months: 3, reward: 'Trip' }, { months: 3, reward: 'Spa' }] })),
      'a blank streak reward': create(stakes('group', 'group', { tiers: [{ months: 3, reward: ' ' }] })),
      'a streak with an extra key': create(stakes('group', 'group', { tiers: [{ months: 3, reward: 'Trip', at: 1 }] })),
      'someone else\'s doc': () => setDoc(ref(db('bob'), 'alice'), stakes()),
      'a non-member\'s own doc': () => setDoc(ref(db('zoe'), 'zoe'), stakes()),
      'signed out': () => setDoc(ref(db(), 'alice'), stakes()),
    })
    // The edge: five streaks of 2 to 36 months.
    await allowed(create(stakes('group', 'group', { tiers: [2, 3, 12, 24, 36].map((months) => ({ months, reward: 'Trip' })) }))())
  })

  test('the owner\'s edits never touch agreements', async () => {
    const d = stakes()
    const agreement = { at: ts(Date.now() - DAY), terms: termsFor(d, 'bob'), past: [] }
    await seed({ 'spaces/s1': spaceDoc(ABC), 'spaces/s1/stakes/alice': stored(d, { agreed: { bob: agreement } }) })
    const alice = db('alice')
    await allDenied({
      'clear them': () => updateDoc(ref(alice), { reward: 'Sushi', agreed: {}, updatedAt: serverTimestamp() }),
      'forge one': () => updateDoc(ref(alice), { 'agreed.carol': { ...agreement }, updatedAt: serverTimestamp() }),
      'agree for a friend': () => agree(alice, 'carol', { ...agreement, at: serverTimestamp() }),
      'without updatedAt': () => updateDoc(ref(alice), { reward: 'Sushi' }),
      'a friend edits them': () => updateDoc(ref(db('bob')), { reward: 'Nothing', updatedAt: serverTimestamp() }),
      'delete': () => deleteDoc(ref(alice)),
    })
    await allowed(updateDoc(ref(alice), { reward: 'Sushi', updatedAt: serverTimestamp() }))
    expect((await getDoc(ref(alice))).data()?.agreed).toEqual({ bob: agreement })
  })

  test('members read stakes; others don\'t', async () => {
    await seed({ 'spaces/s1': spaceDoc(ABC), 'spaces/s1/stakes/alice': stored(stakes()) })
    await allowed(getDoc(ref(db('carol'))))
    await allowed(getDocs(collection(db('bob'), 'spaces/s1/stakes')))
    await denied(getDoc(ref(db('zoe'))))
    await denied(getDocs(collection(db(), 'spaces/s1/stakes')))
  })

  test('a former member\'s stakes stay readable, and they can\'t edit them', async () => {
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob'], { leftAt: { carol: ts(Date.now() - DAY) } }), 'spaces/s1/stakes/carol': stored(stakes()) })
    await allowed(getDoc(ref(db('bob'), 'carol')))
    await denied(updateDoc(ref(db('carol'), 'carol'), { reward: 'Sushi', updatedAt: serverTimestamp() }))
  })
})

describe('Agree', () => {
  const OLD = stakes()
  const NEW = stakes('group', 'group', { reward: 'Sushi, on them' })
  const T1 = ts(Date.now() - 3 * DAY)

  test('a friend\'s first Agree copies the current terms, stamped with the server time', async () => {
    for (const [r, p] of MODES) {
      const d = stakes(r, p)
      await seed({ 'spaces/s1': spaceDoc(ABC), 'spaces/s1/stakes/alice': stored(d) })
      await allowed(agree(db('bob'), 'bob', { at: serverTimestamp(), terms: termsFor(d, 'bob'), past: [] }))
      await allowed(agree(db('carol'), 'carol', { at: serverTimestamp(), terms: termsFor(d, 'carol'), past: [] }))
    }
  })

  test('a new Agree after a change moves the previous one into past, with its own time', async () => {
    await seed({ 'spaces/s1': spaceDoc(ABC), 'spaces/s1/stakes/alice': stored(NEW, { agreed: { bob: { at: T1, terms: termsFor(OLD, 'bob'), past: [] } } }) })
    await allowed(agree(db('bob'), 'bob', { at: serverTimestamp(), terms: termsFor(NEW, 'bob'), past: [{ ...termsFor(OLD, 'bob'), at: T1 }] }))
    const a = (await getDoc(ref(db('bob')))).data()!.agreed.bob
    expect(a.terms.reward).toBe('Sushi, on them')
    expect(a.past).toEqual([{ ...termsFor(OLD, 'bob'), at: T1 }])
    // Going back to terms agreed before is a new agreement too.
    await seed({ 'spaces/s1/stakes/alice': stored(OLD, { agreed: { bob: a } }) })
    await allowed(agree(db('bob'), 'bob', { at: serverTimestamp(), terms: termsFor(OLD, 'bob'), past: [...a.past, { ...a.terms, at: a.at }] }))
  })

  test('six agreements at most: the next one drops the oldest', async () => {
    const past = [1, 2, 3, 4, 5].map((i) => ({ ...termsFor(stakes('group', 'group', { reward: `Lunch ${i}` }), 'bob'), at: ts(Date.now() - (10 - i) * DAY) }))
    const current = { at: T1, terms: termsFor(OLD, 'bob'), past }
    await seed({ 'spaces/s1': spaceDoc(ABC), 'spaces/s1/stakes/alice': stored(NEW, { agreed: { bob: current } }) })
    const stamped = { ...termsFor(OLD, 'bob'), at: T1 }
    await allDenied({
      'keeping all six': () => agree(db('bob'), 'bob', { at: serverTimestamp(), terms: termsFor(NEW, 'bob'), past: [...past, stamped] }),
      'dropping the newest': () => agree(db('bob'), 'bob', { at: serverTimestamp(), terms: termsFor(NEW, 'bob'), past: [...past.slice(0, 4), stamped] }),
    })
    await allowed(agree(db('bob'), 'bob', { at: serverTimestamp(), terms: termsFor(NEW, 'bob'), past: [...past.slice(1), stamped] }))
  })

  test('refused agreements', async () => {
    const each = stakes('group', 'each')
    const previous = { at: T1, terms: termsFor(OLD, 'bob'), past: [{ ...termsFor(stakes('group', 'group', { reward: 'Tea' }), 'bob'), at: ts(Date.now() - 5 * DAY) }] }
    await seed({
      'spaces/s1': spaceDoc(ABC),
      'spaces/s1/stakes/alice': stored(NEW, { agreed: { bob: previous } }),
      // carol has no per-friend line yet.
      'spaces/s1/stakes/dora': stored({ ...each, per: { bob: each.per.bob } }),
      'spaces/s1/stakes/bob': stored(OLD),
      'spaces/s1/stakes/carol': stored(NEW, { agreed: { bob: previous, alice: { at: T1, terms: termsFor(NEW, 'alice'), past: [] } } }),
    })
    const bob = db('bob')
    const next = (extra: DocumentData = {}) => ({ at: serverTimestamp(), terms: termsFor(NEW, 'bob'), past: [...previous.past, { ...previous.terms, at: T1 }], ...extra })
    await allDenied({
      'an unchanged re-agree': () => seed({ 'spaces/s1/stakes/alice': stored(OLD, { agreed: { bob: previous } }) })
        .then(() => agree(bob, 'bob', { at: serverTimestamp(), terms: termsFor(OLD, 'bob'), past: [...previous.past, { ...previous.terms, at: T1 }] }))
        .finally(() => seed({ 'spaces/s1/stakes/alice': stored(NEW, { agreed: { bob: previous } }) })),
      'a client time': () => agree(bob, 'bob', next({ at: Timestamp.now() })),
      'terms that changed a moment ago': () => agree(bob, 'bob', next({ terms: termsFor(OLD, 'bob') })),
      'terms with another text': () => agree(bob, 'bob', next({ terms: { ...termsFor(NEW, 'bob'), penalty: 'Nothing' } })),
      'terms with other tiers': () => agree(bob, 'bob', next({ terms: { ...termsFor(NEW, 'bob'), tiers: [] } })),
      'terms with another mode': () => agree(bob, 'bob', next({ terms: { ...termsFor(NEW, 'bob'), rewardMode: 'each' } })),
      'terms with an extra key': () => agree(bob, 'bob', next({ terms: { ...termsFor(NEW, 'bob'), from: '2026-11' } })),
      'an agreement with an extra key': () => agree(bob, 'bob', next({ month: '2026-11' })),
      'past tampered': () => agree(bob, 'bob', next({ past: [{ ...previous.past[0], reward: 'Nothing' }, { ...previous.terms, at: T1 }] })),
      'past reordered': () => agree(bob, 'bob', next({ past: [{ ...previous.terms, at: T1 }, previous.past[0]] })),
      'past forgotten': () => agree(bob, 'bob', next({ past: [] })),
      'the previous one stamped with another time': () => agree(bob, 'bob', next({ past: [...previous.past, { ...previous.terms, at: ts(Date.now()) }] })),
      'the previous one without its time': () => agree(bob, 'bob', next({ past: [...previous.past, previous.terms] })),
      'the previous one changed': () => agree(bob, 'bob', next({ past: [...previous.past, { ...previous.terms, reward: 'Nothing', at: T1 }] })),
      'for another friend': () => agree(bob, 'carol', { at: serverTimestamp(), terms: termsFor(NEW, 'carol'), past: [] }),
      'touching another friend\'s too': () => updateDoc(ref(bob), { 'agreed.bob': next(), 'agreed.carol': { at: serverTimestamp(), terms: termsFor(NEW, 'carol'), past: [] } }),
      'with the terms': () => updateDoc(ref(bob), { 'agreed.bob': next(), reward: 'Nothing' }),
      'replacing every agreement': () => updateDoc(ref(bob, 'carol'), { agreed: { bob: next() } }),
      'the owner agreeing to self': () => agree(bob, 'bob', { at: serverTimestamp(), terms: termsFor(OLD, 'bob'), past: [] }, 'bob'),
      'a non-member': () => agree(db('zoe'), 'zoe', { at: serverTimestamp(), terms: termsFor(NEW, 'bob'), past: [] }),
      'a first Agree with a past': () => agree(db('carol'), 'carol', { at: serverTimestamp(), terms: termsFor(NEW, 'carol'), past: [{ ...termsFor(OLD, 'carol'), at: T1 }] }),
      'a per-friend line without my entry': () => agree(db('carol'), 'carol', {
        at: serverTimestamp(), terms: { rewardMode: 'group', penaltyMode: 'each', reward: each.reward, penalty: '', tiers: each.tiers }, past: [],
      }, 'dora'),
      'signed out': () => agree(db(), 'bob', next()),
    })
    await allowed(agree(bob, 'bob', next()))
    await allowed(agree(db('bob'), 'bob', { at: serverTimestamp(), terms: termsFor({ ...each, per: { bob: each.per.bob } }, 'bob'), past: [] }, 'dora'))
  })
})
