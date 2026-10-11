// Money (SPEC §6.3): balance, currency, moves, goals and their privacy, against the emulators and the
// real rules, through the same functions the screens call.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { collection, doc, getDoc, getDocs } from 'firebase/firestore'
import {
  addMove,
  deleteGoal,
  deleteMove,
  deleteMyAccount,
  markGoalBought,
  reorderGoals,
  saveGoal,
  setBaseline,
  setCurrency,
  setTaskRevenue,
  signIn,
} from '../../src/data/api.ts'
import { moneyKeys, startEarnings, startGoals, startMoneyState, startMoves } from '../../src/data/money.ts'
import { forget, peek, watch } from '../../src/data/store.ts'
import { balanceOf, defaultCurrency, earningId } from '../../src/domain/money.ts'
import type { Earning, Goal, MoneyMove, MoneyState, Space } from '../../src/domain/types.ts'
import { getFirebase } from '../../src/firebase/app.ts'
import { adminGet, adminList, as, createUser, eventually, observe, PASSWORD, rejectsWith, setupEmulators, teardownEmulators, type TestUser } from './helpers.ts'

const GENERIC = 'Something went wrong. Try again.'
const NO_ACCESS = "You don't have access to this."

let alex: TestUser
let sam: TestUser
/** Earnings only need the space's id: they are the user's own bookkeeping. */
const space = { id: 'space1' } as Space
const W = '2026-10-05'

beforeAll(async () => {
  await setupEmulators()
  alex = await createUser('Alex')
  sam = await createUser('Sam')
})
afterAll(teardownEmulators)

const recent = (ms: number | null | undefined) => typeof ms === 'number' && Math.abs(ms - Date.now()) < 60_000

describe('balance and currency', () => {
  it('starts empty, then keeps the currency and the balance apart', async () => {
    await as(alex)
    const live = observe(startMoneyState(alex.uid))
    expect((await live.until((l) => !l.loading)).data).toBeNull()

    await setCurrency('eur')
    expect((await live.until((l) => l.data?.currency === 'EUR')).data).toMatchObject({ baseline: null, baselineAt: null })

    await setBaseline(1250.505)
    let state = (await live.until((l) => l.data?.baseline === 1250.51 && recent(l.data.baselineAt))).data!
    expect(state.currency).toBe('EUR')
    const baselineAt = (await adminGet(`users/${alex.uid}/money/state`))?.baselineAt.toMillis()

    // Changing the currency relabels; the balance and when it was set stay.
    await setCurrency('AMD')
    state = (await live.until((l) => l.data?.currency === 'AMD')).data!
    expect(state).toMatchObject({ baseline: 1250.51, baselineAt })

    await setBaseline(-20)
    await live.until((l) => l.data?.baseline === -20)
    live.stop()
  })

  it('setting a balance first creates the state in the device’s currency', async () => {
    await as(sam)
    await setBaseline(100)
    expect(await adminGet(`users/${sam.uid}/money/state`)).toMatchObject({ currency: defaultCurrency(), baseline: 100 })
  })

  it('refuses what the rules would', async () => {
    await as(alex)
    await rejectsWith(setCurrency('dollars'), GENERIC)
    await rejectsWith(setBaseline(Number.NaN), 'Enter an amount.')
    await rejectsWith(setBaseline(2_000_000_000), 'That amount is too large.')
  })
})

describe('moves', () => {
  it('adds and spends, newest first, and undoes by deleting', async () => {
    await as(alex)
    const live = observe(startMoves(alex.uid))
    await live.until((l) => l.data?.length === 0)
    await addMove('add', 500, '  Gig  ')
    await addMove('spend', 120.456, 'Rent')
    // Newest first, also while the second is still on its way.
    const moves = (await live.until((l) => l.data?.length === 2)).data!
    expect(moves.map(({ kind, amount, note }) => ({ kind, amount, note }))).toEqual([
      { kind: 'spend', amount: 120.46, note: 'Rent' },
      { kind: 'add', amount: 500, note: 'Gig' },
    ])
    expect(moves.every((m) => recent(m.at))).toBe(true)

    await deleteMove(moves[0].id)
    expect((await live.until((l) => l.data?.length === 1)).data?.[0].note).toBe('Gig')
    live.stop()
  })

  it('checks amounts and notes', async () => {
    await as(alex)
    await rejectsWith(addMove('spend', 0, ''), 'Enter an amount greater than 0.')
    await rejectsWith(addMove('spend', 0.001, ''), 'Enter an amount greater than 0.')
    await rejectsWith(addMove('add', 1_000_000_001, ''), 'That amount is too large.')
    await rejectsWith(addMove('add', 5, 'x'.repeat(81)), 'Keep the note under 80 characters.')
  })
})

