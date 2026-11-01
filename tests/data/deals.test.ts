// Deals (SPEC §12.9, §12.13) against the emulators and the real rules: propose (with Edit's replace), agree, withdraw,
// call off, settle, the two hooks' sources, the cutover month, streak rewards, and leaving or deleting the account.
// Agree and Call Off taps carry the emulator's real time; anything that depends on a deal's start or end is seeded
// with admin (agreed, agreedAt, start, ended), as the reminders job would write it.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { collection, disableNetwork, doc, enableNetwork, getDocFromServer, getDocsFromServer, query, Timestamp, where } from 'firebase/firestore'
import {
  agreeToDeal,
  agreeToStakes,
  callOffDeal,
  deleteMyAccount,
  leaveSpace,
  proposeDeal,
  saveMyStakes,
  saveStreakRewards,
  settleDeal,
  useDeals,
  withdrawDeal,
} from '../../src/data/api.ts'
import { toDeal } from '../../src/data/convert.ts'
import { DEAL_MSG, forgetDealsFrom, recentSince, startDealHistory, startDeals, startDealsFrom } from '../../src/data/deals.ts'
import { DEALS_FROM_MONTH, dealId } from '../../src/domain/deals.ts'
import { pairTerms } from '../../src/domain/stakes.ts'
import { weekBounds, weekIdFor } from '../../src/domain/time.ts'
import type { Deal, DealInput, Space, UID } from '../../src/domain/types.ts'
import { getFirebase } from '../../src/firebase/app.ts'
import { toMemberStakes } from '../../src/data/convert.ts'
import {
  adminGet,
  adminSpace,
  as,
  createUser,
  DAY,
  HOUR,
  observe,
  rejectsWith,
  resetClock,
  seed,
  setupEmulators,
  spaceDoc,
  teardownEmulators,
  ts,
  type TestUser,
} from './helpers.ts'

const OFFLINE = 'You’re offline. Check your connection and try again.'

let lena: TestUser
let sam: TestUser
let kim: TestUser
let ana: TestUser
let ben: TestUser

const input = (over: Partial<DealInput> = {}): DealInput => ({
  unit: 'week', count: 4, rewardMode: 'group', penaltyMode: 'group', reward: 'Dinner, on us', penalty: 'Coffee for a week', per: {}, ...over,
})

/** A deal doc exactly as the app writes it (createdAt a day ago), with job fields when given, for seeding with admin. */
function dealDoc(uid: UID, seq: number, friends: UID[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid, seq, unit: 'week', count: 4, rewardMode: 'group', penaltyMode: 'group', reward: 'Dinner, on us', penalty: 'Coffee for a week', per: {},
    friends, agreed: {}, off: {}, settled: {}, createdAt: ts(Date.now() - DAY), ended: null, ...extra,
  }
}

const agreedBy = (...uids: UID[]) => Object.fromEntries(uids.map((u, i) => [u, ts(Date.now() - 3 * DAY + i * HOUR)]))
/** Last week's Monday (UTC): a start whose lock has passed, so the deal is running. */
const lastWeek = () => weekIdFor(Date.now() - 7 * DAY, 'UTC')

async function myDeals(spaceId: string, uid: UID): Promise<Deal[]> {
  const snap = await getDocsFromServer(query(collection(getFirebase().db, 'spaces', spaceId, 'deals'), where('uid', '==', uid)))
  return snap.docs.flatMap((d) => toDeal(d, spaceId) ?? []).sort((a, b) => a.seq - b.seq)
}

beforeAll(async () => {
  await setupEmulators()
  resetClock()
  lena = await createUser('Lena')
  sam = await createUser('Sam')
  kim = await createUser('Kim')
  ana = await createUser('Ana')
  ben = await createUser('Ben')
})
afterAll(teardownEmulators)

