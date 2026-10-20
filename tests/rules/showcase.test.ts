// showcases/{uid}, scores/{uid}, rings/{uid}, stats/{uid} (SPEC §11.3–§11.5): the showcase holds only copies of what
// its owner switched on and anyone signed in reads it; scores, rings and stats are the reminders job's (admin), read
// by nobody, by friends, and per the showcase's stats switch.
import { describe, test } from 'vitest'
import {
  collection, deleteDoc, deleteField, doc, getDoc, getDocs, serverTimestamp, setDoc, Timestamp, updateDoc, writeBatch,
  type DocumentData, type Firestore,
} from 'firebase/firestore'
import { allDenied, allowed, DAY, denied, HOUR, ts, useRulesEnv } from './helpers.ts'

const { db, seed } = useRulesEnv()

const now = () => serverTimestamp()
type Show = { stats: boolean; achieved: boolean; goals: boolean; earnings: boolean }
const DEFAULT_SHOW: Show = { stats: true, achieved: false, goals: false, earnings: false }
const ALL_ON: Show = { stats: true, achieved: true, goals: true, earnings: true }

const showRef = (fs: Firestore, uid = 'alice') => doc(fs, `showcases/${uid}`)
/** 12 goals marked Bought, newest first, 60-character names. */
const achieved12 = Array.from({ length: 12 }, (_, i) => ({ name: `${'Ж'.repeat(57)}${String(i).padStart(3, '0')}`, at: ts(Date.now() - (i + 1) * DAY) }))
/** 8 goals in saving order, 60-character names. */
const goals8 = Array.from({ length: 8 }, (_, i) => ({ name: `${'G'.repeat(59)}${i}`, pct: i * 14 }))
const earnings = { monthId: '2026-09', amount: 4200.5, currency: 'USD' }
/** What setShowcaseSwitch writes: the switches, exactly the switched-on items, the server time. */
const showcase = (show: Show, extra: DocumentData = {}): DocumentData => ({
  show,
  ...(show.achieved ? { achieved: achieved12 } : {}),
  ...(show.goals ? { goals: goals8 } : {}),
  ...(show.earnings ? { earnings } : {}),
  updatedAt: now(),
  ...extra,
})
/** A stored showcase (seeded). */
const stored = (show: Show, extra: DocumentData = {}): DocumentData => ({ ...showcase(show, extra), updatedAt: ts(Date.now() - DAY) })