describe('goals', () => {
  it('adds goals at the bottom, edits, reorders and deletes them', async () => {
    await as(alex)
    const live = observe(startGoals(alex.uid))
    await live.until((l) => l.data?.length === 0)
    const camera = await saveGoal({ name: ' Sony FX3 ', cost: 4500 })
    const lens = await saveGoal({ name: 'Lens', cost: 1200.5 })
    let goals = (await live.until((l) => l.data?.length === 2)).data!
    expect(goals.map(({ id, name, cost, order }) => ({ id, name, cost, order }))).toEqual([
      { id: camera, name: 'Sony FX3', cost: 4500, order: 0 },
      { id: lens, name: 'Lens', cost: 1200.5, order: 1 },
    ])
    const createdAt = goals[0].createdAt
    expect(recent(createdAt)).toBe(true)

    await reorderGoals([lens, camera])
    goals = (await live.until((l) => l.data?.[0]?.id === lens)).data!
    expect(goals.map((g) => g.order)).toEqual([0, 1])

    expect(await saveGoal({ id: camera, name: 'Sony FX3 kit', cost: 5000 })).toBe(camera)
    goals = (await live.until((l) => l.data?.some((g) => g.name === 'Sony FX3 kit') === true)).data!
    expect(goals.find((g) => g.id === camera)).toMatchObject({ cost: 5000, order: 1, createdAt })

    // A third goal goes after the others, wherever they were moved.
    const trip = await saveGoal({ name: 'Trip', cost: 900 })
    expect((await live.until((l) => l.data?.length === 3)).data?.at(-1)).toMatchObject({ id: trip, order: 2 })
    await deleteGoal(trip)
    await live.until((l) => l.data?.length === 2)
    live.stop()
  })

  it('marking a goal bought spends its cost and removes it, in one go', async () => {
    await as(alex)
    const goals = observe(startGoals(alex.uid))
    const lens = (await goals.until((l) => l.data?.length === 2)).data!.find((g) => g.name === 'Lens') as Goal
    goals.stop()
    const before = await adminList(`users/${alex.uid}/moves`)
    await markGoalBought(lens)
    expect(await adminGet(`users/${alex.uid}/goals/${lens.id}`)).toBeUndefined()
    const added = (await adminList(`users/${alex.uid}/moves`)).filter((id) => !before.includes(id))
    expect(added).toHaveLength(1)
    expect(await adminGet(`users/${alex.uid}/moves/${added[0]}`)).toMatchObject({ kind: 'spend', amount: 1200.5, note: 'Lens' })
  })

  it('checks names and costs', async () => {
    await as(alex)
    await rejectsWith(saveGoal({ name: '  ', cost: 5 }), 'Give the goal a name.')
    await rejectsWith(saveGoal({ name: 'x'.repeat(61), cost: 5 }), 'Keep the name under 60 characters.')
    await rejectsWith(saveGoal({ name: 'Free', cost: 0 }), 'Enter an amount greater than 0.')
    await rejectsWith(saveGoal({ id: 'gone', name: 'Gone', cost: 5 }), 'This no longer exists.')
  })
})

describe('everything together', () => {
  it('the live lists add up to a balance', async () => {
    await as(alex)
    await setTaskRevenue(space, W, { id: 't1', title: 'Client work' }, 800, true)
    await setTaskRevenue(space, W, { id: 't2', title: 'Pitch' }, 300, false)
    const keys = [moneyKeys.state(alex.uid), moneyKeys.earnings(alex.uid), moneyKeys.moves(alex.uid)]
    const releases = [
      watch(keys[0], startMoneyState(alex.uid), () => {}),
      watch(keys[1], startEarnings(alex.uid), () => {}),
      watch(keys[2], startMoves(alex.uid), () => {}),
    ]
    try {
      await eventually(() => keys.every((key) => peek(key).data !== undefined) && (peek<unknown[]>(keys[1]).data?.length ?? 0) === 2)
      const earnings = peek<Earning[]>(keys[1]).data!
      expect(earnings.find((e) => e.taskId === 't1')).toMatchObject({ id: earningId(space.id, W, 't1'), title: 'Client work', amount: 800, weekId: W })
      expect(recent(earnings.find((e) => e.taskId === 't1')?.earnedAt)).toBe(true)
      expect(earnings.find((e) => e.taskId === 't2')?.earnedAt).toBeNull()
      // The balance was set to −20 before the moves and the earning: −20 + 500 (Gig) − 1,200.50 (Lens) + 800.
      const balance = balanceOf(peek<MoneyState | null>(keys[0]).data ?? null, earnings, peek<MoneyMove[]>(keys[2]).data!)
      expect(balance).toBe(79.5)
    } finally {
      releases.forEach((release) => release())
      keys.forEach(forget)
    }
  })
})

describe('privacy', () => {
  it('nobody else can read your money', async () => {
    await as(sam)
    const { db } = getFirebase()
    await expect(getDoc(doc(db, 'users', alex.uid, 'money', 'state'))).rejects.toMatchObject({ code: 'permission-denied' })
    for (const name of ['earnings', 'moves', 'goals']) {
      await expect(getDocs(collection(db, 'users', alex.uid, name))).rejects.toMatchObject({ code: 'permission-denied' })
    }
    const live = observe(startEarnings(alex.uid))
    expect((await live.until((l) => l.error !== null)).error?.message).toBe(NO_ACCESS)
    live.stop()
  })
})

describe('account deletion', () => {
  it('deletes the balance, earnings, moves and goals', async () => {
    const zoe = await createUser('Zoe')
    await setCurrency('GBP')
    await setBaseline(10)
    await setTaskRevenue(space, W, { id: 't1', title: 'Client work' }, 800, true)
    await addMove('add', 5, '')
    await saveGoal({ name: 'Bike', cost: 300 })
    const paths = ['money', 'earnings', 'moves', 'goals'].map((name) => `users/${zoe.uid}/${name}`)
    for (const path of paths) expect(await adminList(path)).toHaveLength(1)
    await deleteMyAccount(PASSWORD)
    for (const path of paths) expect(await adminList(path)).toEqual([])
    expect(await adminGet(`users/${zoe.uid}`)).toBeUndefined()
    await rejectsWith(signIn(zoe.email, PASSWORD), 'Wrong email or password.')
    // Someone else's money is untouched.
    expect(await adminList(`users/${alex.uid}/earnings`)).toHaveLength(2)
  })
})