describe('proposeDeal', () => {
  beforeAll(async () => {
    await seed({
      'spaces/p1': spaceDoc({ ownerId: lena.uid, memberIds: [lena.uid, sam.uid, kim.uid], inviteCode: 'DEALSONE' }),
      'spaces/judged': spaceDoc({ ownerId: lena.uid, memberIds: [lena.uid, sam.uid, ana.uid], inviteCode: 'DEALSTWO', extra: { judges: [ana.uid] } }),
      'spaces/alone': spaceDoc({ ownerId: lena.uid, memberIds: [lena.uid, ana.uid], inviteCode: 'DEALSTRI', extra: { judges: [ana.uid] } }),
    })
  })

  it('creates the first deal with exactly its keys and sets the space’s hasDeals', async () => {
    await as(lena)
    const space = await adminSpace('p1')
    expect(space.hasDeals).toBeUndefined()
    const deal = await proposeDeal(space, input({ reward: '  Dinner, on us ' }))
    expect(deal).toMatchObject({ id: `${lena.uid}_1`, uid: lena.uid, seq: 1, friends: [sam.uid, kim.uid], reward: 'Dinner, on us', ended: null, agreed: {} })
    const stored = (await adminGet(`spaces/p1/deals/${lena.uid}_1`))!
    expect(Object.keys(stored).sort()).toEqual(
      ['agreed', 'count', 'createdAt', 'ended', 'friends', 'off', 'penalty', 'penaltyMode', 'per', 'reward', 'rewardMode', 'seq', 'settled', 'uid', 'unit'],
    )
    expect(stored).toMatchObject({ uid: lena.uid, seq: 1, unit: 'week', count: 4, per: {}, friends: [sam.uid, kim.uid], ended: null })
    expect(stored.createdAt).toBeInstanceOf(Timestamp)
    expect((await adminGet('spaces/p1'))?.hasDeals).toBe(true)
  })

  it('refuses a second deal while the first is in play; after the job ended it, the next one is seq 2', async () => {
    await as(lena)
    const space = await adminSpace('p1')
    expect(space.hasDeals).toBe(true)
    await rejectsWith(proposeDeal(space, input()), DEAL_MSG.lastNotOver)
    await seed({ [`spaces/p1/deals/${lena.uid}_1`]: dealDoc(lena.uid, 1, [sam.uid, kim.uid], { ended: { outcome: 'won', at: ts(Date.now() - HOUR), period: lastWeek() } }) })
    const next = await proposeDeal(space, input({ unit: 'month', count: 2 }))
    expect(next).toMatchObject({ id: `${lena.uid}_2`, seq: 2, unit: 'month', count: 2 })
  })

  it('Edit: replace withdraws the waiting deal and proposes the new one in one transaction', async () => {
    await as(lena)
    const space = await adminSpace('p1')
    const edited = await proposeDeal(space, input({ count: 6, penaltyMode: 'each', penalty: '', per: { [sam.uid]: { reward: '', penalty: 'A coffee' }, [kim.uid]: { reward: '', penalty: 'A beer' } } }), { replace: `${lena.uid}_2` })
    expect(edited.seq).toBe(3)
    const [, second, third] = await myDeals('p1', lena.uid)
    expect(second.ended).toMatchObject({ outcome: 'withdrawn', by: lena.uid })
    expect(third).toMatchObject({ count: 6, penaltyMode: 'each', per: { [sam.uid]: { reward: '', penalty: 'A coffee' }, [kim.uid]: { reward: '', penalty: 'A beer' } } })
  })

  it('replace of a deal everyone agreed to is refused', async () => {
    await as(sam)
    await agreeToDeal(await adminSpace('p1'), `${lena.uid}_3`)
    await as(kim)
    await agreeToDeal(await adminSpace('p1'), `${lena.uid}_3`)
    await as(lena)
    await rejectsWith(proposeDeal(await adminSpace('p1'), input(), { replace: `${lena.uid}_3` }), DEAL_MSG.lastNotOver)
    expect((await myDeals('p1', lena.uid)).map((d) => d.seq)).toEqual([1, 2, 3])
  })

  it('a judge, someone alone, and every problem of the input', async () => {
    await as(ana)
    await rejectsWith(proposeDeal(await adminSpace('judged'), input()), DEAL_MSG.judging)
    await as(lena)
    await rejectsWith(proposeDeal(await adminSpace('alone'), input()), 'Deals need a friend who plays. Invite one first.')
    const space = await adminSpace('judged')
    await rejectsWith(proposeDeal(space, input({ count: 0 })), 'Pick how long: 1 to 12 weeks or months.')
    await rejectsWith(proposeDeal(space, input({ count: 13 })), 'Pick how long: 1 to 12 weeks or months.')
    await rejectsWith(proposeDeal(space, input({ reward: '  ' })), 'Fill in what they owe you and what you owe them.')
    await rejectsWith(proposeDeal(space, input({ rewardMode: 'each' })), 'Fill in what each friend owes you, or make it the same for everyone.')
    await rejectsWith(proposeDeal(space, input({ penaltyMode: 'each' })), 'Fill in what you owe each friend, or make it the same for everyone.')
    await rejectsWith(proposeDeal(space, input({ penalty: 'x'.repeat(121) })), 'Keep each one under 120 characters.')
    // The judge isn't a friend in Lena's deal: only Sam.
    const deal = await proposeDeal(space, input())
    expect(deal.friends).toEqual([sam.uid])
  })

  it('fails at once offline', async () => {
    const { db } = getFirebase()
    await as(sam)
    await disableNetwork(db)
    try {
      await rejectsWith(proposeDeal(await adminSpace('judged'), input()), OFFLINE)
    } finally {
      await enableNetwork(db)
    }
  })

  it('two devices proposing at once make one deal', async () => {
    await as(sam)
    const space = await adminSpace('p1')
    const results = await Promise.allSettled([proposeDeal(space, input()), proposeDeal(space, input({ count: 2 }))])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect([DEAL_MSG.lastNotOver, 'Something went wrong. Try again.']).toContain((refused.reason as Error).message)
    expect((await myDeals('p1', sam.uid)).map((d) => d.id)).toEqual([`${sam.uid}_1`])
  })
})

