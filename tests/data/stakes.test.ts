// Per-person stakes, house stakes, month freezes, results and per-pair settling (SPEC §9.7, §9.8) against the
// emulators. House-stakes freezes depend on when a month is complete by the server's clock, so those cases seed
// the stored last week of a month with deadlines around the real time (the stored deadline is what decides).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { collection, disableNetwork, enableNetwork, getDocsFromServer, Timestamp } from 'firebase/firestore'
import { toMemberStakes } from '../../src/data/convert.ts'
import { agreeToStakes, saveMyStakes, settlePairs, updateSpace } from '../../src/data/api.ts'
import type { StakesInput } from '../../src/data/api.ts'
import { ensureMonthStakes, startMonthStakes } from '../../src/data/months.ts'
import { startLatestResults, startResults } from '../../src/data/results.ts'
import { startSettlements } from '../../src/data/settlements.ts'
import { forgetSpace, startSpace } from '../../src/data/spaces.ts'
import { startStakes } from '../../src/data/stakes.ts'
import { watch, type Start } from '../../src/data/store.ts'
import { now } from '../../src/domain/clock.ts'
import { FIRST_RESULTS_MONTH, memberTerms, monthHouse, pairTerms, termsMonth } from '../../src/domain/stakes.ts'
import { addMonths, weekBounds, weekIdsInMonth } from '../../src/domain/time.ts'
import type { MemberStakes, Space, UID } from '../../src/domain/types.ts'
import { getFirebase } from '../../src/firebase/app.ts'
import {
  adminGet,
  adminSpace,
  as,
  boundsDoc,
  createUser,
  DAY,
  HOUR,
  observe,
  rejectsWith,
  resetClock,
  seed,
  setClock,
  setupEmulators,
  spaceDoc,
  teardownEmulators,
  travelBack,
  travelTo,
  ts,
  type TestUser,
} from './helpers.ts'

const OFFLINE = "You're offline. Check your connection and try again."
const NO_ACCESS = "You don't have access to this."
const CHANGED = 'These stakes just changed. Take another look.'

let marco: TestUser
let lena: TestUser
let sam: TestUser
let kim: TestUser

const utcMonth = (ms: number) => new Date(ms).toISOString().slice(0, 7)
const lastWeekOf = (monthId: string) => weekIdsInMonth(monthId).at(-1) as string
const millis = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : undefined)

/** Every stakes doc of a space as the server has it now (a listener's first answer may come from the cache). */
async function stakesOf(spaceId: string): Promise<Record<UID, MemberStakes>> {
  const snap = await getDocsFromServer(collection(getFirebase().db, 'spaces', spaceId, 'stakes'))
  return Object.fromEntries(snap.docs.map((d) => [d.id, toMemberStakes(d)]))
}

beforeAll(async () => {
  await setupEmulators()
  resetClock()
  marco = await createUser('Marco')
  lena = await createUser('Lena')
  sam = await createUser('Sam')
  kim = await createUser('Kim')
  await seed({ 'spaces/own': spaceDoc({ ownerId: marco.uid, memberIds: [marco.uid, lena.uid, sam.uid], inviteCode: 'OWNSTAKE' }) })
})
afterAll(teardownEmulators)

