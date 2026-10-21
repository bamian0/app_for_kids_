// The profile showcase (SPEC §11.7, §11.8) against the emulators and the real rules: switches written on the server's
// copy with only switched-on copies, a stale device refused, the background sync, and who reads stats.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { disableNetwork, doc, enableNetwork, serverTimestamp, Timestamp, updateDoc } from 'firebase/firestore'
import { addMove, markGoalBought, saveGoal, setBaseline, setCurrency, setShowcaseSwitch } from '../../src/data/api.ts'
import { moneyKeys, startEarnings, startGoals, startMoneyState, startMoves } from '../../src/data/money.ts'
import { showcaseKey, startShowcase, startShowcaseSync, startStats, statsKey } from '../../src/data/showcase.ts'
import { forget, peek, watch, type Start } from '../../src/data/store.ts'
import { now } from '../../src/domain/clock.ts'
import { lastMoneyMonth, showcaseItems } from '../../src/domain/showcase.ts'
import type { ShowcaseItems, UserStats } from '../../src/domain/types.ts'
import { getFirebase } from '../../src/firebase/app.ts'
import { adminGet, as, clientFor, createUser, eventually, observe, rejectsWith, seed, setupEmulators, teardownEmulators, ts, type TestUser } from './helpers.ts'

const OFFLINE = 'You’re offline. Check your connection and try again.'
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

let ana: TestUser
let zed: TestUser

beforeAll(async () => {
  await setupEmulators()
  ana = await createUser('Ana')
  zed = await createUser('Zed')
})
afterAll(teardownEmulators)

const path = (user: TestUser) => `showcases/${user.uid}`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The first state a listener gets. */
async function first<T>(start: Start<T>): Promise<T> {
  const live = observe(start)
  const state = await live.until((l) => l.data !== undefined)
  live.stop()
  return state.data as T
}

/** What the editor passes: the items from the money as it is now (read with the same listeners as the app). */
async function itemsOf(user: TestUser): Promise<ShowcaseItems> {
  const moves = await first(startMoves(user.uid))
  const goals = await first(startGoals(user.uid))
  const earnings = await first(startEarnings(user.uid))
  const state = await first(startMoneyState(user.uid))
  return showcaseItems({ moves, goals, earnings, state, currency: state?.currency ?? 'USD' }, now(), TZ)
}

let tent = ''

describe('switches', () => {
  it('a switch writes only switched-on copies; turning one off removes its item', async () => {
    await as(ana)
    await setCurrency('EUR')
    await setBaseline(100)
    await saveGoal({ name: 'Bike', cost: 300 })
    const lamp = await saveGoal({ name: 'Lamp', cost: 20 })
    await markGoalBought({ id: lamp, name: 'Lamp', cost: 20, order: 1, createdAt: Date.now() })
    const items = await itemsOf(ana)
    expect(items.achieved.map((a) => a.name)).toEqual(['Lamp'])
    expect(items.goals).toEqual([{ name: 'Bike', pct: 26 }])
    expect(items.earnings).toEqual({ monthId: lastMoneyMonth(now(), TZ), amount: 0, currency: 'EUR' })

    await setShowcaseSwitch('achieved', true, items)
    let d = await adminGet(path(ana))
    expect(Object.keys(d!).sort()).toEqual(['achieved', 'show', 'updatedAt'])
    expect(d!.show).toEqual({ stats: true, achieved: true, goals: false, earnings: false })
    expect(d!.achieved).toHaveLength(1)
    expect(d!.achieved[0].name).toBe('Lamp')
    expect(d!.achieved[0].at).toBeInstanceOf(Timestamp)
    const storedAchieved = d!.achieved

    await setShowcaseSwitch('earnings', true, items)
    d = await adminGet(path(ana))
    expect(Object.keys(d!).sort()).toEqual(['achieved', 'earnings', 'show', 'updatedAt'])
    expect(d!.earnings).toEqual(items.earnings)
    // The achieved list is written back exactly as stored.
    expect(d!.achieved[0].at.isEqual(storedAchieved[0].at)).toBe(true)

    await setShowcaseSwitch('achieved', false, items)
    d = await adminGet(path(ana))
    expect(Object.keys(d!).sort()).toEqual(['earnings', 'show', 'updatedAt'])
    expect(d!.show).toEqual({ stats: true, achieved: false, goals: false, earnings: true })

    await setShowcaseSwitch('earnings', false, items)
    await setShowcaseSwitch('stats', false, items)
    d = await adminGet(path(ana))
    expect(Object.keys(d!).sort()).toEqual(['show', 'updatedAt'])
    expect(d!.show).toEqual({ stats: false, achieved: false, goals: false, earnings: false })
    await setShowcaseSwitch('stats', true, items)
  })

  it('a stale device\'s item for a switch turned off elsewhere is refused, and the doc stays as it was', async () => {
    const before = await adminGet(path(ana))
    expect(before!.show.earnings).toBe(false)
    // Another device of Ana's that still thinks earnings are shown sends its item-only update.
    const stale = clientFor(ana.uid)
    await expect(updateDoc(doc(stale, path(ana)), { earnings: { monthId: '2026-09', amount: 10, currency: 'EUR' }, updatedAt: serverTimestamp() })).rejects.toMatchObject({ code: 'permission-denied' })
    const after = await adminGet(path(ana))
    expect(Object.keys(after!).sort()).toEqual(Object.keys(before!).sort())
    expect(after!.updatedAt.isEqual(before!.updatedAt)).toBe(true)
  })

  it('a switch fails at once offline, and nothing is queued', async () => {
    await as(ana)
    const items = await itemsOf(ana)
    const before = await adminGet(path(ana))
    const { db } = getFirebase()
    await disableNetwork(db)
    try {
      await rejectsWith(setShowcaseSwitch('goals', true, items), OFFLINE)
    } finally {
      await enableNetwork(db)
    }
    await sleep(500)
    expect((await adminGet(path(ana)))!.show).toEqual(before!.show)
  })
})