describe('showcases', () => {
  test('the owner writes every switch combination with exactly its items; anyone signed in reads it', async () => {
    const alice = db('alice')
    await allowed(setDoc(showRef(alice), showcase(DEFAULT_SHOW)))
    await allowed(setDoc(showRef(alice), showcase(ALL_ON)))
    await allowed(setDoc(showRef(alice), showcase({ stats: false, achieved: false, goals: false, earnings: false })))
    await allowed(setDoc(showRef(alice), showcase({ stats: false, achieved: false, goals: true, earnings: false })))
    await allowed(setDoc(showRef(alice), showcase({ stats: true, achieved: true, goals: false, earnings: true })))
    // Empty lists, 0 earned, 0% and 100%: all fine.
    await allowed(setDoc(showRef(alice), showcase(ALL_ON, { achieved: [], goals: [{ name: 'Car', pct: 0 }, { name: 'Bike', pct: 100 }], earnings: { ...earnings, amount: 0 } })))
    await allowed(getDoc(showRef(db('bob'))))
    await allowed(getDoc(showRef(db('bob'), 'nobody')))
    await denied(getDoc(showRef(db())))
    await denied(getDocs(collection(db('bob'), 'showcases')))
  })

  test('the background sync updates switched-on items alone', async () => {
    await seed({ 'showcases/alice': stored(ALL_ON) })
    const alice = db('alice')
    await allowed(updateDoc(showRef(alice), { earnings: { ...earnings, amount: 99 }, updatedAt: now() }))
    await allowed(updateDoc(showRef(alice), { goals: goals8.slice(0, 3), achieved: achieved12.slice(1), updatedAt: now() }))
  })

  test('account deletion switches everything off in one write, then deletes the doc', async () => {
    await seed({ 'showcases/alice': stored(ALL_ON) })
    const alice = db('alice')
    await allowed(setDoc(showRef(alice), { show: { stats: false, achieved: false, goals: false, earnings: false }, updatedAt: now() }))
    await allowed(deleteDoc(showRef(alice)))
  })

  test('a stale device can\'t bring back an item whose switch is now off', async () => {
    await seed({ 'showcases/alice': stored({ stats: true, achieved: true, goals: false, earnings: false }) })
    const alice = db('alice')
    await allDenied({
      'an item-only update that adds an item whose stored switch is off (earnings)': () => updateDoc(showRef(alice), { earnings, updatedAt: now() }),
      'an item-only update that adds an item whose stored switch is off (goals)': () => updateDoc(showRef(alice), { goals: goals8, updatedAt: now() }),
      'an update that removes a switched-on item': () => updateDoc(showRef(alice), { achieved: deleteField(), updatedAt: now() }),
      'an item update without the server time': () => updateDoc(showRef(alice), { achieved: achieved12.slice(2) }),
    })
  })

  test('showcases holding more, or other, than the switches allow are refused', async () => {
    const alice = db('alice')
    const on = (key: keyof Show): Show => ({ ...DEFAULT_SHOW, [key]: true })
    const name61 = 'N'.repeat(61)
    await allDenied({
      'a showcase with an item whose switch is off (achieved)': () => setDoc(showRef(alice), { ...showcase(DEFAULT_SHOW), achieved: achieved12 }),
      'a showcase with an item whose switch is off (goals)': () => setDoc(showRef(alice), { ...showcase(DEFAULT_SHOW), goals: goals8 }),
      'a showcase with an item whose switch is off (earnings)': () => setDoc(showRef(alice), { ...showcase(DEFAULT_SHOW), earnings }),
      'a switched-on item missing (achieved)': () => setDoc(showRef(alice), { show: on('achieved'), updatedAt: now() }),
      'a switched-on item missing (goals)': () => setDoc(showRef(alice), { show: on('goals'), updatedAt: now() }),
      'a switched-on item missing (earnings)': () => setDoc(showRef(alice), { show: on('earnings'), updatedAt: now() }),
      '13 achieved goals': () => setDoc(showRef(alice), showcase(on('achieved'), { achieved: [...achieved12, achieved12[0]] })),
      '9 shown goals': () => setDoc(showRef(alice), showcase(on('goals'), { goals: [...goals8, goals8[0]] })),
      'pct 101': () => setDoc(showRef(alice), showcase(on('goals'), { goals: [{ name: 'Car', pct: 101 }] })),
      'pct 1.5': () => setDoc(showRef(alice), showcase(on('goals'), { goals: [{ name: 'Car', pct: 1.5 }] })),
      'pct -1': () => setDoc(showRef(alice), showcase(on('goals'), { goals: [{ name: 'Car', pct: -1 }] })),
      'a goal with its amount': () => setDoc(showRef(alice), showcase(on('goals'), { goals: [{ name: 'Car', pct: 10, cost: 3899 }] })),
      'a 61-character goal name': () => setDoc(showRef(alice), showcase(on('goals'), { goals: [{ name: name61, pct: 10 }] })),
      'a 61-character achieved name': () => setDoc(showRef(alice), showcase(on('achieved'), { achieved: [{ name: name61, at: ts(Date.now() - DAY) }] })),
      'a blank achieved name': () => setDoc(showRef(alice), showcase(on('achieved'), { achieved: [{ name: '   ', at: ts(Date.now() - DAY) }] })),
      'an empty goal name': () => setDoc(showRef(alice), showcase(on('goals'), { goals: [{ name: '', pct: 10 }] })),
      'an achieved goal from the future': () => setDoc(showRef(alice), showcase(on('achieved'), { achieved: [{ name: 'Car', at: ts(Date.now() + HOUR) }] })),
      'an achieved time that isn\'t a timestamp': () => setDoc(showRef(alice), showcase(on('achieved'), { achieved: [{ name: 'Car', at: Date.now() }] })),
      'an achieved item with an extra key': () => setDoc(showRef(alice), showcase(on('achieved'), { achieved: [{ name: 'Car', at: ts(Date.now() - DAY), cost: 1 }] })),
      'achieved not a list': () => setDoc(showRef(alice), showcase(on('achieved'), { achieved: { 0: { name: 'Car', at: ts(Date.now() - DAY) } } })),
      'a lowercase currency': () => setDoc(showRef(alice), showcase(on('earnings'), { earnings: { ...earnings, currency: 'usd' } })),
      'earnings over a billion': () => setDoc(showRef(alice), showcase(on('earnings'), { earnings: { ...earnings, amount: 1000000000.01 } })),
      'negative earnings': () => setDoc(showRef(alice), showcase(on('earnings'), { earnings: { ...earnings, amount: -1 } })),
      'earnings of month 13': () => setDoc(showRef(alice), showcase(on('earnings'), { earnings: { ...earnings, monthId: '2026-13' } })),
      'earnings with an extra key': () => setDoc(showRef(alice), showcase(on('earnings'), { earnings: { ...earnings, balance: 5 } })),
      'earnings without a currency': () => setDoc(showRef(alice), showcase(on('earnings'), { earnings: { monthId: '2026-09', amount: 5 } })),
      'a switch that isn\'t a bool': () => setDoc(showRef(alice), showcase({ ...DEFAULT_SHOW, stats: 'yes' as unknown as boolean })),
      'a fifth switch': () => setDoc(showRef(alice), showcase(DEFAULT_SHOW, { show: { ...DEFAULT_SHOW, balance: false } })),
      'a missing switch': () => setDoc(showRef(alice), { show: { stats: true, achieved: false, goals: false }, updatedAt: now() }),
      'no switches': () => setDoc(showRef(alice), { updatedAt: now() }),
      'an extra key': () => setDoc(showRef(alice), showcase(DEFAULT_SHOW, { balance: 500 })),
      'a client time': () => setDoc(showRef(alice), showcase(DEFAULT_SHOW, { updatedAt: Timestamp.now() })),
      'another user\'s showcase': () => setDoc(showRef(alice, 'bob'), showcase(DEFAULT_SHOW)),
      'deleting another user\'s showcase': () => deleteDoc(showRef(alice, 'bob')),
      'signed out': () => setDoc(showRef(db(), 'alice'), showcase(DEFAULT_SHOW)),
    })
  })
})