describe('agreeToDeal', () => {
  const id = () => `${lena.uid}_1`
  beforeAll(async () => {
    await seed({ 'spaces/a1': spaceDoc({ ownerId: lena.uid, memberIds: [lena.uid, sam.uid, kim.uid], inviteCode: 'AGREEONE' }) })
    await as(lena)
    await proposeDeal(await adminSpace('a1'), input())
  })

  it('writes your Agree with the server time, once', async () => {
    await as(sam)
    await agreeToDeal(await adminSpace('a1'), id())
    const first = (await adminGet(`spaces/a1/deals/${id()}`))!.agreed[sam.uid] as Timestamp
    expect(first).toBeInstanceOf(Timestamp)
    await agreeToDeal(await adminSpace('a1'), id())
    expect(((await adminGet(`spaces/a1/deals/${id()}`))!.agreed[sam.uid] as Timestamp).isEqual(first)).toBe(true)
  })

  it('not with you; after its start was stamped; its person left; withdrawn; ended', async () => {
    // Ben joined after it was proposed.
    await seed({ 'spaces/a1': spaceDoc({ ownerId: lena.uid, memberIds: [lena.uid, sam.uid, kim.uid, ben.uid], inviteCode: 'AGREEONE', extra: { hasDeals: true } }) })
    await as(ben)
    await rejectsWith(agreeToDeal(await adminSpace('a1'), id()), DEAL_MSG.notWithYou)
    const doc = (await adminGet(`spaces/a1/deals/${id()}`))!
    await seed({ [`spaces/a1/deals/${id()}`]: { ...doc, start: weekIdFor(Date.now() + 7 * DAY, 'UTC') } })
    await as(kim)
    await rejectsWith(agreeToDeal(await adminSpace('a1'), id()), DEAL_MSG.started)
    await seed({
      [`spaces/a1/deals/${id()}`]: doc,
      'spaces/a1': spaceDoc({ ownerId: sam.uid, memberIds: [sam.uid, kim.uid], inviteCode: 'AGREEONE', extra: { hasDeals: true, leftAt: { [lena.uid]: ts(Date.now() - HOUR) } } }),
    })
    await rejectsWith(agreeToDeal(await adminSpace('a1'), id()), 'Lena has left, so this deal won’t start.')
    await seed({
      'spaces/a1': spaceDoc({ ownerId: lena.uid, memberIds: [lena.uid, sam.uid, kim.uid], inviteCode: 'AGREEONE', extra: { hasDeals: true } }),
      [`spaces/a1/deals/${id()}`]: { ...doc, ended: { outcome: 'withdrawn', at: ts(Date.now()), by: lena.uid } },
    })
    await rejectsWith(agreeToDeal(await adminSpace('a1'), id()), DEAL_MSG.withdrawn)
    await seed({ [`spaces/a1/deals/${id()}`]: { ...doc, ended: { outcome: 'off', at: ts(Date.now()), reason: 'called-off' } } })
    await rejectsWith(agreeToDeal(await adminSpace('a1'), id()), DEAL_MSG.ended)
  })

  it('fails at once offline', async () => {
    const { db } = getFirebase()
    await as(kim)
    await disableNetwork(db)
    try {
      await rejectsWith(agreeToDeal(await adminSpace('a1'), id()), OFFLINE)
      await rejectsWith(callOffDeal(await adminSpace('a1'), id()), OFFLINE)
    } finally {
      await enableNetwork(db)
    }
    await as(lena)
    await disableNetwork(db)
    try {
      await rejectsWith(withdrawDeal(await adminSpace('a1'), id()), OFFLINE)
    } finally {
      await enableNetwork(db)
    }
  })
})

