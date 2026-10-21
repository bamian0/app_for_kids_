// Shared goals (SPEC §11.3, §11.8) against the emulators and the real rules, through the functions the screens call:
// creating with invitations, joining and declining, weekly check-ins with exact totals, the hour of slack after a
// week ends, reaching the target, finishing and leaving; and account deletion (§11.12).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { disableNetwork, enableNetwork } from 'firebase/firestore'
import {
  askFriend,
  cancelFriendRequest,
  cancelSharedInvite,
  checkIn,
  createSharedGoal,
  declineSharedGoal,
  deleteMyAccount,
  editSharedGoal,
  finishSharedGoal,
  inviteToSharedGoal,
  joinSharedGoal,
  leaveSharedGoal,
  setShowcaseSwitch,
} from '../../src/data/api.ts'
import { startFriendships, startMyFriendCode } from '../../src/data/friends.ts'
import { leaveAllSharedGoals, startCheckins, startSharedGoal, startSharedGoals } from '../../src/data/shared.ts'
import { hideShowcase, startShowcase, startStats } from '../../src/data/showcase.ts'
import { deviceTimeZone } from '../../src/data/spaces.ts'
import { now } from '../../src/domain/clock.ts'
import { pairId } from '../../src/domain/friends.ts'
import { goalWeek } from '../../src/domain/shared.ts'
import { addWeeks, weekIdFor } from '../../src/domain/time.ts'
import type { SharedGoal } from '../../src/domain/types.ts'
import { getFirebase } from '../../src/firebase/app.ts'
import {
  adminGet,
  adminList,
  as,
  createUser,
  DAY,
  HOUR,
  loadRules,
  observe,
  PASSWORD,
  rejectsWith,
  resetClock,
  RULES,
  seed,
  setClock,
  setupEmulators,
  teardownEmulators,
  ts,
  type TestUser,
} from './helpers.ts'

const OFFLINE = 'You’re offline. Check your connection and try again.'
const MSG = {
  onlyFriends: 'You can only invite friends.',
  full: 'A shared goal has room for 8 people.',
  ended: 'This goal has ended.',
  finished: 'This goal is finished.',
  notIn: 'You’re not in this goal anymore.',
  inviteGone: 'This invitation is no longer there.',
  weekEnded: 'That week just ended. Check in for this week instead.',
}
const MIN = 60_000

let ana: TestUser
let ben: TestUser
let cleo: TestUser
let dan: TestUser
let zed: TestUser

/** Friendship pairs as stored, for seeding. */
function friends(a: TestUser, b: TestUser, state = 'friends', by = a, at = Date.now() - 10 * DAY) {
  return { [`friends/${pairId(a.uid, b.uid)}`]: { users: [a.uid, b.uid].sort(), by: by.uid, state, at: ts(at) } }
}

beforeAll(async () => {
  await setupEmulators()
  ana = await createUser('Ana')
  ben = await createUser('Ben')
  cleo = await createUser('Cleo')
  dan = await createUser('Dan')
  zed = await createUser('Zed')
  await seed({ ...friends(ana, ben), ...friends(ana, cleo), ...friends(ana, dan), ...friends(ben, cleo) })
})
afterAll(teardownEmulators)

const goalPath = (id: string) => `sharedGoals/${id}`
const checkinsPath = (id: string) => `sharedGoals/${id}/checkins`

/** The goal as `user` sees it with a listener, once the server has answered (the predicate). */
async function goalAs(user: TestUser, id: string, ready: (g: SharedGoal | null) => boolean = () => true): Promise<SharedGoal | null> {
  await as(user)
  const live = observe(startSharedGoal(id))
  const state = await live.until((l) => l.data !== undefined && ready(l.data))
  live.stop()
  return state.data ?? null
}

/**
 * The real rules with `request.time` read as `offsetMs` later, except where a time must equal the request's own (a
 * server timestamp: `== request.time`, `'at': request.time`, `? request.time`), which stays real. The emulator's clock
 * can't move: this is how a check-in runs at another moment of the week (with setClock moved by the same offset).
 */
function goalRules(offsetMs: number): string {
  const secs = Math.round(offsetMs / 1000)
  const shifted = secs >= 0 ? `(request.time + duration.value(${secs}, 's'))` : `(request.time - duration.value(${-secs}, 's'))`
  return RULES.replace(/(==\s*|'at':\s*|\?\s*)?request\.time/g, (match: string, keep: string | undefined) => (keep ? match : shifted))
}