describe('your own stakes', () => {
  let space: Space
  const input = (over: Partial<StakesInput> = {}): StakesInput => ({
    rewardMode: 'group', penaltyMode: 'group', reward: 'Dinner, on you', penalty: 'A coffee each', per: {}, tiers: [], ...over,
  })

  beforeAll(async () => {
    space = await adminSpace('own')
  })

  it('checks every line before writing', async () => {
    await as(marco)
    await rejectsWith(saveMyStakes(space, input({ reward: '  ' })), 'Fill in what they owe you and what you owe them.')
    await rejectsWith(saveMyStakes(space, input({ rewardMode: 'each', per: { [lena.uid]: { reward: ' ', penalty: '' } } })), 'Fill in what each friend owes you, or make it the same for everyone.')
    await rejectsWith(saveMyStakes(space, input({ penaltyMode: 'each', per: { [lena.uid]: { reward: '', penalty: '' } } })), 'Fill in what you owe each friend, or make it the same for everyone.')
    await rejectsWith(saveMyStakes(space, input({ reward: 'x'.repeat(121) })), 'Keep each one under 120 characters.')
    const tier = (months: number) => ({ months, reward: 'Trip' })
    await rejectsWith(saveMyStakes(space, input({ tiers: [2, 3, 4, 6, 9, 12].map(tier) })), 'Up to 5 streak rewards.')
    await rejectsWith(saveMyStakes(space, input({ tiers: [tier(3), tier(3)] })), 'Each streak length can only be used once.')
    await rejectsWith(saveMyStakes(space, input({ tiers: [tier(1)] })), 'A streak is 2 to 36 months.')
    await rejectsWith(saveMyStakes(space, input({ tiers: [tier(37)] })), 'A streak is 2 to 36 months.')
    expect(await adminGet(`spaces/own/stakes/${marco.uid}`)).toBeUndefined()
  })

  it('creates your doc with no agreements; one line the same for everyone, the other per friend', async () => {
    await saveMyStakes(space, input({
      reward: '  Dinner, on you ',
      penaltyMode: 'each',
      penalty: 'Coffee for everyone',
      // Entries for yourself and for people not in the space are dropped.
      per: { [lena.uid]: { reward: 'kept?', penalty: ' A coffee ' }, [sam.uid]: { reward: '', penalty: 'A beer' }, ghost: { reward: '', penalty: 'Tea' }, [marco.uid]: { reward: '', penalty: 'Me' } },
      tiers: [{ months: 6, reward: 'A trip' }, { months: 3, reward: ' Weekend away ' }],
    }))
    const stored = await adminGet(`spaces/own/stakes/${marco.uid}`)
    expect(stored).toMatchObject({
      rewardMode: 'group', penaltyMode: 'each', reward: 'Dinner, on you', penalty: 'Coffee for everyone',
      per: { [lena.uid]: { reward: '', penalty: 'A coffee' }, [sam.uid]: { reward: '', penalty: 'A beer' } },
      tiers: [{ months: 3, reward: 'Weekend away' }, { months: 6, reward: 'A trip' }],
      agreed: {},
    })
    expect(Object.keys(stored?.per).sort()).toEqual([lena.uid, sam.uid].sort())
    expect(millis(stored?.updatedAt)).toBeGreaterThan(Date.now() - 60_000)
  })

  it('saving the same terms writes nothing', async () => {
    const before = await adminGet(`spaces/own/stakes/${marco.uid}`)
    const s = (await stakesOf('own'))[marco.uid]
    await saveMyStakes(space, { rewardMode: s.rewardMode, penaltyMode: s.penaltyMode, reward: s.reward, penalty: s.penalty, per: s.per, tiers: s.tiers })
    expect(millis((await adminGet(`spaces/own/stakes/${marco.uid}`))?.updatedAt)).toBe(millis(before?.updatedAt))
  })

  it('a friend agrees to exactly what they saw, stamped with the server time; agreeing again writes nothing', async () => {
    await as(marco)
    await rejectsWith(agreeToStakes(space, marco.uid, pairTerms((await stakesOf('own'))[marco.uid], lena.uid)!), NO_ACCESS)
    await as(lena)
    const live = observe(startStakes('own'))
    const seen = pairTerms((await live.until((l) => !!l.data?.[marco.uid])).data?.[marco.uid], lena.uid)!
    expect(seen).toEqual({ rewardMode: 'group', penaltyMode: 'each', reward: 'Dinner, on you', penalty: 'A coffee', tiers: [{ months: 3, reward: 'Weekend away' }, { months: 6, reward: 'A trip' }] })
    await agreeToStakes(space, marco.uid, seen)
    const agreed = (await adminGet(`spaces/own/stakes/${marco.uid}`))?.agreed[lena.uid]
    expect(agreed).toMatchObject({ terms: seen, past: [] })
    expect(millis(agreed.at)).toBeGreaterThan(Date.now() - 60_000)
    // The listener shows it live.
    await live.until((l) => l.data?.[marco.uid]?.agreed[lena.uid]?.terms.penalty === 'A coffee')
    live.stop()
    await agreeToStakes(space, marco.uid, seen)
    const again = (await adminGet(`spaces/own/stakes/${marco.uid}`))?.agreed[lena.uid]
    expect(again.at.isEqual(agreed.at)).toBe(true)
  })

  it('terms that changed since you looked are refused; agreeing to the new ones keeps the old agreement in past, with its time', async () => {
    const seenBefore = pairTerms((await stakesOf('own'))[marco.uid], lena.uid)!
    const firstAt = (await adminGet(`spaces/own/stakes/${marco.uid}`))?.agreed[lena.uid].at as Timestamp
    await as(marco)
    const s = (await stakesOf('own'))[marco.uid]
    await saveMyStakes(space, { ...s, per: { ...s.per, [lena.uid]: { reward: '', penalty: 'Two coffees' } } })
    await as(lena)
    await rejectsWith(agreeToStakes(space, marco.uid, seenBefore), CHANGED)
    const seen = pairTerms((await stakesOf('own'))[marco.uid], lena.uid)!
    await agreeToStakes(space, marco.uid, seen)
    const agreed = (await adminGet(`spaces/own/stakes/${marco.uid}`))?.agreed[lena.uid]
    expect(agreed.terms.penalty).toBe('Two coffees')
    expect(agreed.past).toHaveLength(1)
    expect(agreed.past[0]).toMatchObject({ ...seenBefore })
    // The stamped time is the earlier agreement's own server time, to the microsecond.
    expect((agreed.past[0].at as Timestamp).isEqual(firstAt)).toBe(true)
    // A per-friend change counts with that friend's Agree alone (what the stakes card shows).
    const space2 = await adminSpace('own')
    const terms = memberTerms(space2, marco.uid, [lena.uid, sam.uid], await stakesOf('own'), space2, Infinity)
    expect(terms[lena.uid].penalty).toMatchObject({ text: 'Two coffees', together: false, source: 'agreed' })
    expect(terms[sam.uid].penalty).toMatchObject({ text: 'Coffee for a week', source: 'house' })
  })

  it('keeps 6 agreements: the oldest goes', async () => {
    for (let i = 1; i <= 6; i++) {
      await as(marco)
      const s = (await stakesOf('own'))[marco.uid]
      await saveMyStakes(space, { ...s, per: { ...s.per, [lena.uid]: { reward: '', penalty: `Coffee ${i}` } } })
      await as(lena)
      await agreeToStakes(space, marco.uid, pairTerms((await stakesOf('own'))[marco.uid], lena.uid)!)
    }
    const agreed = (await adminGet(`spaces/own/stakes/${marco.uid}`))?.agreed[lena.uid]
    expect(agreed.terms.penalty).toBe('Coffee 6')
    expect(agreed.past.map((p: { penalty: string }) => p.penalty)).toEqual(['Coffee 1', 'Coffee 2', 'Coffee 3', 'Coffee 4', 'Coffee 5'])
  })

  it('nothing to agree to while a line is per friend and you have no entry', async () => {
    await seed({ 'spaces/own': spaceDoc({ ownerId: marco.uid, memberIds: [marco.uid, lena.uid, sam.uid, kim.uid], inviteCode: 'OWNSTAKE' }) })
    await as(kim)
    const seen = { rewardMode: 'group' as const, penaltyMode: 'each' as const, reward: 'Dinner, on you', penalty: '', tiers: [] }
    await rejectsWith(agreeToStakes(await adminSpace('own'), marco.uid, seen), 'There’s nothing to agree to yet.')
  })

  it('saving and agreeing fail at once offline', async () => {
    const { db } = getFirebase()
    await as(sam)
    await disableNetwork(db)
    try {
      await rejectsWith(saveMyStakes(space, input()), OFFLINE)
      await rejectsWith(agreeToStakes(space, marco.uid, { rewardMode: 'group', penaltyMode: 'each', reward: 'Dinner, on you', penalty: 'A beer', tiers: [] }), OFFLINE)
    } finally {
      await enableNetwork(db)
    }
  })
})