describe('withdrawDeal', () => {
  beforeAll(async () => {
    await seed({ 'spaces/w1': spaceDoc({ ownerId: lena.uid, memberIds: [lena.uid, sam.uid, kim.uid], inviteCode: 'WITHDRAW', extra: { hasDeals: true } }) })
  })

  it('takes back a waiting deal; a retry resolves', async () => {
    await seed({ [`spaces/w1/deals/${lena.uid}_1`]: dealDoc(lena.uid, 1, [sam.uid, kim.uid], { agreed: agreedBy(sam.uid) }) })
    await as(lena)
    await withdrawDeal(await adminSpace('w1'), `${lena.uid}_1`)
    const ended = (await adminGet(`spaces/w1/deals/${lena.uid}_1`))!.ended
    expect(ended).toMatchObject({ outcome: 'withdrawn', by: lena.uid })
    expect(ended.at).toBeInstanceOf(Timestamp)
    await withdrawDeal(await adminSpace('w1'), `${lena.uid}_1`)
  })

  it('refused once everyone agreed (a friend who left without agreeing counts as no longer needed); allowed when every friend left', async () => {
    await seed({ [`spaces/w1/deals/${lena.uid}_2`]: dealDoc(lena.uid, 2, [sam.uid, kim.uid], { agreed: agreedBy(sam.uid, kim.uid) }) })
    await as(lena)
    await rejectsWith(withdrawDeal(await adminSpace('w1'), `${lena.uid}_2`), DEAL_MSG.everyoneAgreed)
    // Kim left without agreeing to the next one: Sam's Agree makes it fully agreed.
    await seed({
      [`spaces/w1/deals/${lena.uid}_2`]: dealDoc(lena.uid, 2, [sam.uid, kim.uid], { ended: { outcome: 'withdrawn', at: ts(Date.now()), by: lena.uid } }),
      [`spaces/w1/deals/${lena.uid}_3`]: dealDoc(lena.uid, 3, [sam.uid, kim.uid], { agreed: agreedBy(sam.uid) }),
      'spaces/w1': spaceDoc({ ownerId: lena.uid, memberIds: [lena.uid, sam.uid], inviteCode: 'WITHDRAW', extra: { hasDeals: true, leftAt: { [kim.uid]: ts(Date.now() - HOUR) } } }),
    })
    await rejectsWith(withdrawDeal(await adminSpace('w1'), `${lena.uid}_3`), DEAL_MSG.everyoneAgreed)
    // Everyone else left: nobody is left to agree, so it can be withdrawn.
    await seed({ 'spaces/w1': spaceDoc({ ownerId: lena.uid, memberIds: [lena.uid], inviteCode: 'WITHDRAW', extra: { hasDeals: true } }) })
    await withdrawDeal(await adminSpace('w1'), `${lena.uid}_3`)
    expect((await adminGet(`spaces/w1/deals/${lena.uid}_3`))!.ended.outcome).toBe('withdrawn')
  })
})