describe('scores, rings and stats', () => {
  const ring = { monthId: '2026-10', score: 92.5, final: false, spaces: 2, updatedAt: ts(Date.now() - HOUR) }
  const stats = { monthsCleared: 1, currentStreak: 1, bestStreak: 1, weeksPlayed: 7, finishedMonths: 1, since: '2026-10', updatedAt: ts(Date.now() - HOUR) }
  const scores = { months: { '2026-10': { s1: { score: 92.5, weeks: ['2026-10-05'], final: false } } }, updatedAt: ts(Date.now() - HOUR) }
  const pair = (by: string, state: string, users = ['alice', 'bob']) => ({ users, by, state, at: ts(Date.now() - DAY) })
  const seedAll = (extra: Record<string, DocumentData> = {}) => seed({
    'users/alice': { name: 'Alice', color: '#636366', createdAt: ts(Date.now() - 90 * DAY) },
    'scores/alice': scores, 'rings/alice': ring, 'stats/alice': stats,
    ...extra,
  })

  test('scores: nobody reads them, not even their owner; only the owner deletes them; no client writes', async () => {
    await seedAll()
    const alice = db('alice')
    await allDenied({
      'any client read of scores (owner)': () => getDoc(doc(alice, 'scores/alice')),
      'any client read of scores (someone else)': () => getDoc(doc(db('bob'), 'scores/alice')),
      'any client list of scores': () => getDocs(collection(alice, 'scores')),
      'a client write to scores (create)': () => setDoc(doc(alice, 'scores/bob'), scores),
      'a client write to scores (update)': () => updateDoc(doc(alice, 'scores/alice'), { updatedAt: now() }),
      'someone else deleting scores': () => deleteDoc(doc(db('bob'), 'scores/alice')),
    })
    await allowed(deleteDoc(doc(alice, 'scores/alice')))
  })

  test('rings: the owner and their friends read them; pending pairs and strangers don\'t', async () => {
    await seedAll({
      'friends/alice_bob': pair('alice', 'friends'),
      'friends/alice_cleo': pair('alice', 'asked', ['alice', 'cleo']),
      'friends/alice_dan': pair('dan', 'declined', ['alice', 'dan']),
      'friends/alice_eve': pair('alice', 'withdrawn', ['alice', 'eve']),
    })
    await allowed(getDoc(doc(db('alice'), 'rings/alice')))
    await allowed(getDoc(doc(db('bob'), 'rings/alice')))
    // The friendship goes both ways.
    await seed({ 'rings/bob': { ...ring, score: 40 } })
    await allowed(getDoc(doc(db('alice'), 'rings/bob')))
    await allDenied({
      'a stranger reading a ring': () => getDoc(doc(db('zed'), 'rings/alice')),
      'an asked pair reading a ring': () => getDoc(doc(db('cleo'), 'rings/alice')),
      'a declined pair reading a ring': () => getDoc(doc(db('dan'), 'rings/alice')),
      'a withdrawn pair reading a ring': () => getDoc(doc(db('eve'), 'rings/alice')),
      'signed out': () => getDoc(doc(db(), 'rings/alice')),
      'listing rings': () => getDocs(collection(db('bob'), 'rings')),
      'a client write to rings (owner)': () => setDoc(doc(db('alice'), 'rings/alice'), { ...ring, score: 100 }),
      'a client create of rings': () => setDoc(doc(db('bob'), 'rings/bob'), ring),
      'a friend deleting a ring': () => deleteDoc(doc(db('bob'), 'rings/alice')),
    })
    await allowed(deleteDoc(doc(db('alice'), 'rings/alice')))
  })

  test('stats: readable by anyone signed in with no showcase doc, or with stats shown', async () => {
    await seedAll()
    await allowed(getDoc(doc(db('zed'), 'stats/alice')))
    await seed({ 'showcases/alice': stored(DEFAULT_SHOW) })
    await allowed(getDoc(doc(db('zed'), 'stats/alice')))
    await denied(getDoc(doc(db(), 'stats/alice')))
  })

  test('stats: refused with show.stats == false, to friends too; the owner still reads them', async () => {
    await seedAll({ 'friends/alice_bob': pair('alice', 'friends'), 'showcases/alice': stored({ ...ALL_ON, stats: false }) })
    await allowed(getDoc(doc(db('alice'), 'stats/alice')))
    await allDenied({
      'reading stats with show.stats == false (a stranger)': () => getDoc(doc(db('zed'), 'stats/alice')),
      'reading stats with show.stats == false (a friend)': () => getDoc(doc(db('bob'), 'stats/alice')),
      'listing stats': () => getDocs(collection(db('alice'), 'stats')),
      'a client write to stats (owner)': () => setDoc(doc(db('alice'), 'stats/alice'), { ...stats, monthsCleared: 99 }),
      'a client update of stats': () => updateDoc(doc(db('alice'), 'stats/alice'), { monthsCleared: 99 }),
      'someone else deleting stats': () => deleteDoc(doc(db('bob'), 'stats/alice')),
    })
    await allowed(deleteDoc(doc(db('alice'), 'stats/alice')))
  })

  test('account deletion: showcase off first hides stats; the owner deletes all three in one batch', async () => {
    await seedAll({ 'showcases/alice': stored(ALL_ON) })
    const alice = db('alice')
    await allowed(setDoc(showRef(alice), { show: { stats: false, achieved: false, goals: false, earnings: false }, updatedAt: now() }))
    await denied(getDoc(doc(db('zed'), 'stats/alice')))
    const b = writeBatch(alice)
    for (const c of ['rings', 'stats', 'scores']) b.delete(doc(alice, `${c}/alice`))
    await allowed(b.commit())
  })
})