describe('house stakes', () => {
  const C = () => utcMonth(Date.now())
  /** A space of Marco (owner) and Lena with its invite; created now unless given (so only this month is checked). */
  async function houseSpace(id: string, opts: { createdAt?: number; lastDeadline?: number; freeze?: { reward: string; penalty: string; createdAt: number } } = {}) {
    const code = `H${id.toUpperCase()}23456789`.slice(0, 8)
    const docs: Record<string, Record<string, unknown>> = {
      [`spaces/${id}`]: spaceDoc({ ownerId: marco.uid, memberIds: [marco.uid, lena.uid], inviteCode: code, createdAt: opts.createdAt ?? Date.now() - 60_000 }),
      [`invites/${code}`]: { spaceId: id, spaceName: 'Film Club', reward: 'Dinner on me', penalty: 'Coffee for a week', inviterName: 'Marco', createdBy: marco.uid, createdAt: ts(Date.now()) },
    }
    if (opts.lastDeadline !== undefined) {
      const t = opts.lastDeadline
      docs[`spaces/${id}/weeks/${lastWeekOf(C())}`] = boundsDoc({ startAt: t - 5 * DAY, lockAt: t - 4 * DAY, reviewOpenAt: t - DAY, deadlineAt: t }, [marco.uid, lena.uid])
    }
    if (opts.freeze) docs[`spaces/${id}/months/${C()}`] = { reward: opts.freeze.reward, penalty: opts.freeze.penalty, createdAt: ts(opts.freeze.createdAt) }
    await seed(docs)
    return code
  }

  it('only the owner changes them; anyone renames', async () => {
    await houseSpace('house1', { lastDeadline: Date.now() + 3 * DAY })
    await as(lena)
    await rejectsWith(updateSpace('house1', { reward: 'Sushi' }), 'Only the owner can change the house stakes.')
    expect((await adminGet('spaces/house1'))?.reward).toBe('Dinner on me')
    await updateSpace('house1', { name: 'Film Club Two' })
    // An older app sends all three; unchanged stakes aren't a change.
    await updateSpace('house1', { name: 'Film Club', reward: 'Dinner on me', penalty: 'Coffee for a week' })
    expect(await adminGet('spaces/house1')).toMatchObject({ name: 'Film Club', reward: 'Dinner on me' })
    expect((await adminGet('spaces/house1'))?.stakesNote).toBeUndefined()
  })

  it('mid-month, the owner’s change counts at once: no freeze, a note, and the invite follows', async () => {
    const code = await houseSpace('house2', { lastDeadline: Date.now() + 3 * DAY })
    await as(marco)
    await updateSpace('house2', { reward: 'Sushi', penalty: 'Dishes' })
    const stored = await adminGet('spaces/house2')
    expect(stored).toMatchObject({ reward: 'Sushi', penalty: 'Dishes', stakesNote: { by: marco.uid } })
    expect(millis(stored?.stakesNote.at)).toBeGreaterThan(Date.now() - 60_000)
    expect(await adminGet(`invites/${code}`)).toMatchObject({ reward: 'Sushi', penalty: 'Dishes' })
    expect(await adminGet(`spaces/house2/months/${C()}`)).toBeUndefined()
  })

  it('once the month is complete, the edit freezes it with the old stakes in the same commit', async () => {
    // Created months ago: the month before is complete and unfrozen too, so both are frozen first.
    await houseSpace('house3', { createdAt: Date.now() - 70 * DAY, lastDeadline: Date.now() - HOUR })
    await as(marco)
    await updateSpace('house3', { reward: 'Sushi' })
    const prev = addMonths(C(), -1)
    for (const m of [prev, C()]) {
      const frozen = await adminGet(`spaces/house3/months/${m}`)
      expect(frozen).toMatchObject({ reward: 'Dinner on me', penalty: 'Coffee for a week' })
      expect(millis(frozen?.createdAt)).toBeGreaterThan(Date.now() - 60_000)
    }
    expect((await adminGet('spaces/house3'))?.reward).toBe('Sushi')
    // The finished month keeps its own; the new ones count from the next.
    const space = await adminSpace('house3')
    const live = observe(startMonthStakes('house3', C()))
    const frozen = (await live.until((l) => l.data != null)).data
    live.stop()
    expect(monthHouse(space, C(), frozen, Date.now() - HOUR)).toMatchObject({ reward: 'Dinner on me', frozen: true })
  })

  it('the previous app’s early freeze doesn’t bind: mid-month the edit counts at once', async () => {
    const early = Date.now() - 10 * DAY
    await houseSpace('house4', { lastDeadline: Date.now() + 3 * DAY, freeze: { reward: 'Old reward', penalty: 'Old penalty', createdAt: early } })
    expect(C() >= FIRST_RESULTS_MONTH).toBe(true)
    await as(marco)
    await updateSpace('house4', { reward: 'Sushi' })
    expect(await adminGet(`spaces/house4/months/${C()}`)).toMatchObject({ reward: 'Old reward' })
    const space = await adminSpace('house4')
    const live = observe(startMonthStakes('house4', C()))
    const frozen = (await live.until((l) => l.data != null)).data
    live.stop()
    expect(frozen?.createdAt).toBe(early)
    expect(monthHouse(space, C(), frozen, Date.now() + 3 * DAY)).toEqual({ reward: 'Sushi', penalty: 'Coffee for a week', frozen: false })
  })

  it('after completion, the edit first re-freezes an early freeze with the old stakes', async () => {
    await houseSpace('house5', { lastDeadline: Date.now() - HOUR, freeze: { reward: 'Old reward', penalty: 'Old penalty', createdAt: Date.now() - 10 * DAY } })
    await as(marco)
    await updateSpace('house5', { penalty: 'Dishes' })
    const frozen = await adminGet(`spaces/house5/months/${C()}`)
    expect(frozen).toMatchObject({ reward: 'Dinner on me', penalty: 'Coffee for a week' })
    expect(millis(frozen?.createdAt)).toBeGreaterThan(Date.now() - 60_000)
    expect((await adminGet('spaces/house5'))?.penalty).toBe('Dishes')
  })

  it('a device clock a few minutes behind the server at completion still freezes, through the retry', async () => {
    await houseSpace('house6', { lastDeadline: Date.now() - 30_000 })
    setClock(Date.now() - 5 * 60_000)
    try {
      await as(marco)
      await updateSpace('house6', { reward: 'Sushi' })
    } finally {
      resetClock()
    }
    expect(await adminGet(`spaces/house6/months/${C()}`)).toMatchObject({ reward: 'Dinner on me' })
    expect((await adminGet('spaces/house6'))?.reward).toBe('Sushi')
  })

  it('a stakes change fails at once offline; a rename still queues', async () => {
    await houseSpace('house7', { lastDeadline: Date.now() + 3 * DAY })
    await as(marco)
    const { db } = getFirebase()
    const live = observe(startSpace('house7'))
    await live.until((l) => l.data?.name === 'Film Club')
    await disableNetwork(db)
    let rename: Promise<void> | null = null
    try {
      await rejectsWith(updateSpace('house7', { reward: 'Sushi' }), OFFLINE)
      rename = updateSpace('house7', { name: 'Offline Club' })
      // The rename waits in this device's queue, and shows at once.
      await live.until((l) => l.data?.name === 'Offline Club')
    } finally {
      await enableNetwork(db)
    }
    await rename
    live.stop()
    expect(await adminGet('spaces/house7')).toMatchObject({ name: 'Offline Club', reward: 'Dinner on me' })
  })
})