describe('callOffDeal', () => {
  const id = () => `${lena.uid}_1`
  const running = () => dealDoc(lena.uid, 1, [sam.uid, kim.uid], { agreed: agreedBy(sam.uid, kim.uid), agreedAt: ts(Date.now() - 2 * DAY), start: lastWeek() })
  beforeAll(async () => {
    await seed({
      'spaces/c1': spaceDoc({ ownerId: lena.uid, memberIds: [lena.uid, sam.uid, kim.uid, ben.uid], inviteCode: 'CALLOFF1', extra: { hasDeals: true } }),
      [`spaces/c1/deals/${lena.uid}_1`]: running(),
    })
  })

  it('its person and a party tap once; anyone else is refused', async () => {
    await as(lena)
    await callOffDeal(await adminSpace('c1'), id())
    const tap = (await adminGet(`spaces/c1/deals/${id()}`))!.off[lena.uid] as Timestamp
    expect(tap).toBeInstanceOf(Timestamp)
    await callOffDeal(await adminSpace('c1'), id())
    expect(((await adminGet(`spaces/c1/deals/${id()}`))!.off[lena.uid] as Timestamp).isEqual(tap)).toBe(true)
    await as(sam)
    await callOffDeal(await adminSpace('c1'), id())
    await as(ben)
    await rejectsWith(callOffDeal(await adminSpace('c1'), id()), DEAL_MSG.notInDeal)
  })

  it('a friend who agreed but left before its start and came back isn’t a party', async () => {
    const lock = weekBounds(lastWeek(), 'UTC').lockAt
    const joinedAt = Object.fromEntries([lena.uid, sam.uid, ben.uid].map((u) => [u, ts(Date.now() - 20 * DAY)]))
    await seed({
      'spaces/c2': spaceDoc({ ownerId: lena.uid, memberIds: [lena.uid, sam.uid, kim.uid, ben.uid], inviteCode: 'CALLOFF2', extra: { hasDeals: true, joinedAt: { ...joinedAt, [kim.uid]: ts(lock + DAY) }, leftAt: { [kim.uid]: ts(lock - DAY) } } }),
      [`spaces/c2/deals/${id()}`]: running(),
    })
    await as(kim)
    await rejectsWith(callOffDeal(await adminSpace('c2'), id()), DEAL_MSG.notInDeal)
  })

  it('an ended deal can’t be called off', async () => {
    await seed({ [`spaces/c1/deals/${id()}`]: { ...running(), ended: { outcome: 'lost', at: ts(Date.now() - HOUR), period: lastWeek(), score: 50 } } })
    await as(kim)
    await rejectsWith(callOffDeal(await adminSpace('c1'), id()), DEAL_MSG.ended)
  })
})

describe('settleDeal', () => {
  const friends = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7']
  beforeAll(async () => {
    await seed({
      'spaces/s7': spaceDoc({ ownerId: lena.uid, memberIds: [lena.uid, ...friends], inviteCode: 'SETTLE77', extra: { hasDeals: true } }),
      [`spaces/s7/deals/${lena.uid}_1`]: dealDoc(lena.uid, 1, friends, {
        agreed: agreedBy(...friends), agreedAt: ts(Date.now() - 2 * DAY), start: lastWeek(), count: 1,
        track: [{ id: lastWeek(), result: 'pass', score: 100 }], ended: { outcome: 'won', at: ts(Date.now() - DAY), period: lastWeek() },
      }),
    })
  })

  it('marks a together line of 7 pairs in one write, and unsettles it', async () => {
    await as(lena)
    await settleDeal(await adminSpace('s7'), `${lena.uid}_1`, friends, true)
    const settled = (await adminGet(`spaces/s7/deals/${lena.uid}_1`))!.settled
    expect(Object.keys(settled).sort()).toEqual(friends)
    for (const f of friends) expect(settled[f]).toMatchObject({ settled: true, by: lena.uid })
    await settleDeal(await adminSpace('s7'), `${lena.uid}_1`, ['f1'], false)
    expect((await adminGet(`spaces/s7/deals/${lena.uid}_1`))!.settled.f1).toMatchObject({ settled: false, by: lena.uid })
  })

  it('queues offline (the check shows at once)', async () => {
    const { db } = getFirebase()
    await as(lena)
    const live = observe(startDeals('s7', lena.uid))
    await live.until((l) => l.data?.ended.length === 1)
    await disableNetwork(db)
    let write: Promise<void> | null = null
    try {
      write = settleDeal(await adminSpace('s7'), `${lena.uid}_1`, ['f1'], true)
      await live.until((l) => l.data?.ended[0].settled.f1?.settled === true)
    } finally {
      await enableNetwork(db)
    }
    await write
    live.stop()
    expect((await adminGet(`spaces/s7/deals/${lena.uid}_1`))!.settled.f1.settled).toBe(true)
  })
})

