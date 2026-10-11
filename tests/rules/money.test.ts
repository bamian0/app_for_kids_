// users/{uid}/money/state, earnings/*, moves/* and goals/*: private to their owner (SPEC §6.3).
import { describe, test } from 'vitest'
import {
  collection, collectionGroup, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc, Timestamp, updateDoc, writeBatch,
  type DocumentData, type Firestore,
} from 'firebase/firestore'
import { allDenied, allowed, spaceDoc, useRulesEnv } from './helpers.ts'

const { db, seed } = useRulesEnv()

const PAST = Timestamp.fromMillis(Date.UTC(2026, 9, 1))
const EARLIER = Timestamp.fromMillis(Date.UTC(2026, 8, 1))
const now = () => serverTimestamp()

const stateRef = (fs: Firestore, uid = 'alice', id = 'state') => doc(fs, `users/${uid}/money/${id}`)
const state = (extra: DocumentData = {}): DocumentData => ({ currency: 'USD', baseline: null, baselineAt: null, updatedAt: now(), ...extra })

const EID = 's1_2026-10-05_t1'
const earningRef = (fs: Firestore, uid = 'alice', id = EID) => doc(fs, `users/${uid}/earnings/${id}`)
const earning = (extra: DocumentData = {}): DocumentData => ({
  spaceId: 's1', weekId: '2026-10-05', taskId: 't1', title: 'Client work', amount: 800, earnedAt: null, updatedAt: now(), ...extra,
})

const moveRef = (fs: Firestore, uid = 'alice', id = 'm1') => doc(fs, `users/${uid}/moves/${id}`)
const move = (extra: DocumentData = {}): DocumentData => ({ kind: 'spend', amount: 42.5, note: 'Rent', at: now(), ...extra })

const goalRef = (fs: Firestore, uid = 'alice', id = 'g1') => doc(fs, `users/${uid}/goals/${id}`)
const goal = (extra: DocumentData = {}): DocumentData => ({ name: 'Sony FX3', cost: 3899, order: 0, createdAt: now(), ...extra })

/** Alice's money as stored: a balance set on Oct 1, one earned task, one spend, one goal. */
const seedMoney = () =>
  seed({
    'users/alice': { name: 'Alice', color: '#636366', createdAt: PAST },
    'users/alice/money/state': { currency: 'USD', baseline: 500, baselineAt: PAST, updatedAt: PAST },
    [`users/alice/earnings/${EID}`]: { ...earning(), earnedAt: PAST, updatedAt: PAST },
    'users/alice/moves/m1': { ...move(), at: PAST },
    'users/alice/goals/g1': { ...goal(), createdAt: PAST },
  })

describe('money/state', () => {
  test('the owner sets a currency, sets the balance and changes the currency', async () => {
    const alice = db('alice')
    await allowed(setDoc(stateRef(alice), state()))
    await allowed(updateDoc(stateRef(alice), { baseline: 1250.75, baselineAt: now(), updatedAt: now() }))
    // "I have X now" again with the same X still restarts the balance.
    await allowed(updateDoc(stateRef(alice), { baseline: 1250.75, baselineAt: now(), updatedAt: now() }))
    await allowed(updateDoc(stateRef(alice), { currency: 'AMD', updatedAt: now() }))
    await allowed(updateDoc(stateRef(alice), { baseline: -200, baselineAt: now(), updatedAt: now() }))
    await allowed(getDoc(stateRef(alice)))
    await allowed(getDocs(collection(alice, 'users/alice/money')))
    await allowed(deleteDoc(stateRef(alice)))
    // Setting the balance before anything else creates the state with it.
    await allowed(setDoc(stateRef(alice), state({ currency: 'EUR', baseline: 1000000000, baselineAt: now() })))
  })

  test('invalid states are rejected', async () => {
    const ref = stateRef(db('alice'))
    await allDenied({
      'currency lowercase': () => setDoc(ref, state({ currency: 'usd' })),
      'currency 2 letters': () => setDoc(ref, state({ currency: 'US' })),
      'currency 4 letters': () => setDoc(ref, state({ currency: 'USDX' })),
      'currency a symbol': () => setDoc(ref, state({ currency: '$' })),
      'currency a number': () => setDoc(ref, state({ currency: 840 })),
      'baseline a string': () => setDoc(ref, state({ baseline: '500', baselineAt: now() })),
      'baseline over a billion': () => setDoc(ref, state({ baseline: 1000000000.01, baselineAt: now() })),
      'baseline under minus a billion': () => setDoc(ref, state({ baseline: -1000000001, baselineAt: now() })),
      'baseline NaN': () => setDoc(ref, state({ baseline: NaN, baselineAt: now() })),
      'baseline without baselineAt': () => setDoc(ref, state({ baseline: 500 })),
      'baselineAt from the client': () => setDoc(ref, state({ baseline: 500, baselineAt: Timestamp.now() })),
      'baselineAt not a timestamp': () => setDoc(ref, state({ baseline: 500, baselineAt: 'now' })),
      'client updatedAt': () => setDoc(ref, state({ updatedAt: Timestamp.now() })),
      'missing baselineAt': () => setDoc(ref, { currency: 'USD', baseline: null, updatedAt: now() }),
      'currency only': () => setDoc(ref, { currency: 'USD', updatedAt: now() }),
      'extra key': () => setDoc(ref, state({ goal: 5000 })),
      'another doc id': () => setDoc(stateRef(db('alice'), 'alice', 'other'), state()),
    })
  })

  test('a new baseline always comes with the server time', async () => {
    await seedMoney()
    const ref = stateRef(db('alice'))
    await allDenied({
      'baseline changed alone': () => updateDoc(ref, { baseline: 600, updatedAt: now() }),
      'baseline changed with an old time': () => updateDoc(ref, { baseline: 600, baselineAt: EARLIER, updatedAt: now() }),
      'baselineAt moved back': () => updateDoc(ref, { baselineAt: EARLIER, updatedAt: now() }),
      'baselineAt cleared': () => updateDoc(ref, { baselineAt: null, updatedAt: now() }),
      'baseline cleared alone': () => updateDoc(ref, { baseline: null, updatedAt: now() }),
      'updatedAt not refreshed': () => updateDoc(ref, { currency: 'EUR' }),
    })
    await allowed(updateDoc(ref, { currency: 'EUR', updatedAt: now() }))
  })
})