async function travelTo(ms: number): Promise<void> {
  await loadRules(goalRules(ms - Date.now()))
  setClock(ms)
}

async function travelBack(): Promise<void> {
  await loadRules(RULES)
  resetClock()
}

describe('creating, inviting, joining', () => {
  let goalId = ''

  it('creates a goal in this device\'s zone, inviting friends only', async () => {
    await as(ana)
    await rejectsWith(createSharedGoal({ name: 'Run', unit: 'km', target: 100, endsOn: null, invite: [zed.uid] }), MSG.onlyFriends)
    await rejectsWith(createSharedGoal({ name: 'Run', unit: 'km', target: 100, endsOn: null, invite: Array.from({ length: 8 }, (_, i) => `u${i}`) }), MSG.full)
    await rejectsWith(createSharedGoal({ name: '  ', unit: 'km', target: 100, endsOn: null, invite: [] }), 'Give the goal a name.')
    await rejectsWith(createSharedGoal({ name: 'Run', unit: '', target: 100, endsOn: null, invite: [] }), 'Add a unit, like km or books.')
    await rejectsWith(createSharedGoal({ name: 'Run', unit: 'km', target: 0, endsOn: null, invite: [] }), 'Enter a target above 0.')
    expect(await adminList('sharedGoals')).toEqual([])

    goalId = await createSharedGoal({ name: ' Run 100 km ', unit: 'km', target: 100, endsOn: null, invite: [ben.uid, cleo.uid, ben.uid] })
    const d = await adminGet(goalPath(goalId))
    const zone = deviceTimeZone()
    expect(d).toMatchObject({
      name: 'Run 100 km', unit: 'km', target100: 10_000, endsOn: null, timezone: zone, zones: { [ana.uid]: zone },
      ownerId: ana.uid, createdBy: ana.uid, memberIds: [ana.uid], invited: [ben.uid, cleo.uid], leftAt: {}, totals100: {}, total100: 0,
      last: null, reachedAt: null, archivedAt: null,
    })
    expect(Object.keys(d!)).toHaveLength(19)
    // Ana's goals and Ben's invitations.
    const mine = observe(startSharedGoals(ana.uid))
    expect((await mine.until((l) => (l.data?.goals.length ?? 0) === 1)).data!.goals[0]).toMatchObject({ id: goalId, name: 'Run 100 km', target: 100, total: 0 })
    mine.stop()
    await as(ben)
    const invites = observe(startSharedGoals(ben.uid))
    expect((await invites.until((l) => (l.data?.invites.length ?? 0) === 1)).data).toMatchObject({ goals: [], invites: [{ id: goalId }] })
    invites.stop()
  })

  it('an invitee joins (with their zone) or declines; the owner cancels and adds invitations', async () => {
    await as(ben)
    await joinSharedGoal(goalId)
    // Joining again resolves.
    await joinSharedGoal(goalId)
    let d = await adminGet(goalPath(goalId))
    expect(d).toMatchObject({ memberIds: [ana.uid, ben.uid], invited: [cleo.uid], zones: { [ana.uid]: deviceTimeZone(), [ben.uid]: deviceTimeZone() } })
    expect(d!.joinedAt[ben.uid]).toBeDefined()
    // Cleo declines; Ana invites her again, and Dan; then cancels Dan's.
    await as(cleo)
    await declineSharedGoal(goalId)
    await declineSharedGoal(goalId)
    expect((await adminGet(goalPath(goalId)))!.invited).toEqual([])
    await rejectsWith(joinSharedGoal(goalId), MSG.inviteGone)
    await as(ana)
    await rejectsWith(inviteToSharedGoal(goalId, [zed.uid]), MSG.onlyFriends)
    await inviteToSharedGoal(goalId, [cleo.uid, dan.uid, ben.uid])
    expect((await adminGet(goalPath(goalId)))!.invited).toEqual([cleo.uid, dan.uid])
    await cancelSharedInvite(goalId, dan.uid)
    await cancelSharedInvite(goalId, dan.uid)
    d = await adminGet(goalPath(goalId))
    expect(d!.invited).toEqual([cleo.uid])
    await as(dan)
    await rejectsWith(joinSharedGoal(goalId), MSG.inviteGone)
    // Only the owner invites.
    await as(ben)
    await rejectsWith(inviteToSharedGoal(goalId, [cleo.uid]), 'Couldn’t do that. Try again.')
    await as(cleo)
    await joinSharedGoal(goalId)
    expect((await adminGet(goalPath(goalId)))!.memberIds).toEqual([ana.uid, ben.uid, cleo.uid])
  })

  it('a goal has room for 8 people', async () => {
    await seed({ [goalPath('full8')]: storedGoal({ memberIds: [ana.uid, 'p1', 'p2', 'p3', 'p4', 'p5', 'p6'], invited: ['p7'] }) })
    await as(ana)
    await rejectsWith(inviteToSharedGoal('full8', [dan.uid]), MSG.full)
  })
})