describe('the deals of a space (useDeals, useDealHistory)', () => {
  beforeAll(async () => {
    const ended = (outcome: string, daysAgo: number, extra: Record<string, unknown> = {}) => ({ outcome, at: ts(Date.now() - daysAgo * DAY), ...extra })
    await seed({
      'spaces/v1': spaceDoc({ ownerId: lena.uid, memberIds: [lena.uid, sam.uid, kim.uid], inviteCode: 'VIEWDEAL', extra: { hasDeals: true, leftAt: { [ben.uid]: ts(Date.now() - DAY) } } }),
      [`spaces/v1/deals/${lena.uid}_1`]: dealDoc(lena.uid, 1, [sam.uid, kim.uid], { ended: ended('won', 10, { period: lastWeek() }) }),
      [`spaces/v1/deals/${lena.uid}_2`]: dealDoc(lena.uid, 2, [sam.uid, kim.uid]),
      [`spaces/v1/deals/${sam.uid}_1`]: dealDoc(sam.uid, 1, [lena.uid, kim.uid], { ended: ended('withdrawn', 1, { by: sam.uid }) }),
      [`spaces/v1/deals/${sam.uid}_2`]: dealDoc(sam.uid, 2, [lena.uid, kim.uid]),
      [`spaces/v1/deals/${sam.uid}_3`]: dealDoc(sam.uid, 3, [lena.uid, kim.uid]),
      [`spaces/v1/deals/${kim.uid}_1`]: dealDoc(kim.uid, 1, [lena.uid, sam.uid], { ended: ended('lost', 70, { period: lastWeek(), score: 40 }) }),
      [`spaces/v1/deals/${kim.uid}_2`]: dealDoc(kim.uid, 2, [lena.uid, sam.uid], { ended: ended('off', 2, { reason: 'called-off' }) }),
      [`spaces/v1/deals/${ben.uid}_1`]: dealDoc(ben.uid, 1, [lena.uid, sam.uid]),
    })
  })

  it('splits the deals in play by person (higher seq kept, former members kept) from the ends of the last 60 days', async () => {
    await as(kim)
    const live = observe(startDeals('v1', kim.uid))
    const { data } = await live.until((l) => l.data !== undefined)
    live.stop()
    expect(Object.fromEntries(Object.entries(data!.open).map(([u, d]) => [u, d.id]))).toEqual({
      [lena.uid]: `${lena.uid}_2`, [sam.uid]: `${sam.uid}_3`, [ben.uid]: `${ben.uid}_1`,
    })
    // Withdrawn left out, older than 60 days left out, newest end first.
    expect(data!.ended.map((d) => d.id)).toEqual([`${kim.uid}_2`, `${lena.uid}_1`])
    expect(recentSince(Date.parse('2026-12-31T15:00:00'))).toBe(new Date(2026, 10, 1).getTime())
  })

  it('Past Deals: the whole collection, by person then newest first', async () => {
    await as(kim)
    const live = observe(startDealHistory('v1'))
    // Its first answer may come from the local cache (the deals an earlier listener saw); the server's has all 8.
    const { data } = await live.until((l) => l.data?.length === 8)
    live.stop()
    expect(data!.filter((d) => d.uid === sam.uid).map((d) => d.seq)).toEqual([3, 2, 1])
    expect(data!.map((d) => d.id).sort()).toEqual(
      [`${lena.uid}_1`, `${lena.uid}_2`, `${sam.uid}_1`, `${sam.uid}_2`, `${sam.uid}_3`, `${kim.uid}_1`, `${kim.uid}_2`, `${ben.uid}_1`].sort(),
    )
  })

  it('reads nothing without hasDeals: the hook answers at once, without loading', async () => {
    await as(kim)
    const probe = ({ space }: { space: Space }) => JSON.stringify(useDeals(space))
    const without = await adminSpace('v1')
    delete without.hasDeals
    expect(JSON.parse(renderToStaticMarkup(createElement(probe, { space: without })).replace(/&quot;/g, '"'))).toEqual({ data: { open: {}, ended: [] }, loading: false, error: null })
    // With it, the hook has a key (loading until its listeners answer).
    expect(JSON.parse(renderToStaticMarkup(createElement(probe, { space: await adminSpace('v1') })).replace(/&quot;/g, '"'))).toMatchObject({ loading: true })
  })

  it('a non-member’s listener is refused with the no-access message', async () => {
    await as(ana)
    const live = observe(startDeals('v1', ana.uid))
    const { error } = await live.until((l) => l.error !== null)
    live.stop()
    expect(error?.message).toBe('You don’t have access to this.')
  })
})