describe('month freezes by the upkeep', () => {
  const C = () => utcMonth(Date.now())
  const P = () => addMonths(C(), -1)

  it('freezes nothing before a month is complete', async () => {
    const t = Date.now() + 3 * DAY
    await seed({
      'spaces/up1': spaceDoc({ ownerId: marco.uid, memberIds: [marco.uid, lena.uid], createdAt: Date.now() - 60_000 }),
      [`spaces/up1/weeks/${lastWeekOf(C())}`]: boundsDoc({ startAt: t - 5 * DAY, lockAt: t - 4 * DAY, reviewOpenAt: t - DAY, deadlineAt: t }, [marco.uid, lena.uid]),
    })
    await as(lena)
    await ensureMonthStakes(await adminSpace('up1'))
    expect(await adminGet(`spaces/up1/months/${C()}`)).toBeUndefined()
  })

  it('freezes a complete month by its stored last week and list, with its createdAt', async () => {
    // Last month: its stored last week is over, but its list is due an hour from now.
    const last = weekBounds(lastWeekOf(P()), 'UTC')
    await seed({
      'spaces/up2': spaceDoc({ ownerId: marco.uid, memberIds: [marco.uid, lena.uid], createdAt: Date.now() - 70 * DAY }),
      [`spaces/up2/weeks/${lastWeekOf(P())}`]: boundsDoc(last, [marco.uid, lena.uid]),
      [`spaces/up2/monthly/${P()}`]: { ...boundsDoc({ startAt: last.startAt - 28 * DAY, lockAt: last.startAt - 20 * DAY, reviewOpenAt: Date.now() - HOUR, deadlineAt: Date.now() + HOUR }, [marco.uid, lena.uid]), judges: [] },
    })
    await as(lena)
    await ensureMonthStakes(await adminSpace('up2'))
    expect(await adminGet(`spaces/up2/months/${P()}`)).toBeUndefined()
    await seed({ [`spaces/up2/monthly/${P()}`]: { ...boundsDoc({ startAt: last.startAt - 28 * DAY, lockAt: last.startAt - 20 * DAY, reviewOpenAt: Date.now() - 2 * HOUR, deadlineAt: Date.now() - HOUR }, [marco.uid, lena.uid]), judges: [] } })
    await ensureMonthStakes(await adminSpace('up2'))
    const frozen = await adminGet(`spaces/up2/months/${P()}`)
    expect(frozen).toMatchObject({ reward: 'Dinner on me', penalty: 'Coffee for a week' })
    const live = observe(startMonthStakes('up2', P()))
    const data = (await live.until((l) => l.data != null)).data
    live.stop()
    expect(data).toEqual({ reward: 'Dinner on me', penalty: 'Coffee for a week', frozen: true, createdAt: millis(frozen?.createdAt) })
  })

  it('a month from before batch 2 keeps the previous app’s freeze; a later one gets the space’s at completion', async () => {
    const early = Date.now() - 40 * DAY
    await seed({
      'spaces/up3': spaceDoc({ ownerId: marco.uid, memberIds: [marco.uid, lena.uid], createdAt: Date.now() - 70 * DAY }),
      [`spaces/up3/months/${P()}`]: { reward: 'Old reward', penalty: 'Old penalty', createdAt: ts(early) },
    })
    await as(lena)
    await ensureMonthStakes(await adminSpace('up3'))
    const frozen = await adminGet(`spaces/up3/months/${P()}`)
    if (P() < FIRST_RESULTS_MONTH) expect(frozen).toMatchObject({ reward: 'Old reward', createdAt: ts(early) })
    else expect(frozen).toMatchObject({ reward: 'Dinner on me' })
  })

  it('re-freezes an early freeze of a month from 2026-10 on once, at completion', async () => {
    // On a moved clock: the Saturday after the last Friday of a month two months ahead.
    const month = addMonths(C(), 2)
    const end = weekBounds(lastWeekOf(month), 'UTC')
    await travelTo(end.deadlineAt + 10 * HOUR)
    try {
      const firstLock = weekBounds(weekIdsInMonth(month)[0], 'UTC').lockAt
      await seed({
        'spaces/up4': spaceDoc({ ownerId: marco.uid, memberIds: [marco.uid, lena.uid], createdAt: Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, 1, 12), joinedAt: now() - 40 * DAY }),
        [`spaces/up4/weeks/${lastWeekOf(month)}`]: boundsDoc(end, [marco.uid, lena.uid]),
        [`spaces/up4/months/${month}`]: { reward: 'Old reward', penalty: 'Old penalty', createdAt: ts(firstLock) },
      })
      await as(lena)
      await ensureMonthStakes(await adminSpace('up4'))
      const frozen = await adminGet(`spaces/up4/months/${month}`)
      expect(frozen).toMatchObject({ reward: 'Dinner on me', penalty: 'Coffee for a week' })
      await ensureMonthStakes(await adminSpace('up4'))
      expect(millis((await adminGet(`spaces/up4/months/${month}`))?.createdAt)).toBe(millis(frozen?.createdAt))
      expect(termsMonth(await adminSpace('up4'), now())).toBe(addMonths(month, 1))
    } finally {
      await travelBack()
    }
  })
})