describe('earnings', () => {
  test('the owner switches a task to revenue, edits the amount, earns it and switches it off', async () => {
    const alice = db('alice')
    const ref = earningRef(alice)
    await allowed(setDoc(ref, earning({ amount: 0 })))
    await allowed(setDoc(ref, earning({ amount: 950.5 })))
    await allowed(updateDoc(ref, { earnedAt: now(), updatedAt: now() }))
    await allowed(updateDoc(ref, { amount: 1000000000, updatedAt: now() }))
    await allowed(updateDoc(ref, { title: 'Client work (final)', updatedAt: now() }))
    await allowed(updateDoc(ref, { earnedAt: null, updatedAt: now() }))
    await allowed(getDoc(ref))
    await allowed(getDocs(collection(alice, 'users/alice/earnings')))
    await allowed(deleteDoc(ref))
    // A task that is already done is earned the moment it is switched on.
    await allowed(setDoc(earningRef(alice, 'alice', 'space-2_2026-10-12_k_9-x'), earning({
      spaceId: 'space-2', weekId: '2026-10-12', taskId: 'k_9-x', earnedAt: now(),
    })))
  })

  test('an earned task keeps its earnedAt when the amount changes', async () => {
    await seedMoney()
    const ref = earningRef(db('alice'))
    await allowed(setDoc(ref, earning({ amount: 750, earnedAt: PAST })))
    await allDenied({
      'earnedAt moved back': () => updateDoc(ref, { earnedAt: EARLIER, updatedAt: now() }),
      'earnedAt from the client': () => updateDoc(ref, { earnedAt: Timestamp.now(), updatedAt: now() }),
      'updatedAt not refreshed': () => updateDoc(ref, { amount: 10 }),
    })
  })

  test('invalid earnings are rejected', async () => {
    const alice = db('alice')
    const ref = earningRef(alice)
    await allDenied({
      'id of another task': () => setDoc(earningRef(alice, 'alice', 's1_2026-10-05_t2'), earning()),
      'id of another week': () => setDoc(earningRef(alice, 'alice', 's1_2026-10-12_t1'), earning()),
      'id without the space': () => setDoc(earningRef(alice, 'alice', '2026-10-05_t1'), earning()),
      'weekId not a date': () => setDoc(earningRef(alice, 'alice', 's1_W_t1'), earning({ weekId: 'W' })),
      'weekId short': () => setDoc(earningRef(alice, 'alice', 's1_2026-10-5_t1'), earning({ weekId: '2026-10-5' })),
      'weekId a number': () => setDoc(ref, earning({ weekId: 20261005 })),
      'taskId with a dot': () => setDoc(earningRef(alice, 'alice', 's1_2026-10-05_t.1'), earning({ taskId: 't.1' })),
      'taskId empty': () => setDoc(earningRef(alice, 'alice', 's1_2026-10-05_'), earning({ taskId: '' })),
      'spaceId empty': () => setDoc(earningRef(alice, 'alice', '_2026-10-05_t1'), earning({ spaceId: '' })),
      'spaceId a number': () => setDoc(ref, earning({ spaceId: 1 })),
      'title empty': () => setDoc(ref, earning({ title: '' })),
      'title 121 chars': () => setDoc(ref, earning({ title: 'x'.repeat(121) })),
      'title a number': () => setDoc(ref, earning({ title: 7 })),
      'amount negative': () => setDoc(ref, earning({ amount: -1 })),
      'amount over a billion': () => setDoc(ref, earning({ amount: 1000000000.5 })),
      'amount a string': () => setDoc(ref, earning({ amount: '800' })),
      'amount null': () => setDoc(ref, earning({ amount: null })),
      'earnedAt from the client': () => setDoc(ref, earning({ earnedAt: Timestamp.now() })),
      'earnedAt a bool': () => setDoc(ref, earning({ earnedAt: true })),
      'client updatedAt': () => setDoc(ref, earning({ updatedAt: Timestamp.now() })),
      'extra key': () => setDoc(ref, earning({ client: 'Nike' })),
      'missing amount': () => { const { amount: _, ...rest } = earning(); return setDoc(ref, rest) },
    })
  })
})