describe('the cutover month (useDealsFrom)', () => {
  /** What the hook reads once the session's read answered (this device's copy may answer first, as loading). */
  const read = async () => {
    const live = observe(startDealsFrom)
    const { data } = await live.until((l) => !l.loading && l.data !== undefined)
    live.stop()
    return data?.month
  }

  it('null without a recorded month; the recorded month; earlier → the floor; malformed → null; one read a session', async () => {
    await as(sam)
    forgetDealsFrom()
    // Nothing recorded (no deal yet): null, so the screens keep the month in progress's stakes (cutoverAt).
    expect(await read()).toBeNull()
    await seed({ 'public/config': { vapidPublicKey: 'k', dealsFrom: '2026-12' } })
    forgetDealsFrom()
    expect(await read()).toBe('2026-12')
    // Read once per session: a later change shows next session.
    await seed({ 'public/config': { vapidPublicKey: 'k', dealsFrom: '2027-01' } })
    expect(await read()).toBe('2026-12')
    await seed({ 'public/config': { vapidPublicKey: 'k', dealsFrom: '2026-10' } })
    forgetDealsFrom()
    expect(await read()).toBe(DEALS_FROM_MONTH)
    for (const bad of ['soon', '2026-13', 202612]) {
      await seed({ 'public/config': { vapidPublicKey: 'k', dealsFrom: bad } })
      forgetDealsFrom()
      expect(await read()).toBeNull()
    }
    forgetDealsFrom()
  })
})

describe('saveStreakRewards', () => {
  beforeAll(async () => {
    await seed({ 'spaces/t1': spaceDoc({ ownerId: lena.uid, memberIds: [lena.uid, sam.uid, kim.uid], inviteCode: 'STREAKS1' }) })
  })

  it('creates, updates and leaves alone the stakes doc, with the house lines; a friend can agree', async () => {
    await as(sam)
    // An old stakes doc with per-friend lines: saving streak rewards resets them to the house stakes.
    await saveMyStakes(await adminSpace('t1'), { rewardMode: 'each', penaltyMode: 'group', reward: '', penalty: 'Tea', per: { [lena.uid]: { reward: 'Lunch', penalty: '' } }, tiers: [] })
    await saveStreakRewards(await adminSpace('t1'), [{ months: 6, reward: ' Weekend away ' }, { months: 3, reward: 'Spa day' }])
    const stored = (await adminGet(`spaces/t1/stakes/${sam.uid}`))!
    expect(stored).toMatchObject({
      rewardMode: 'group', penaltyMode: 'group', reward: 'Dinner on me', penalty: 'Coffee for a week', per: {},
      tiers: [{ months: 3, reward: 'Spa day' }, { months: 6, reward: 'Weekend away' }],
    })
    const at = stored.updatedAt as Timestamp
    await saveStreakRewards(await adminSpace('t1'), [{ months: 3, reward: 'Spa day' }, { months: 6, reward: 'Weekend away' }])
    expect(((await adminGet(`spaces/t1/stakes/${sam.uid}`))!.updatedAt as Timestamp).isEqual(at)).toBe(true)
    await as(kim)
    const stakes = toMemberStakes(await getDocFromServer(doc(getFirebase().db, 'spaces', 't1', 'stakes', sam.uid)))
    await agreeToStakes(await adminSpace('t1'), sam.uid, pairTerms(stakes, kim.uid)!)
    expect((await adminGet(`spaces/t1/stakes/${sam.uid}`))!.agreed[kim.uid].terms.tiers).toHaveLength(2)
    // A first save creates the doc.
    await as(lena)
    await saveStreakRewards(await adminSpace('t1'), [{ months: 2, reward: 'Pizza' }])
    expect(await adminGet(`spaces/t1/stakes/${lena.uid}`)).toMatchObject({ agreed: {}, tiers: [{ months: 2, reward: 'Pizza' }], rewardMode: 'group' })
  })

  it('the stakes editor’s tier messages', async () => {
    await as(sam)
    const space = await adminSpace('t1')
    const tier = (months: number, reward = 'Spa day') => ({ months, reward })
    await rejectsWith(saveStreakRewards(space, [2, 3, 4, 6, 9, 12].map((m) => tier(m))), 'Up to 5 streak rewards.')
    await rejectsWith(saveStreakRewards(space, [tier(3), tier(3, 'Other')]), 'Each streak length can only be used once.')
    await rejectsWith(saveStreakRewards(space, [tier(1)]), 'A streak is 2 to 36 months.')
    await rejectsWith(saveStreakRewards(space, [tier(2, '  ')]), 'Fill in each streak reward.')
    await rejectsWith(saveStreakRewards(space, [tier(2, 'x'.repeat(121))]), 'Keep each one under 120 characters.')
  })
})