/** A goal as stored (seeded): Ana owns it, the given fields over these. */
function storedGoal(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const joined = ts(Date.now() - 5 * DAY)
  return {
    name: 'Read 20 books', unit: 'books', target100: 2000, endsOn: null, timezone: 'Asia/Tokyo', utcOffsetMin: 540,
    zones: { [ana.uid]: 'Asia/Tokyo' }, ownerId: ana.uid, createdBy: ana.uid, memberIds: [ana.uid], invited: [],
    joinedAt: { [ana.uid]: joined }, leftAt: {}, totals100: {}, total100: 0, last: null, reachedAt: null, archivedAt: null,
    createdAt: joined, ...extra,
  }
}

describe('checking in', () => {
  let goalId = ''

  it('checks in and edits this week\'s number; totals stay exact with decimals', async () => {
    await as(ana)
    goalId = await createSharedGoal({ name: 'Swim', unit: 'km', target: 1, endsOn: null, invite: [ben.uid] })
    await as(ben)
    await joinSharedGoal(goalId)
    const week = goalWeek({ timezone: deviceTimeZone() }, now())
    expect(await checkIn(goalId, 0.1, 'Short swim')).toEqual({ total: 0.1, reached: false })
    await as(ana)
    expect(await checkIn(goalId, 0.2, '  Pool\nwas cold  ')).toEqual({ total: 0.3, reached: false })
    let d = await adminGet(goalPath(goalId))
    expect(d).toMatchObject({ totals100: { [ana.uid]: 20, [ben.uid]: 10 }, total100: 30, last: { by: ana.uid, weekId: week }, reachedAt: null })
    expect(await adminGet(`${checkinsPath(goalId)}/${week}_${ana.uid}`)).toMatchObject({ uid: ana.uid, weekId: week, amount100: 20, note: 'Pool was cold' })
    const goal = await goalAs(ana, goalId, (g) => g?.total === 0.3)
    expect(goal).toMatchObject({ total: 0.3, totals: { [ana.uid]: 0.2, [ben.uid]: 0.1 } })
    // An edit replaces it: the total moves by the difference.
    expect(await checkIn(goalId, 0.05, '')).toEqual({ total: 0.15, reached: false })
    d = await adminGet(goalPath(goalId))
    expect(d).toMatchObject({ totals100: { [ana.uid]: 5, [ben.uid]: 10 }, total100: 15 })
    // The week's check-ins, for members.
    const live = observe(startCheckins(goalId, week))
    const list = (await live.until((l) => (l.data?.length ?? 0) === 2 && l.data!.some((c) => c.amount === 0.05))).data!
    live.stop()
    expect(list.map((c) => [c.uid === ana.uid ? 'ana' : 'ben', c.amount, c.note]).sort()).toEqual([['ana', 0.05, ''], ['ben', 0.1, 'Short swim']])
    // Not for anyone else.
    await as(zed)
    const stranger = observe(startCheckins(goalId, week))
    expect(await stranger.until((l) => !l.loading && (l.data?.length ?? 0) === 0)).toEqual({ data: [], loading: false, error: null })
    stranger.stop()
  })

  it('refuses amounts and notes the rules wouldn\'t take', async () => {
    await as(ana)
    await rejectsWith(checkIn(goalId, -1, ''), 'Enter 0 or more.')
    await rejectsWith(checkIn(goalId, Number.NaN, ''), 'Use a number, like 12.5.')
    await rejectsWith(checkIn(goalId, 2e9, ''), 'That number is too big.')
    await rejectsWith(checkIn(goalId, 1, 'x'.repeat(81)), 'Keep the note to 80 characters.')
  })

  it('reaching the target sets reachedAt; raising the target clears it; an edit below clears it too', async () => {
    await as(ben)
    expect(await checkIn(goalId, 0.95, 'Long swim')).toEqual({ total: 1, reached: true })
    let d = await adminGet(goalPath(goalId))
    expect(d!.total100).toBe(100)
    const reachedAt = d!.reachedAt
    expect(reachedAt).not.toBeNull()
    // Staying reached keeps it.
    expect(await checkIn(goalId, 1, 'Even longer')).toEqual({ total: 1.05, reached: false })
    expect((await adminGet(goalPath(goalId)))!.reachedAt.isEqual(reachedAt)).toBe(true)
    // Keep Going: a higher target clears it.
    await as(ana)
    await editSharedGoal(goalId, { target: 2 })
    d = await adminGet(goalPath(goalId))
    expect(d).toMatchObject({ target100: 200, reachedAt: null })
    // Lowering it to the total reaches it again.
    await editSharedGoal(goalId, { target: 1.05, name: 'Swim 1 km', endsOn: '2099-12-31' })
    d = await adminGet(goalPath(goalId))
    expect(d).toMatchObject({ name: 'Swim 1 km', target100: 105, endsOn: '2099-12-31' })
    expect(d!.reachedAt).not.toBeNull()
    // An edit of a check-in below the target clears it.
    await as(ben)
    expect(await checkIn(goalId, 0.5, '')).toEqual({ total: 0.55, reached: false })
    expect((await adminGet(goalPath(goalId)))!.reachedAt).toBeNull()
    // Only the owner edits.
    await rejectsWith(editSharedGoal(goalId, { target: 5 }), 'Couldn’t do that. Try again.')
    await as(ana)
    await rejectsWith(editSharedGoal(goalId, { unit: '' }), 'Add a unit, like km or books.')
  })

  it('the week the sheet opened on can still be saved for an hour after it ends; then it says so', async () => {
    // Tokyo has no DST: its week ends exactly at the stored anchor + 7 days.
    await seed({
      [goalPath('tokyo')]: storedGoal({ memberIds: [ana.uid, ben.uid], joinedAt: { [ana.uid]: ts(Date.now() - 5 * DAY), [ben.uid]: ts(Date.now() - 4 * DAY) } }),
    })
    await as(ben)
    const week = weekIdFor(now(), 'Asia/Tokyo')
    expect(await checkIn('tokyo', 2.5, 'Two and a half')).toEqual({ total: 2.5, reached: false })
    const anchor = Date.parse(`${week}T00:00:00Z`) - 540 * MIN
    try {
      await travelTo(anchor + 7 * DAY + 30 * MIN)
      // Now it is next week in Tokyo, but the sheet still shows last week: that week's number is replaced.
      expect(goalWeek({ timezone: 'Asia/Tokyo' }, now())).toBe(addWeeks(week, 1))
      expect(await checkIn('tokyo', 4, 'Four in all', week)).toEqual({ total: 4, reached: false })
      expect(await adminGet(goalPath('tokyo'))).toMatchObject({ totals100: { [ben.uid]: 400 }, total100: 400, last: { weekId: week } })
      expect((await adminGet(`${checkinsPath('tokyo')}/${week}_${ben.uid}`))?.amount100).toBe(400)

      await travelTo(anchor + 7 * DAY + 61 * MIN)
      await rejectsWith(checkIn('tokyo', 5, '', week), MSG.weekEnded)
      // This week's check-in is a new one.
      expect(await checkIn('tokyo', 1, 'New week')).toEqual({ total: 5, reached: false })
      expect((await adminGet(`${checkinsPath('tokyo')}/${addWeeks(week, 1)}_${ben.uid}`))?.amount100).toBe(100)
    } finally {
      await travelBack()
    }
  })

  it('says why when a goal has ended, is finished, or you aren\'t in it', async () => {
    const yesterday = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10)
    await seed({
      [goalPath('ended')]: storedGoal({ timezone: 'UTC', utcOffsetMin: 0, endsOn: yesterday, memberIds: [ana.uid, ben.uid], invited: [cleo.uid] }),
      [goalPath('done')]: storedGoal({ archivedAt: ts(Date.now() - HOUR), memberIds: [ana.uid] }),
    })
    await as(ana)
    await rejectsWith(checkIn('ended', 1, ''), MSG.ended)
    await rejectsWith(checkIn('done', 1, ''), MSG.finished)
    await rejectsWith(inviteToSharedGoal('done', [dan.uid]), MSG.finished)
    await rejectsWith(editSharedGoal('done', { target: 3 }), MSG.finished)
    // Finishing a finished goal resolves.
    await finishSharedGoal('done')
    await as(cleo)
    await rejectsWith(joinSharedGoal('ended'), MSG.ended)
    // Declining still works.
    await declineSharedGoal('ended')
    await as(zed)
    await rejectsWith(checkIn('tokyo', 1, ''), MSG.notIn)
    await rejectsWith(checkIn('nothere', 1, ''), MSG.notIn)
    await rejectsWith(checkIn('bad_id', 1, ''), MSG.notIn)
    await rejectsWith(finishSharedGoal('tokyo'), MSG.notIn)
    expect(await goalAs(zed, 'tokyo', (g) => g === null)).toBeNull()
  })

  it('every shared-goal write fails at once offline', async () => {
    await as(ana)
    const { db } = getFirebase()
    await disableNetwork(db)
    try {
      await rejectsWith(createSharedGoal({ name: 'Offline', unit: 'km', target: 5, endsOn: null, invite: [] }), OFFLINE)
      await rejectsWith(checkIn(goalId, 1, ''), OFFLINE)
      await rejectsWith(inviteToSharedGoal(goalId, [dan.uid]), OFFLINE)
      await rejectsWith(cancelSharedInvite(goalId, dan.uid), OFFLINE)
      await rejectsWith(joinSharedGoal(goalId), OFFLINE)
      await rejectsWith(declineSharedGoal(goalId), OFFLINE)
      await rejectsWith(editSharedGoal(goalId, { target: 9 }), OFFLINE)
      await rejectsWith(finishSharedGoal(goalId), OFFLINE)
      await rejectsWith(leaveSharedGoal(goalId), OFFLINE)
    } finally {
      await enableNetwork(db)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect((await adminGet(goalPath(goalId)))!.archivedAt).toBeNull()
  })
})