describe('moves', () => {
  test('the owner adds and spends money and undoes a move', async () => {
    const alice = db('alice')
    await allowed(setDoc(moveRef(alice, 'alice', 'm1'), move({ kind: 'add', amount: 1000, note: '' })))
    await allowed(setDoc(moveRef(alice, 'alice', 'm2'), move({ amount: 0.01, note: 'x'.repeat(80) })))
    await allowed(setDoc(moveRef(alice, 'alice', 'm3'), move({ amount: 1000000000 })))
    await allowed(getDoc(moveRef(alice, 'alice', 'm1')))
    await allowed(getDocs(collection(alice, 'users/alice/moves')))
    await allowed(deleteDoc(moveRef(alice, 'alice', 'm1')))
  })

  test('a move is never edited', async () => {
    await seedMoney()
    const ref = moveRef(db('alice'))
    await allDenied({
      'update': () => updateDoc(ref, { note: 'Rent for October' }),
      'update to the same': () => updateDoc(ref, { amount: 42.5 }),
      'overwrite': () => setDoc(ref, move({ amount: 4.25 })),
    })
  })

  test('invalid moves are rejected', async () => {
    const ref = moveRef(db('alice'), 'alice', 'new')
    await allDenied({
      'kind other': () => setDoc(ref, move({ kind: 'withdraw' })),
      'kind missing': () => { const { kind: _, ...rest } = move(); return setDoc(ref, rest) },
      'amount zero': () => setDoc(ref, move({ amount: 0 })),
      'amount negative': () => setDoc(ref, move({ amount: -42.5 })),
      'amount over a billion': () => setDoc(ref, move({ amount: 1000000001 })),
      'amount a string': () => setDoc(ref, move({ amount: '42.50' })),
      'note 81 chars': () => setDoc(ref, move({ note: 'x'.repeat(81) })),
      'note a number': () => setDoc(ref, move({ note: 7 })),
      'note missing': () => { const { note: _, ...rest } = move(); return setDoc(ref, rest) },
      'at from the client': () => setDoc(ref, move({ at: Timestamp.now() })),
      'extra key': () => setDoc(ref, move({ goalId: 'g1' })),
    })
  })
})