describe('leaving and deleting the account', () => {
  it('leaveSpace withdraws a waiting deal first and leaves an agreed one alone', async () => {
    await seed({
      'spaces/l1': spaceDoc({ ownerId: sam.uid, memberIds: [sam.uid, lena.uid, kim.uid], inviteCode: 'LEAVEONE', extra: { hasDeals: true } }),
      'spaces/l2': spaceDoc({ ownerId: sam.uid, memberIds: [sam.uid, lena.uid, kim.uid], inviteCode: 'LEAVETWO', extra: { hasDeals: true } }),
    })
    await as(lena)
    await proposeDeal(await adminSpace('l1'), input())
    await seed({ [`spaces/l2/deals/${lena.uid}_1`]: dealDoc(lena.uid, 1, [sam.uid, kim.uid], { agreed: agreedBy(sam.uid, kim.uid), agreedAt: ts(Date.now() - 2 * DAY), start: lastWeek() }) })
    await leaveSpace('l1')
    await leaveSpace('l2')
    expect((await adminGet(`spaces/l1/deals/${lena.uid}_1`))!.ended).toMatchObject({ outcome: 'withdrawn', by: lena.uid })
    expect((await adminGet(`spaces/l2/deals/${lena.uid}_1`))!.ended).toBeNull()
    expect((await adminGet('spaces/l1'))!.memberIds).not.toContain(lena.uid)
  })

  it('deleteMyAccount withdraws a waiting deal, leaves an agreed one, deletes none; nothing of yours asks anyone to agree', async () => {
    const zed = await createUser('Zed')
    await seed({
      'spaces/d1': spaceDoc({ ownerId: sam.uid, memberIds: [sam.uid, zed.uid, kim.uid], inviteCode: 'DELETE01', extra: { hasDeals: true } }),
      'spaces/d2': spaceDoc({ ownerId: sam.uid, memberIds: [sam.uid, zed.uid], inviteCode: 'DELETE02', extra: { hasDeals: true } }),
    })
    await as(zed)
    await proposeDeal(await adminSpace('d1'), input())
    await seed({ [`spaces/d2/deals/${zed.uid}_1`]: dealDoc(zed.uid, 1, [sam.uid], { agreed: agreedBy(sam.uid), agreedAt: ts(Date.now() - 2 * DAY), start: lastWeek() }) })
    await deleteMyAccount('secret123')
    expect((await adminGet(`spaces/d1/deals/${zed.uid}_1`))!.ended).toMatchObject({ outcome: 'withdrawn', by: zed.uid })
    expect((await adminGet(`spaces/d2/deals/${zed.uid}_1`))!.ended).toBeNull()
    expect((await adminGet('spaces/d1'))!.memberIds).not.toContain(zed.uid)
    // A friend's view: no deal of Zed's waits for an Agree (the agreed one has its start; the other is withdrawn).
    await as(sam)
    for (const spaceId of ['d1', 'd2']) {
      for (const d of await myDeals(spaceId, zed.uid)) expect(d.ended !== null || d.start !== undefined).toBe(true)
    }
    expect(dealId(zed.uid, 1)).toBe(`${zed.uid}_1`)
  })
})