describe('finishing and leaving', () => {
  it('the owner finishes: check-ins stop, invitations go', async () => {
    await as(ana)
    const id = await createSharedGoal({ name: 'Books', unit: 'books', target: 20, endsOn: null, invite: [ben.uid, cleo.uid] })
    await as(ben)
    await joinSharedGoal(id)
    await rejectsWith(finishSharedGoal(id), 'Couldn’t do that. Try again.')
    await as(ana)
    await finishSharedGoal(id)
    const d = await adminGet(goalPath(id))
    expect(d!.archivedAt).not.toBeNull()
    expect(d!.invited).toEqual([])
    await rejectsWith(checkIn(id, 1, ''), MSG.finished)
  })

  it('an owner who leaves hands on to the earliest-joined member; the leaver\'s check-ins go, their part stays', async () => {
    await as(ana)
    const id = await createSharedGoal({ name: 'Walk', unit: 'km', target: 50, endsOn: null, invite: [ben.uid, cleo.uid] })
    await as(cleo)
    await joinSharedGoal(id)
    await as(ben)
    await joinSharedGoal(id)
    await as(ana)
    await checkIn(id, 7, 'Mine')
    const week = goalWeek({ timezone: deviceTimeZone() }, now())
    expect(await adminList(checkinsPath(id))).toEqual([`${week}_${ana.uid}`])
    await leaveSharedGoal(id)
    // Leaving again resolves.
    await leaveSharedGoal(id)
    const d = await adminGet(goalPath(id))
    expect(d).toMatchObject({ ownerId: cleo.uid, memberIds: [cleo.uid, ben.uid], totals100: { [ana.uid]: 700 }, total100: 700, archivedAt: null })
    expect(d!.joinedAt[ana.uid]).toBeUndefined()
    expect(d!.leftAt[ana.uid]).toBeDefined()
    expect(await adminList(checkinsPath(id))).toEqual([])
    // Ana can't read it any more; Cleo, the new owner, edits it.
    expect(await goalAs(ana, id, (g) => g === null)).toBeNull()
    await as(cleo)
    await editSharedGoal(id, { name: 'Walk 50 km' })
    // The last one out finishes it.
    await leaveSharedGoal(id)
    await as(ben)
    await leaveSharedGoal(id)
    const last = await adminGet(goalPath(id))
    expect(last).toMatchObject({ memberIds: [], invited: [], ownerId: ben.uid, total100: 700 })
    expect(last!.archivedAt).not.toBeNull()
  })
})