describe('results and settling', () => {
  it('reads a month’s results and the newest ones; null until written', async () => {
    await as(lena)
    const missing = observe(startResults('own', '2026-10'))
    expect((await missing.until((l) => !l.loading)).data).toBeNull()
    missing.stop()
    const results = (monthId: string, streak: number) => ({
      monthId, completeAt: ts(Date.now() - DAY), createdAt: ts(Date.now()),
      members: { [lena.uid]: { score: 93.5, passed: true, streak, tierRuns: { '3': streak } }, [sam.uid]: { score: null, passed: null, streak: 1.5 } },
    })
    await seed({ 'spaces/own/results/2026-10': results('2026-10', 2), 'spaces/own/results/2026-11': results('2026-11', 3) })
    const one = observe(startResults('own', '2026-10'))
    const data = (await one.until((l) => l.data != null)).data
    one.stop()
    expect(data?.members[lena.uid]).toEqual({ score: 93.5, passed: true, streak: 2, tierRuns: { '3': 2 } })
    expect(data?.members[sam.uid]).toEqual({ score: null, passed: null, streak: 0 })
    const latest = observe(startLatestResults('own'))
    // The newest: its first answer may come from this device's cache, then the server's.
    await latest.until((l) => l.data?.monthId === '2026-11')
    latest.stop()
  })

  it('settles every pair of a line in one batch, a streak reward and a friend who left included', async () => {
    await seed({ 'spaces/own': spaceDoc({ ownerId: marco.uid, memberIds: [marco.uid, lena.uid, sam.uid], inviteCode: 'OWNSTAKE', extra: { leftAt: { [kim.uid]: ts(Date.now() - DAY) } } }) })
    await seed({ [`spaces/own/settlements/2026-10_${marco.uid}`]: { monthId: '2026-10', uid: marco.uid, settled: true, settledBy: lena.uid, settledAt: ts(Date.now()) } })
    await seed({ [`spaces/own/settlements/2026-09_${marco.uid}_${lena.uid}`]: { monthId: '2026-09', uid: marco.uid, other: lena.uid, settled: true, settledBy: lena.uid, settledAt: ts(Date.now()) } })
    await as(marco)
    await settlePairs('own', '2026-10', [{ uid: marco.uid, other: lena.uid }, { uid: marco.uid, other: kim.uid }, { uid: marco.uid, other: sam.uid, tier: 3 }], true)
    expect(await adminGet(`spaces/own/settlements/2026-10_${marco.uid}_${lena.uid}`)).toMatchObject({ monthId: '2026-10', uid: marco.uid, other: lena.uid, settled: true, settledBy: marco.uid })
    expect(await adminGet(`spaces/own/settlements/2026-10_${marco.uid}_${kim.uid}`)).toMatchObject({ other: kim.uid, settled: true })
    expect(await adminGet(`spaces/own/settlements/2026-10_${marco.uid}_${sam.uid}_s3`)).toMatchObject({ other: sam.uid, tier: 3, settled: true })
    const live = observe(startSettlements('own', '2026-10'))
    const month = await live.until((l) => l.data?.length === 4)
    expect(month.data?.every((s) => s.monthId === '2026-10')).toBe(true)
    expect(month.data?.find((s) => s.tier === 3)).toMatchObject({ uid: marco.uid, other: sam.uid })
    expect(month.data?.find((s) => s.other === undefined)).toMatchObject({ uid: marco.uid, settled: true })
    await settlePairs('own', '2026-10', [{ uid: marco.uid, other: lena.uid }], false)
    await live.until((l) => l.data?.find((s) => s.other === lena.uid)?.settled === false)
    live.stop()
  })

  it('settling queues offline like before', async () => {
    const { db } = getFirebase()
    const live = observe(startSettlements('own', '2026-10'))
    await live.until((l) => l.data?.length === 4)
    await disableNetwork(db)
    let write: Promise<void> | null = null
    try {
      write = settlePairs('own', '2026-10', [{ uid: marco.uid, other: lena.uid }], true)
      await live.until((l) => l.data?.find((s) => s.other === lena.uid)?.settled === true)
    } finally {
      await enableNetwork(db)
    }
    await write
    live.stop()
    expect((await adminGet(`spaces/own/settlements/2026-10_${marco.uid}_${lena.uid}`))?.settled).toBe(true)
  })
})

describe('forgetting a space', () => {
  it('drops the stakes, monthly, month, results and settlement entries of that space only', async () => {
    const me = marco.uid
    const starts = new Map<string, number>()
    const counting = (key: string): Start<number> => (emit) => {
      starts.set(key, (starts.get(key) ?? 0) + 1)
      emit({ data: 1, loading: false, error: null })
      return () => {}
    }
    const keys = [
      `${me}|stakes|gone`,
      `${me}|monthly|gone|2026-10`,
      `${me}|month|gone|2026-10|m`,
      `${me}|results|gone|2026-10`,
      `${me}|results|gone|latest`,
      `${me}|settlements|gone|2026-10`,
      `${me}|stakes|kept`,
    ]
    const releases = keys.map((key) => watch(key, counting(key), () => {}))
    forgetSpace(me, 'gone')
    releases.forEach((release) => release())
    expect(keys.map((key) => starts.get(key))).toEqual([2, 2, 2, 2, 2, 2, 1])
  })
})