describe('goals', () => {
  test('the owner adds, edits, reorders, buys and deletes goals', async () => {
    const alice = db('alice')
    await allowed(setDoc(goalRef(alice, 'alice', 'g1'), goal()))
    await allowed(setDoc(goalRef(alice, 'alice', 'g2'), goal({ name: 'Ж'.repeat(60), cost: 0.01, order: 1 })))
    await allowed(updateDoc(goalRef(alice, 'alice', 'g1'), { name: 'Sony FX3 kit', cost: 4299.99 }))
    const reorder = writeBatch(alice)
    reorder.update(goalRef(alice, 'alice', 'g1'), { order: 1 })
    reorder.update(goalRef(alice, 'alice', 'g2'), { order: 0 })
    await allowed(reorder.commit())
    await allowed(getDoc(goalRef(alice, 'alice', 'g1')))
    await allowed(getDocs(collection(alice, 'users/alice/goals')))
    // Mark as Bought: the cost goes out as a spend and the goal goes away, in one batch.
    const bought = writeBatch(alice)
    bought.set(moveRef(alice, 'alice', 'm9'), move({ amount: 4299.99, note: 'Sony FX3 kit' }))
    bought.delete(goalRef(alice, 'alice', 'g1'))
    await allowed(bought.commit())
    await allowed(deleteDoc(goalRef(alice, 'alice', 'g2')))
  })

  test('invalid goals are rejected', async () => {
    await seedMoney()
    const ref = goalRef(db('alice'), 'alice', 'new')
    const stored = goalRef(db('alice'))
    await allDenied({
      'name empty': () => setDoc(ref, goal({ name: '' })),
      'name blank': () => setDoc(ref, goal({ name: '   ' })),
      'name 61 chars': () => setDoc(ref, goal({ name: 'x'.repeat(61) })),
      'name a number': () => setDoc(ref, goal({ name: 3 })),
      'cost zero': () => setDoc(ref, goal({ cost: 0 })),
      'cost negative': () => setDoc(ref, goal({ cost: -3899 })),
      'cost over a billion': () => setDoc(ref, goal({ cost: 1000000000.01 })),
      'cost a string': () => setDoc(ref, goal({ cost: '3899' })),
      'order over a million': () => setDoc(ref, goal({ order: 1000001 })),
      'order under minus a million': () => setDoc(ref, goal({ order: -1000001 })),
      'order a string': () => setDoc(ref, goal({ order: '1' })),
      'order missing': () => { const { order: _, ...rest } = goal(); return setDoc(ref, rest) },
      'createdAt from the client': () => setDoc(ref, goal({ createdAt: Timestamp.now() })),
      'extra key': () => setDoc(ref, goal({ saved: 100 })),
      'createdAt changed': () => updateDoc(stored, { createdAt: now() }),
      'overwritten as new': () => setDoc(stored, goal()),
      'edited to a blank name': () => updateDoc(stored, { name: ' ' }),
    })
  })
})

describe('money privacy', () => {
  test('a friend in the same space and a signed-out user can\'t read or write any of it', async () => {
    await seedMoney()
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob']) })
    // The profile itself is still visible to friends (rules don't cascade to subcollections).
    await allowed(getDoc(doc(db('bob'), 'users/alice')))
    for (const [who, fs] of [['bob', db('bob')], ['signed out', db()]] as const) {
      await allDenied({
        [`${who}: get state`]: () => getDoc(stateRef(fs)),
        [`${who}: list money`]: () => getDocs(collection(fs, 'users/alice/money')),
        [`${who}: create state`]: () => setDoc(stateRef(fs), state()),
        [`${who}: update state`]: () => updateDoc(stateRef(fs), { currency: 'EUR', updatedAt: now() }),
        [`${who}: delete state`]: () => deleteDoc(stateRef(fs)),
        [`${who}: get earning`]: () => getDoc(earningRef(fs)),
        [`${who}: list earnings`]: () => getDocs(collection(fs, 'users/alice/earnings')),
        [`${who}: create earning`]: () => setDoc(earningRef(fs, 'alice', 's1_2026-10-05_t9'), earning({ taskId: 't9' })),
        [`${who}: update earning`]: () => updateDoc(earningRef(fs), { amount: 1, updatedAt: now() }),
        [`${who}: delete earning`]: () => deleteDoc(earningRef(fs)),
        [`${who}: get move`]: () => getDoc(moveRef(fs)),
        [`${who}: list moves`]: () => getDocs(collection(fs, 'users/alice/moves')),
        [`${who}: create move`]: () => setDoc(moveRef(fs, 'alice', 'm2'), move()),
        [`${who}: delete move`]: () => deleteDoc(moveRef(fs)),
        [`${who}: get goal`]: () => getDoc(goalRef(fs)),
        [`${who}: list goals`]: () => getDocs(collection(fs, 'users/alice/goals')),
        [`${who}: create goal`]: () => setDoc(goalRef(fs, 'alice', 'g2'), goal()),
        [`${who}: update goal`]: () => updateDoc(goalRef(fs), { cost: 1 }),
        [`${who}: delete goal`]: () => deleteDoc(goalRef(fs)),
      })
    }
    const bob = db('bob')
    await allDenied({
      'earnings of everyone': () => getDocs(collectionGroup(bob, 'earnings')),
      'moves of everyone': () => getDocs(collectionGroup(bob, 'moves')),
      'goals of everyone': () => getDocs(collectionGroup(bob, 'goals')),
      'money of everyone': () => getDocs(collectionGroup(bob, 'money')),
    })
  })
})