describe('the background sync', () => {
  it('writes once on a money change, and not again without one; never a switch', async () => {
    await as(ana)
    await setShowcaseSwitch('goals', true, await itemsOf(ana))
    const stop = startShowcaseSync(ana.uid, { debounceMs: 200 })
    try {
      await eventually(() => peek(moneyKeys.goals(ana.uid)).data !== undefined)
      // Nothing changed: nothing written.
      const first = await adminGet(path(ana))
      await sleep(800)
      expect((await adminGet(path(ana)))!.updatedAt.isEqual(first!.updatedAt)).toBe(true)

      tent = await saveGoal({ name: 'Tent', cost: 50 })
      await eventually(async () => ((await adminGet(path(ana)))?.goals ?? []).length === 2)
      const synced = await adminGet(path(ana))
      expect(synced!.goals).toEqual([{ name: 'Bike', pct: 26 }, { name: 'Tent', pct: 0 }])
      expect(synced!.show).toEqual(first!.show)
      await sleep(1_000)
      expect((await adminGet(path(ana)))!.updatedAt.isEqual(synced!.updatedAt)).toBe(true)

      // Money that changes a percentage: one more write.
      await addMove('add', 300, 'Birthday')
      await eventually(async () => (await adminGet(path(ana)))?.goals?.[0]?.pct === 100)
      expect((await adminGet(path(ana)))!.goals).toEqual([{ name: 'Bike', pct: 100 }, { name: 'Tent', pct: 100 }])
    } finally {
      stop()
    }
  })

  it('a bought goal shows up as achieved once its move is on the server', async () => {
    await as(ana)
    await setShowcaseSwitch('achieved', true, await itemsOf(ana))
    const stop = startShowcaseSync(ana.uid, { debounceMs: 100 })
    try {
      await markGoalBought({ id: tent, name: 'Tent', cost: 50, order: 2, createdAt: Date.now() })
      await eventually(async () => ((await adminGet(path(ana)))?.achieved ?? []).some((a: { name: string }) => a.name === 'Tent'))
      const d = await adminGet(path(ana))
      expect(d!.achieved.map((a: { name: string }) => a.name)).toEqual(['Tent', 'Lamp'])
    } finally {
      stop()
    }
  })

  it('reads no money while no money switch is on', async () => {
    await as(zed)
    const stop = startShowcaseSync(zed.uid, { debounceMs: 100 })
    try {
      await eventually(() => peek(showcaseKey(zed.uid, zed.uid)).loading === false)
      await sleep(300)
      expect(peek(moneyKeys.moves(zed.uid)).loading).toBe(true)
    } finally {
      stop()
    }
  })
})

describe('stats', () => {
  const stats = { monthsCleared: 2, currentStreak: 1, bestStreak: 2, weeksPlayed: 9, finishedMonths: 3, since: '2026-10', updatedAt: ts(Date.now()) }

  it('anyone reads them while the showcase shows stats (or there is none), nobody else once hidden', async () => {
    await seed({ [`stats/${zed.uid}`]: stats, [`stats/${ana.uid}`]: stats })
    // Zed has no showcase: shown.
    await as(ana)
    const shown = observe(startStats(zed.uid))
    expect((await shown.until((l) => l.data !== undefined)).data).toMatchObject({ uid: zed.uid, monthsCleared: 2, weeksPlayed: 9, since: '2026-10' })
    shown.stop()
    // Zed hides them.
    await as(zed)
    await setShowcaseSwitch('stats', false, await itemsOf(zed))
    await as(ana)
    const hidden = observe(startStats(zed.uid))
    expect(await hidden.until((l) => l.data === null)).toEqual({ data: null, loading: false, error: null })
    hidden.stop()
    // Their own, always.
    await as(zed)
    const own = observe(startStats(zed.uid))
    expect((await own.until((l) => l.data !== undefined && l.data !== null)).data?.bestStreak).toBe(2)
    own.stop()
  })

  it('stats refused before are read again when the switch turns back on', async () => {
    await as(ana)
    const noop = () => {}
    const releaseShowcase = watch(showcaseKey(ana.uid, zed.uid), startShowcase(ana.uid, zed.uid), noop)
    const releaseStats = watch(statsKey(ana.uid, zed.uid), startStats(zed.uid), noop)
    try {
      await eventually(() => peek(statsKey(ana.uid, zed.uid)).data === null && peek(showcaseKey(ana.uid, zed.uid)).data !== undefined)
      // Zed (another device) turns stats back on.
      await updateDoc(doc(clientFor(zed.uid), path(zed)), { 'show.stats': true, updatedAt: serverTimestamp() })
      await eventually(() => (peek<UserStats | null>(statsKey(ana.uid, zed.uid)).data?.monthsCleared ?? null) === 2)
    } finally {
      releaseStats()
      releaseShowcase()
      forget(statsKey(ana.uid, zed.uid))
      forget(showcaseKey(ana.uid, zed.uid))
    }
  })
})