describe('account deletion', () => {
  it('cleans up everything batch 3 holds, and friends\' screens still load', async () => {
    const eve = await createUser('Eve')
    await seed({
      ...friends(ana, eve),
      ...friends(cleo, eve, 'asked', cleo),
      [`rings/${eve.uid}`]: { monthId: '2026-10', score: 80, final: false, spaces: 1, updatedAt: ts(Date.now()) },
      [`stats/${eve.uid}`]: { monthsCleared: 0, currentStreak: 0, bestStreak: 0, weeksPlayed: 2, finishedMonths: 0, since: '2026-10', updatedAt: ts(Date.now()) },
      [`scores/${eve.uid}`]: { months: {}, updatedAt: ts(Date.now()) },
    })
    await as(eve)
    // Her own pending request and her own tombstone (within its 30 days).
    await askFriend(zed.uid)
    await askFriend(dan.uid)
    await cancelFriendRequest(dan.uid)
    const codes = observe(startMyFriendCode(eve.uid))
    const code = (await codes.until((l) => l.data !== undefined)).data!
    codes.stop()
    await setShowcaseSwitch('earnings', true, { achieved: [], goals: [], earnings: { monthId: '2026-09', amount: 12, currency: 'USD' } })
    // A goal she owns with Ana in it, one she's alone in, and an invitation.
    const shared = await createSharedGoal({ name: 'Together', unit: 'km', target: 100, endsOn: null, invite: [ana.uid] })
    const alone = await createSharedGoal({ name: 'Alone', unit: 'km', target: 10, endsOn: null, invite: [] })
    await as(ana)
    await joinSharedGoal(shared)
    const invite = await createSharedGoal({ name: 'Invite', unit: 'km', target: 10, endsOn: null, invite: [eve.uid] })
    await as(eve)
    await checkIn(shared, 12, 'My part')
    expect(await adminList(checkinsPath(shared))).toHaveLength(1)

    await deleteMyAccount(PASSWORD)

    expect(await adminGet(`users/${eve.uid}`)).toBeUndefined()
    expect(await adminGet(goalPath(shared))).toMatchObject({ ownerId: ana.uid, memberIds: [ana.uid], totals100: { [eve.uid]: 1200 }, total100: 1200 })
    expect(await adminList(checkinsPath(shared))).toEqual([])
    expect((await adminGet(goalPath(alone)))!.archivedAt).not.toBeNull()
    expect((await adminGet(goalPath(invite)))!.invited).toEqual([])
    for (const other of [ana, cleo, zed, dan]) expect(await adminGet(`friends/${pairId(eve.uid, other.uid)}`)).toBeUndefined()
    expect(await adminGet(`friendCodes/${code}`)).toBeUndefined()
    for (const name of ['rings', 'stats', 'scores', 'showcases']) expect(await adminGet(`${name}/${eve.uid}`)).toBeUndefined()

    // Ana's screens: her friends and the goal load, with Eve as a former member.
    await as(ana)
    const view = observe(startFriendships(ana.uid))
    expect((await view.until((l) => l.data !== undefined && !l.data.friends.some((p) => p.uid === eve.uid))).error).toBeNull()
    view.stop()
    const goal = await goalAs(ana, shared, (g) => g !== null && !g.memberIds.includes(eve.uid))
    expect(goal).toMatchObject({ ownerId: ana.uid, memberIds: [ana.uid], totals: { [eve.uid]: 12 }, total: 12 })
  })

  it('stopped after leaving the goals, strangers already see nothing', async () => {
    const fay = await createUser('Fay')
    await seed({ [`stats/${fay.uid}`]: { monthsCleared: 3, currentStreak: 3, bestStreak: 3, weeksPlayed: 12, finishedMonths: 3, since: '2026-10', updatedAt: ts(Date.now()) } })
    await setShowcaseSwitch('earnings', true, { achieved: [], goals: [], earnings: { monthId: '2026-09', amount: 99, currency: 'USD' } })
    // Steps 1 and 2 of §11.12, then it stops.
    await hideShowcase(fay.uid)
    await leaveAllSharedGoals(fay.uid)
    await as(zed)
    const stats = observe(startStats(fay.uid))
    expect(await stats.until((l) => l.data === null)).toEqual({ data: null, loading: false, error: null })
    stats.stop()
    const showcase = observe(startShowcase(zed.uid, fay.uid))
    const seen = (await showcase.until((l) => l.data !== undefined && l.data !== null && l.data.show.earnings === false)).data!
    showcase.stop()
    expect(seen.show).toEqual({ stats: false, achieved: false, goals: false, earnings: false })
    expect(seen.earnings).toBeUndefined()
  })
})
