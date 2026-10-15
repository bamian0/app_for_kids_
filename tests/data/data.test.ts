// Data layer against the emulators, through the same functions the screens call.
// One scenario, in order: accounts -> spaces -> weeks -> reviews -> months -> account deletion.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { arrayRemove, collection, disableNetwork, doc, enableNetwork, getDocs, updateDoc } from 'firebase/firestore'
import {
  createSpace,
  deleteMyAccount,
  ensureSpace,
  joinSpace,
  joinWeek,
  leaveSpace,
  lookupInvite,
  removeMember,
  resetInviteCode,
  savePlan,
  sendPasswordReset,
  setTaskDone,
  settlePairs,
  signIn,
  signOut,
  signUp,
  submitReviews,
  updateMyName,
  updateSpace,
} from '../../src/data/api.ts'
import type { Live } from '../../src/data/api.ts'
import { mergeProfiles, startProfile } from '../../src/data/auth.ts'
import { monthListCounts, startMonthData } from '../../src/data/monthly.ts'
import { startMonthStakes } from '../../src/data/months.ts'
import { authState } from '../../src/data/session.ts'
import { startSettlements } from '../../src/data/settlements.ts'
import { startMySpaces, startSpace } from '../../src/data/spaces.ts'
import { combine, peek, watch } from '../../src/data/store.ts'
import { startWeek } from '../../src/data/weeks.ts'
import { now } from '../../src/domain/clock.ts'
import { computeMonth, computeWeek, membersAt, reviewTargets } from '../../src/domain/scoring.ts'
import { colorForUid, formatInviteCode } from '../../src/domain/ids.ts'
import { addWeeks, monthIdForWeek, utcOffsetMinutes, weekBounds, weekIdFor, weekIdsInMonth } from '../../src/domain/time.ts'
import type { Space, WeekData } from '../../src/domain/types.ts'
import { getFirebase } from '../../src/firebase/app.ts'
import {
  adminGet,
  adminSpace,
  adminWeekData,
  as,
  createBareAccount,
  createUser,
  DAY,
  eventually,
  HOUR,
  observe,
  PASSWORD,
  rejectsWith,
  resetClock,
  seed,
  setClock,
  setupEmulators,
  teardownEmulators,
  ts,
  weekDoc,
  type TestUser,
} from './helpers.ts'

const CLOSED = 'You can’t change this anymore.'
/** Seeded in its review window; everyone submits, so it ends up revealed. */
const REVIEW_WEEK = '2026-09-21'

let alex: TestUser
let sam: TestUser
let kim: TestUser
let lee: TestUser
let space: Space

const OFFLINE = 'You’re offline. Check your connection and try again.'

/** Every state a subscription emits, for checking that none of them was wrong on the way. */
function record<T>(start: (emit: (next: Live<T>) => void) => () => void) {
  const states: Live<T>[] = []
  const stop = start((next) => states.push(next))
  return { states, stop }
}

const thisWeek = () => weekIdFor(now(), space.timezone)
const weekPath = (weekId: string) => `spaces/${space.id}/weeks/${weekId}`

beforeAll(setupEmulators)
afterAll(teardownEmulators)

describe('accounts', () => {
  it('signs up users with a profile doc', async () => {
    alex = await createUser('Alex')
    sam = await createUser('Sam')
    kim = await createUser('Kim')
    lee = await createUser('Lee')
    const profile = await adminGet(`users/${alex.uid}`)
    expect(profile).toMatchObject({ name: 'Alex', color: colorForUid(alex.uid) })
    expect(profile?.createdAt.toMillis()).toBeGreaterThan(Date.now() - 60_000)
  })

  it('turns auth errors into short messages', async () => {
    await signOut()
    await rejectsWith(signUp('Alex', alex.email, PASSWORD), 'An account with this email already exists. Try signing in.')
    await rejectsWith(signUp('Pat', 'pat@example.com', '12345'), 'Use at least 6 characters for your password.')
    await rejectsWith(signUp('Pat', 'not-an-email', PASSWORD), 'That email address doesn’t look right.')
    await rejectsWith(signUp('   ', 'pat@example.com', PASSWORD), "Name can't be empty.")
    await rejectsWith(signIn(alex.email, 'wrong-password'), 'Wrong email or password.')
    await rejectsWith(signIn('nobody@example.com', PASSWORD), 'Wrong email or password.')
  })

  it('a password reset for an unknown email looks the same as for a known one', async () => {
    await signOut()
    await expect(sendPasswordReset('nobody@example.com')).resolves.toBeUndefined()
    await expect(sendPasswordReset(alex.email)).resolves.toBeUndefined()
  })

  it('creates the missing profile of an older account on sign-in', async () => {
    const uid = await createBareAccount('old.timer@example.com', PASSWORD)
    await signIn('old.timer@example.com', PASSWORD)
    expect(await adminGet(`users/${uid}`)).toMatchObject({ name: 'old.timer', color: colorForUid(uid) })
  })

  it('publishes the signed-in user with a live profile', async () => {
    await as(alex)
    await eventually(() => authState.get().status === 'signedIn' && authState.get().profile?.name === 'Alex')
    expect(authState.get()).toMatchObject({ uid: alex.uid, email: alex.email })
    await updateMyName('Alex R.')
    await eventually(() => authState.get().profile?.name === 'Alex R.')
    await updateMyName('Alex')
    await signOut()
    await eventually(() => authState.get().status === 'signedOut')
  })
})

describe('spaces', () => {
  it('creates a space and its invite', async () => {
    await as(alex)
    space = await createSpace({ name: '  Film crew ', reward: 'Dinner on me', penalty: 'Coffee for a week' })
    expect(space).toMatchObject({ name: 'Film crew', ownerId: alex.uid, memberIds: [alex.uid], threshold: 90, latePenalty: 5 })
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: space.timezone })).not.toThrow()
    const stored = await adminGet(`spaces/${space.id}`)
    const utcOffsetMin = utcOffsetMinutes(space.timezone, Date.now())
    expect(stored).toMatchObject({ name: 'Film crew', memberIds: [alex.uid], inviteCode: space.inviteCode, timezone: space.timezone, utcOffsetMin })
    expect(space.utcOffsetMin).toBe(utcOffsetMin)
    expect(Object.keys(stored?.joinedAt)).toEqual([alex.uid])
    expect(await adminGet(`invites/${space.inviteCode}`)).toMatchObject({
      spaceId: space.id, spaceName: 'Film crew', reward: 'Dinner on me', penalty: 'Coffee for a week', inviterName: 'Alex', createdBy: alex.uid,
    })
  })

  it('refuses to create a space offline instead of queueing it, and never creates one twice', async () => {
    await as(alex)
    const mine = observe(startMySpaces(alex.uid))
    await mine.until((l) => l.data?.length === 1)
    const { db } = getFirebase()
    await disableNetwork(db)
    try {
      const started = Date.now()
      await rejectsWith(createSpace({ name: 'Offline crew', reward: 'r', penalty: 'p' }), OFFLINE)
      expect(Date.now() - started).toBeLessThan(9_000)
    } finally {
      await enableNetwork(db)
    }
    // Tap, cancel, tap again: one space.
    const input = { name: 'Twice', reward: 'r', penalty: 'p' }
    const [first, second] = await Promise.all([createSpace(input), createSpace(input)])
    expect(second.id).toBe(first.id)
    const after = await mine.until((l) => l.data?.length === 2)
    expect(after.data?.map((s) => s.name).sort()).toEqual(['Film crew', 'Twice'])
    mine.stop()
  })

  it('validates space text before writing', async () => {
    await rejectsWith(createSpace({ name: ' ', reward: 'a', penalty: 'b' }), "Space name can't be empty.")
    await rejectsWith(createSpace({ name: 'x'.repeat(41), reward: 'a', penalty: 'b' }), 'Space name is too long (40 characters max).')
  })

  it('looks up invites by code, formatted code or link', async () => {
    await as(sam)
    const expected = { code: space.inviteCode, spaceId: space.id, spaceName: 'Film crew', inviterName: 'Alex' }
    expect(await lookupInvite(formatInviteCode(space.inviteCode).toLowerCase())).toMatchObject(expected)
    expect(await lookupInvite(`https://example.github.io/app_for_kids_/?join=${space.inviteCode}`)).toMatchObject(expected)
    expect(await lookupInvite('ZZZZ-ZZZZ')).toBeNull()
    expect(await lookupInvite('hello')).toBeNull()
  })

  it('shows an invite, stakes included, to someone not signed in yet', async () => {
    await signOut()
    expect(await lookupInvite(space.inviteCode)).toMatchObject({
      spaceId: space.id, spaceName: 'Film crew', reward: 'Dinner on me', penalty: 'Coffee for a week', inviterName: 'Alex',
    })
  })

  it('joins by link (idempotently) and shows up in my spaces', async () => {
    await as(sam)
    const mine = observe(startMySpaces(sam.uid))
    await mine.until((l) => l.data?.length === 0)
    expect(await joinSpace(`https://example.github.io/app_for_kids_/?join=${formatInviteCode(space.inviteCode)}`)).toBe(space.id)
    await mine.until((l) => l.data?.[0]?.id === space.id)
    expect(await joinSpace(space.inviteCode)).toBe(space.id)
    mine.stop()
    expect(await adminGet(`spaces/${space.id}/joins/${sam.uid}`)).toMatchObject({ code: space.inviteCode })

    await as(kim)
    await joinSpace(space.inviteCode)
    const stored = await adminGet(`spaces/${space.id}`)
    expect(stored?.memberIds).toEqual([alex.uid, sam.uid, kim.uid])
    expect(Object.keys(stored?.joinedAt).sort()).toEqual([alex.uid, sam.uid, kim.uid].sort())
  })

  it('explains bad codes and full spaces', async () => {
    await as(sam)
    await rejectsWith(joinSpace('nope'), "That code doesn't look right. Invite codes have 8 letters and numbers.")
    await rejectsWith(joinSpace('ZZZZZZZZ'), 'No space uses this code. Check it with your friend and try again.')
    const members = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8']
    const at = ts(Date.now() - DAY)
    await seed({
      'spaces/full': {
        name: 'Full house', reward: 'r', penalty: 'p', ownerId: 'm1', memberIds: members,
        joinedAt: Object.fromEntries(members.map((m) => [m, at])), timezone: 'UTC', inviteCode: 'FULLSPCE',
        threshold: 90, latePenalty: 5, createdAt: at,
      },
      'invites/FULLSPCE': { spaceId: 'full', spaceName: 'Full house', inviterName: 'M', createdBy: 'm1', createdAt: at },
    })
    await rejectsWith(joinSpace('FULL-SPCE'), 'This space is full. A space can have up to 8 people.')
  })

  it('edits the space live; only the owner changes the house stakes', async () => {
    await as(sam)
    await rejectsWith(updateSpace(space.id, { reward: 'Sushi' }), 'Only the owner can change the house stakes.')
    await as(alex)
    const live = observe(startSpace(space.id))
    await live.until((l) => l.data?.reward === 'Dinner on me')
    await updateSpace(space.id, { reward: 'Sushi' })
    await live.until((l) => l.data?.reward === 'Sushi')
    live.stop()
    space = { ...space, reward: 'Sushi' }
  })

  it('editing the space keeps its invite preview in step (name and stakes)', async () => {
    await as(alex)
    expect((await lookupInvite(space.inviteCode))?.reward).toBe('Sushi')
    await updateSpace(space.id, { name: 'Crew Two', penalty: 'Dishes' })
    expect(await lookupInvite(space.inviteCode)).toMatchObject({ spaceName: 'Crew Two', reward: 'Sushi', penalty: 'Dishes' })
    await updateSpace(space.id, { name: space.name, penalty: space.penalty })
    expect(await lookupInvite(space.inviteCode)).toMatchObject({ spaceName: space.name, penalty: space.penalty })
  })

  it('leaves and rejoins; the last one out retires the invite', async () => {
    await as(kim)
    const solo = await createSpace({ name: 'Solo', reward: 'r', penalty: 'p' })
    await leaveSpace(solo.id)
    expect(await lookupInvite(solo.inviteCode)).toBeNull()

    // Watched the way the screens do (shared store entry), so a stale refusal could linger.
    const key = `${kim.uid}|space|${space.id}`
    const release = watch(key, startSpace(space.id), () => {})
    await eventually(() => peek<Space | null>(key).data != null)
    await leaveSpace(space.id)
    // Losing read access reads as "no space" rather than an error.
    await eventually(() => peek<Space | null>(key).data === null && peek(key).error === null)
    release()
    const stored = await adminGet(`spaces/${space.id}`)
    expect(stored?.memberIds).toEqual([alex.uid, sam.uid])
    expect(Object.keys(stored?.joinedAt).sort()).toEqual([alex.uid, sam.uid].sort())
    expect(stored?.leftAt[kim.uid].toMillis()).toBeGreaterThan(Date.now() - 60_000)
    await leaveSpace(space.id)
    expect(await lookupInvite(space.inviteCode)).not.toBeNull()

    // Rejoining right away shows the space, not the "you left" state still lingering in the store.
    await joinSpace(space.inviteCode)
    const again = watch(key, startSpace(space.id), () => {})
    await eventually(() => peek<Space | null>(key).data?.memberIds.includes(kim.uid) === true)
    again()
    expect((await adminGet(`spaces/${space.id}`))?.memberIds).toEqual([alex.uid, sam.uid, kim.uid])
    space = { ...space, memberIds: [alex.uid, sam.uid, kim.uid] }
  })

  it('the owner resets the invite code; the old one stops working', async () => {
    await as(sam)
    await rejectsWith(resetInviteCode(space.id), 'Only the owner can reset the invite code.')
    await as(alex)
    const old = space.inviteCode
    const code = await resetInviteCode(space.id)
    expect(code).not.toBe(old)
    expect(await adminGet(`invites/${old}`)).toBeUndefined()
    expect(await lookupInvite(code)).toMatchObject({ spaceId: space.id, spaceName: space.name, reward: space.reward, penalty: space.penalty })
    await as(lee)
    await rejectsWith(joinSpace(old), 'No space uses this code. Check it with your friend and try again.')
    space = { ...space, inviteCode: code }
  })

  it('ownership passes to the earliest-joined member; the owner can remove people', async () => {
    await as(lee)
    const crew = await createSpace({ name: 'Crew B', reward: 'r', penalty: 'p' })
    await as(sam)
    await joinSpace(crew.inviteCode)
    await as(kim)
    await joinSpace(crew.inviteCode)
    await rejectsWith(removeMember(crew.id, sam.uid), 'Only the owner can remove people.')
    await as(lee)
    await leaveSpace(crew.id)
    expect(await adminGet(`spaces/${crew.id}`)).toMatchObject({ ownerId: sam.uid, memberIds: [sam.uid, kim.uid] })
    await as(sam)
    await removeMember(crew.id, kim.uid)
    const stored = await adminGet(`spaces/${crew.id}`)
    expect(stored?.memberIds).toEqual([sam.uid])
    expect(Object.keys(stored?.leftAt).sort()).toEqual([lee.uid, kim.uid].sort())
    await leaveSpace(crew.id)

    // A space whose owner left before ownership moved with them: its earliest-joined member takes over on open.
    const t = (days: number) => ts(Date.now() - days * DAY)
    await seed({
      'spaces/ownerless': {
        name: 'Old crew', reward: 'r', penalty: 'p', ownerId: 'gone', memberIds: [kim.uid, sam.uid],
        joinedAt: { [kim.uid]: t(3), [sam.uid]: t(5) }, timezone: 'UTC', utcOffsetMin: 0, inviteCode: 'OLDCREW2',
        threshold: 90, latePenalty: 5, createdAt: t(9),
      },
    })
    const old: Space = {
      id: 'ownerless', name: 'Old crew', reward: 'r', penalty: 'p', ownerId: 'gone', memberIds: [kim.uid, sam.uid],
      joinedAt: { [kim.uid]: Date.now() - 3 * DAY, [sam.uid]: Date.now() - 5 * DAY }, timezone: 'UTC', utcOffsetMin: 0,
      inviteCode: 'OLDCREW2', threshold: 90, latePenalty: 5, createdAt: Date.now() - 9 * DAY,
    }
    await as(kim)
    await ensureSpace(old)
    expect((await adminGet('spaces/ownerless'))?.ownerId).toBe('gone')
    await as(sam)
    await ensureSpace(old)
    expect((await adminGet('spaces/ownerless'))?.ownerId).toBe(sam.uid)
  })
})

describe('weeks', () => {
  it('every member takes part once anyone opens the space before lock, opened or not', async () => {
    resetClock()
    const next = addWeeks(thisWeek(), 1)
    await as(alex)
    const live = observe(startWeek(space.id, next, alex.uid))
    await live.until((l) => l.data?.week === null)
    expect(await joinWeek(space, next)).toBe(true)
    await live.until((l) => l.data?.week?.members.length === 3)
    expect(live.current().data?.boundsMismatch).toBe(false)
    live.stop()
    const bounds = weekBounds(next, space.timezone)
    const stored = await adminGet(weekPath(next))
    expect(stored?.startAt.toMillis()).toBe(bounds.startAt)
    expect(stored?.lockAt.toMillis()).toBe(bounds.lockAt)
    expect(stored?.reviewOpenAt.toMillis()).toBe(bounds.reviewOpenAt)
    expect(stored?.deadlineAt.toMillis()).toBe(bounds.deadlineAt)
    expect(stored).toMatchObject({ members: [alex.uid, sam.uid, kim.uid], submittedBy: [] })

    await as(sam)
    expect(await joinWeek(space, next)).toBe(true)
    expect((await adminGet(weekPath(next)))?.members).toEqual([alex.uid, sam.uid, kim.uid])
  })

  it('someone who joins the space before lock is added the next time anyone opens it', async () => {
    const next = addWeeks(thisWeek(), 1)
    await as(lee)
    await joinSpace(space.inviteCode)
    await as(sam)
    // What the screens' hooks run on open: this week (until it locks), next week, the month's stakes.
    await ensureSpace({ ...space, memberIds: [alex.uid, sam.uid, kim.uid, lee.uid] })
    expect((await adminGet(weekPath(next)))?.members).toEqual([alex.uid, sam.uid, kim.uid, lee.uid])
  })

  it('leaves a week nobody opened before lock inactive', async () => {
    await as(alex)
    const last = addWeeks(thisWeek(), -1)
    expect(await joinWeek(space, last)).toBe(false)
    expect(await adminGet(weekPath(last))).toBeUndefined()
  })

  it('saves plans and self check-offs', async () => {
    const next = addWeeks(thisWeek(), 1)
    await as(sam)
    await savePlan(space, next, [
      { id: 't1', title: 'Edit the reel' },
      { id: 't2', title: 'Color grade' },
      { id: 't3', title: '   ' },
    ])
    expect((await adminGet(`${weekPath(next)}/plans/${sam.uid}`))?.tasks).toEqual([
      { id: 't1', title: 'Edit the reel' },
      { id: 't2', title: 'Color grade' },
    ])
    await setTaskDone(space, next, 't1', true)
    await setTaskDone(space, next, 't2', false)
    expect((await adminGet(`${weekPath(next)}/progress/${sam.uid}`))?.done).toEqual({ t1: true, t2: false })

    const live = observe(startWeek(space.id, next, sam.uid))
    const state = await live.until((l) => l.data?.plans[sam.uid]?.tasks.length === 2 && l.data.progress[sam.uid]?.done.t1 === true)
    expect(state.data?.plans[sam.uid].updatedAt).toBeGreaterThan(0)
    live.stop()

    // Kim never opened the week, and is in it all the same.
    await as(kim)
    await savePlan(space, next, [{ id: 'k1', title: 'Shoot B-roll' }])
    expect((await adminGet(weekPath(next)))?.members).toEqual([alex.uid, sam.uid, kim.uid, lee.uid])
  })

  it('refuses plans after lock and oversized lists', async () => {
    await as(alex)
    await rejectsWith(savePlan(space, addWeeks(thisWeek(), -1), [{ id: 'a', title: 'Too late' }]), CLOSED)
    const many = Array.from({ length: 26 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}` }))
    await rejectsWith(savePlan(space, addWeeks(thisWeek(), 1), many), 'You can plan up to 25 tasks a week.')
  })

  it('maps a window the server already closed to a short message', async () => {
    // The app clock still says "active"; the stored week (real time) closed an hour ago.
    const closed = '2026-08-31'
    await seed({ [weekPath(closed)]: weekDoc('closed', [alex.uid]) })
    setClock(weekBounds(closed, space.timezone).lockAt + 12 * HOUR)
    try {
      await as(alex)
      await rejectsWith(setTaskDone(space, closed, 't1', true), CLOSED)
      await as(kim)
      await rejectsWith(setTaskDone(space, closed, 't1', true), "You joined after this week's lists locked. You're in from next week.")
    } finally {
      resetClock()
    }
  })

  it('flags a week whose stored timeline does not match the space\'s zone', async () => {
    const skewed = '2026-08-24'
    await seed({ [weekPath(skewed)]: weekDoc('closed', [alex.uid]) })
    await as(alex)
    const live = observe(startWeek(space.id, skewed, alex.uid))
    const state = await live.until((l) => l.data?.week != null)
    expect(state.data?.boundsMismatch).toBe(true)
    live.stop()
  })
})

describe('reviews', () => {
  const W = REVIEW_WEEK

  beforeAll(async () => {
    await seed({
      [weekPath(W)]: weekDoc('review', [alex.uid, sam.uid, kim.uid]),
      [`${weekPath(W)}/plans/${alex.uid}`]: { tasks: [{ id: 'a1', title: 'A1' }, { id: 'a2', title: 'A2' }], updatedAt: ts(Date.now() - 5 * DAY) },
      [`${weekPath(W)}/plans/${sam.uid}`]: { tasks: [{ id: 's1', title: 'S1' }, { id: 's2', title: 'S2' }], updatedAt: ts(Date.now() - 5 * DAY) },
      [`${weekPath(W)}/plans/${kim.uid}`]: { tasks: [{ id: 'k1', title: 'K1' }], updatedAt: ts(Date.now() - 5 * DAY) },
    })
  })

  it('submits all reviews at once, final, and blind until everyone has submitted', async () => {
    // Real time is inside the stored review window, which both the rules and the data layer go by.
    try {
      await as(alex)
      await submitReviews(space, W, [
        { revieweeId: sam.uid, marks: { s1: 1, s2: 0.5 } },
        { revieweeId: kim.uid, marks: { k1: 0 } },
      ])
      expect((await adminGet(weekPath(W)))?.submittedBy).toEqual([alex.uid])
      expect(await adminGet(`${weekPath(W)}/reviews/${alex.uid}_${sam.uid}`)).toMatchObject({ reviewerId: alex.uid, revieweeId: sam.uid, marks: { s1: 1, s2: 0.5 } })
      await rejectsWith(submitReviews(space, W, [{ revieweeId: sam.uid, marks: { s1: 0, s2: 0 } }]), CLOSED)

      await as(sam)
      await submitReviews(space, W, [
        { revieweeId: alex.uid, marks: { a1: 1, a2: 1 } },
        { revieweeId: kim.uid, marks: { k1: 0.5 } },
      ])
      let live = observe(startWeek(space.id, W, sam.uid))
      let state = await live.until((l) => l.data?.week?.submittedBy.length === 2 && l.data.reviews.length === 2)
      // Alex's review of Sam exists but stays hidden.
      expect(state.data?.reviews.every((r) => r.reviewerId === sam.uid)).toBe(true)
      live.stop()

      await as(kim)
      const seen = record<WeekData>(startWeek(space.id, W, kim.uid))
      await eventually(() => seen.states.at(-1)?.data?.week != null)
      expect(seen.states.at(-1)?.data?.reviews).toEqual([])
      await submitReviews(space, W, [
        { revieweeId: alex.uid, marks: { a1: 0.5, a2: 1 } },
        { revieweeId: sam.uid, marks: { s1: 1, s2: 1 } },
      ])
      // The last submission reveals the week while we're watching.
      await eventually(() => seen.states.at(-1)?.data?.reviews.length === 6)
      state = seen.states.at(-1)!
      expect(state.data?.reviews.find((r) => r.id === `${alex.uid}_${kim.uid}`)?.marks).toEqual({ k1: 0 })
      expect(state.data?.reviews.every((r) => r.submittedAt > 0)).toBe(true)
      // Never a revealed week (everyone submitted) scored from Kim's own reviews only.
      const mixed = seen.states.filter((l) => l.data?.week?.submittedBy.length === 3 && l.data.reviews.length < 6)
      expect(mixed).toEqual([])
      seen.stop()
    } finally {
      resetClock()
    }
  })

  it('a week that is already revealed is first published with everyone\'s reviews', async () => {
    const R = '2026-08-17'
    const at = ts(Date.now() - 2 * DAY)
    await seed({
      [weekPath(R)]: weekDoc('closed', [alex.uid, sam.uid, kim.uid], [alex.uid, sam.uid, kim.uid]),
      [`${weekPath(R)}/reviews/${alex.uid}_${sam.uid}`]: { reviewerId: alex.uid, revieweeId: sam.uid, marks: { s1: 1 }, submittedAt: at },
      [`${weekPath(R)}/reviews/${sam.uid}_${alex.uid}`]: { reviewerId: sam.uid, revieweeId: alex.uid, marks: { a1: 1 }, submittedAt: at },
      [`${weekPath(R)}/reviews/${kim.uid}_${alex.uid}`]: { reviewerId: kim.uid, revieweeId: alex.uid, marks: { a1: 0.5 }, submittedAt: at },
    })
    await as(alex)
    const seen = record<WeekData>(startWeek(space.id, R, alex.uid))
    await eventually(() => seen.states.at(-1)?.data?.reviews.length === 3)
    const published = seen.states.filter((l) => l.data)
    expect(published.length).toBeGreaterThan(0)
    expect(published.every((l) => l.data?.reviews.length === 3)).toBe(true)
    seen.stop()
  })

  it('someone who leaves after lock stays in that week: still reviewed, and the reveal waits for them', async () => {
    const T = thisWeek()
    const next = addWeeks(T, 1)
    await seed({
      [weekPath(T)]: weekDoc('review', [alex.uid, sam.uid, kim.uid, lee.uid]),
      [`${weekPath(T)}/plans/${lee.uid}`]: { tasks: [{ id: 'l1', title: 'L1' }], updatedAt: ts(Date.now() - 5 * DAY) },
      [`${weekPath(T)}/plans/${kim.uid}`]: { tasks: [{ id: 'k1', title: 'K1' }], updatedAt: ts(Date.now() - 5 * DAY) },
    })
    await as(lee)
    await leaveSpace(space.id)
    // This week has locked: Lee stays in it. Next week hasn't: Lee is out of it.
    expect((await adminGet(weekPath(T)))?.members).toEqual([alex.uid, sam.uid, kim.uid, lee.uid])
    expect((await adminGet(weekPath(next)))?.members).toEqual([alex.uid, sam.uid, kim.uid])
    expect((await adminGet(`spaces/${space.id}`))?.leftAt[lee.uid]).toBeDefined()

    await as(alex)
    await submitReviews(space, T, [{ revieweeId: kim.uid, marks: { k1: 1 } }, { revieweeId: lee.uid, marks: { l1: 0 } }])
    await as(kim)
    await submitReviews(space, T, [{ revieweeId: lee.uid, marks: { l1: 0.5 } }])
    await as(sam)
    await submitReviews(space, T, [{ revieweeId: kim.uid, marks: { k1: 1 } }])
    // Everyone still in the space has submitted, but Lee is in the week and can't any more: blind
    // until the deadline, for the data layer and the rules alike.
    await as(alex)
    const live = observe(startWeek(space.id, T, alex.uid))
    const state = await live.until((l) => l.data?.week?.submittedBy.length === 3 && l.data.reviews.length === 2)
    expect(state.data?.reviews.every((r) => r.reviewerId === alex.uid)).toBe(true)
    live.stop()
    await expect(getDocs(collection(getFirebase().db, `${weekPath(T)}/reviews`))).rejects.toMatchObject({ code: 'permission-denied' })
    // After the deadline Sam owes Lee a review; Lee's score comes from Alex's and Kim's marks.
    const data = await adminWeekData(space.id, T)
    const result = computeWeek(data, await adminSpace(space.id), data.week!.deadlineAt)
    expect(result.members[sam.uid].missedReviewsOf).toEqual([lee.uid])
    expect(result.members[lee.uid]).toMatchObject({ participating: true, score: 25 })
    expect([...result.members[lee.uid].reviewedBy].sort()).toEqual([alex.uid, kim.uid].sort())
  })

  it('refuses reviews outside the window before writing', async () => {
    await as(alex)
    await rejectsWith(submitReviews(space, addWeeks(thisWeek(), 1), []), 'Reviews haven’t opened yet.')
  })

  it('reveals everyone\'s reviews live at the deadline', async () => {
    const D = '2026-09-28'
    const deadline = Date.now() + 3_000
    await seed({
      [weekPath(D)]: {
        startAt: ts(deadline - 5 * DAY), lockAt: ts(deadline - 4 * DAY), reviewOpenAt: ts(deadline - DAY), deadlineAt: ts(deadline),
        members: [alex.uid, sam.uid], submittedBy: [sam.uid],
      },
      [`${weekPath(D)}/reviews/${sam.uid}_${alex.uid}`]: { reviewerId: sam.uid, revieweeId: alex.uid, marks: { a1: 1 }, submittedAt: ts(Date.now()) },
    })
    await as(alex)
    const live = observe(startWeek(space.id, D, alex.uid))
    const before = await live.until((l) => l.data?.week != null)
    expect(before.data?.reviews).toEqual([])
    const after = await live.until((l) => l.data?.reviews.length === 1, 15_000)
    expect(Date.now()).toBeGreaterThanOrEqual(deadline)
    expect(after.data?.reviews[0].id).toBe(`${sam.uid}_${alex.uid}`)
    live.stop()
  })
})

describe('the lock is a commitment: leaving after it never helps the leaver', () => {
  let mia: TestUser
  let noa: TestUser
  let oli: TestUser

  /** A fresh space owned by Alex with `others` in it; this week (locked, in `phase`) and next week (planning) seeded. */
  async function crewWith(others: TestUser[], phase: 'active' | 'review', plans: Record<string, string[]>) {
    await as(alex)
    const crew = await createSpace({ name: 'Leavers', reward: 'r', penalty: 'p' })
    for (const user of others) {
      await as(user)
      await joinSpace(crew.inviteCode)
    }
    const members = [alex.uid, ...others.map((u) => u.uid)]
    const T = weekIdFor(now(), crew.timezone)
    const N = addWeeks(T, 1)
    const path = (weekId: string) => `spaces/${crew.id}/weeks/${weekId}`
    await seed({
      [path(T)]: weekDoc(phase, members),
      [path(N)]: weekDoc('planning', members),
      ...Object.fromEntries(
        Object.entries(plans).map(([uid, ids]) => [`${path(T)}/plans/${uid}`, { tasks: ids.map((id) => ({ id, title: id })), updatedAt: ts(Date.now() - 3 * DAY) }]),
      ),
    })
    return { crew: { ...crew, memberIds: members }, T, N, members, path }
  }

  it('cheat 1: slacking all week, then leaving on Thursday, still counts that week', async () => {
    mia = await createUser('Mia')
    const { crew, T, N, members, path } = await crewWith([mia], 'active', { [alex.uid]: ['a1'], [mia.uid]: ['m1', 'm2'] })
    await as(mia)
    await leaveSpace(crew.id)
    expect((await adminGet(path(T)))?.members).toEqual(members)
    expect((await adminGet(path(N)))?.members).toEqual([alex.uid])

    // Mia ticked nothing and nobody can review her into a better week: 0%, and it stays in her month.
    const data = await adminWeekData(crew.id, T)
    const sp = await adminSpace(crew.id)
    const after = data.week!.deadlineAt
    expect(reviewTargets(data, alex.uid, membersAt(sp, data.week!.lockAt))).toEqual([mia.uid])
    expect(computeWeek(data, sp, after).members[mia.uid]).toMatchObject({ participating: true, score: 0 })
    const month = computeMonth(sp, monthIdForWeek(T), [data], after)
    expect(month[mia.uid]).toMatchObject({ former: true, others: [alex.uid], weeks: [{ weekId: T, score: 0, closed: true }], average: 0 })
    expect(month[alex.uid].others).toEqual([mia.uid])
  })

  it('cheat 2: the owner removing someone in the review window keeps their strong week', async () => {
    noa = await createUser('Noa')
    const { crew, T, N, members, path } = await crewWith([sam, noa], 'review', { [alex.uid]: ['a1'], [sam.uid]: ['s1'], [noa.uid]: ['n1', 'n2'] })
    await as(alex)
    await removeMember(crew.id, noa.uid)
    expect((await adminGet(path(T)))?.members).toEqual(members)
    expect((await adminGet(path(N)))?.members).toEqual([alex.uid, sam.uid])
    // Nor can the owner take Noa out of the locked week directly.
    await expect(updateDoc(doc(getFirebase().db, path(T)), { members: arrayRemove(noa.uid) })).rejects.toMatchObject({ code: 'permission-denied' })

    // Noa is still reviewed, and her week scores what her friends say.
    await submitReviews(crew, T, [{ revieweeId: sam.uid, marks: { s1: 1 } }, { revieweeId: noa.uid, marks: { n1: 1, n2: 1 } }])
    await as(sam)
    await submitReviews(crew, T, [{ revieweeId: alex.uid, marks: { a1: 1 } }, { revieweeId: noa.uid, marks: { n1: 1, n2: 1 } }])
    const data = await adminWeekData(crew.id, T)
    const sp = await adminSpace(crew.id)
    const result = computeWeek(data, sp, data.week!.deadlineAt)
    expect(result.members[noa.uid]).toMatchObject({ participating: true, score: 100 })
    expect([...result.members[noa.uid].reviewedBy].sort()).toEqual([alex.uid, sam.uid].sort())
    expect(computeMonth(sp, monthIdForWeek(T), [data], data.week!.deadlineAt)[noa.uid]).toMatchObject({ former: true, average: 100 })
  })

  it('cheat 3: harsh marks, every task ticked, then leaving: friends still review the leaver', async () => {
    oli = await createUser('Oli')
    const { crew, T, members, path } = await crewWith([sam, oli], 'review', { [alex.uid]: ['a1'], [sam.uid]: ['s1'], [oli.uid]: ['o1', 'o2'] })
    await as(oli)
    await setTaskDone(crew, T, 'o1', true)
    await setTaskDone(crew, T, 'o2', true)
    await submitReviews(crew, T, [{ revieweeId: alex.uid, marks: { a1: 0 } }, { revieweeId: sam.uid, marks: { s1: 0 } }])
    await leaveSpace(crew.id)
    expect((await adminGet(path(T)))?.members).toEqual(members)

    // Oli is still on Alex's and Sam's list, and they review the week Oli actually had.
    const sp = await adminSpace(crew.id)
    const before = await adminWeekData(crew.id, T)
    expect(reviewTargets(before, alex.uid, membersAt(sp, before.week!.lockAt))).toEqual([sam.uid, oli.uid])
    await as(alex)
    await submitReviews(crew, T, [{ revieweeId: sam.uid, marks: { s1: 1 } }, { revieweeId: oli.uid, marks: { o1: 0, o2: 0 } }])
    await as(sam)
    await submitReviews(crew, T, [{ revieweeId: alex.uid, marks: { a1: 1 } }, { revieweeId: oli.uid, marks: { o1: 0.5, o2: 0 } }])
    // Everyone in the week has submitted (Oli before leaving): revealed, and Oli's own ticks don't decide.
    const live = observe(startWeek(crew.id, T, sam.uid))
    const state = await live.until((l) => l.data?.reviews.length === 6)
    live.stop()
    const result = computeWeek(state.data!, sp, now())
    expect(result.revealed).toBe(true)
    expect(result.members[oli.uid]).toMatchObject({ provisionalScore: 100, score: 12.5 })
    expect([...result.members[oli.uid].reviewedBy].sort()).toEqual([alex.uid, sam.uid].sort())
  })
})

describe('months, settlements and profiles', () => {
  it('combines the weeks of a month and its list without creating docs', async () => {
    await as(alex)
    const month = '2026-09'
    const weekIds = weekIdsInMonth(month)
    // As useMonthData loads a finished month: its weeks and its list (this space has none).
    expect(monthListCounts(space, month, now())).toBe(true)
    const live = observe(startMonthData(space.id, month, alex.uid, true))
    const state = await live.until((l) => l.data !== undefined && l.data.weeks.find((w) => w.weekId === REVIEW_WEEK)?.reviews.length === 6)
    expect(state.data?.weeks.map((w) => w.weekId)).toEqual(weekIds)
    expect(state.data?.weeks.find((w) => w.weekId === '2026-09-07')?.week).toBeNull()
    expect(state.data?.monthly?.monthly).toBeNull()
    live.stop()
    expect(await adminGet(weekPath('2026-09-07'))).toBeUndefined()
    expect(await adminGet(`spaces/${space.id}/monthly/${month}`)).toBeUndefined()
  })

  it('freezes a month\'s house stakes only once it is complete, so an owner\'s edit counts at once for the month in progress', async () => {
    resetClock()
    const month = monthIdForWeek(thisWeek())
    const complete = now() >= weekBounds(weekIdsInMonth(month).at(-1) as string, space.timezone).deadlineAt
    await as(sam)
    await ensureSpace(space)
    const live = observe(startMonthStakes(space.id, month))
    if (complete) {
      // Run between a month's end and the next month's first week: it is frozen now.
      await live.until((l) => l.data?.frozen === true)
      live.stop()
      return
    }
    expect((await live.until((l) => !l.loading)).data).toBeNull()
    await as(alex)
    await updateSpace(space.id, { penalty: 'A high five' })
    expect(await adminGet(`spaces/${space.id}/months/${month}`)).toBeUndefined()
    expect((await adminGet(`spaces/${space.id}`))?.stakesNote).toMatchObject({ by: alex.uid })
    live.stop()
    await updateSpace(space.id, { penalty: space.penalty })
  })

  it('stores settlements per pair, and reads only that month', async () => {
    await as(sam)
    // Lee has left, and still owes or is owed for the months Lee played.
    await settlePairs(space.id, '2026-09', [{ uid: lee.uid, other: sam.uid }, { uid: alex.uid, other: sam.uid }], true)
    expect(await adminGet(`spaces/${space.id}/settlements/2026-09_${alex.uid}_${sam.uid}`)).toMatchObject({
      monthId: '2026-09', uid: alex.uid, other: sam.uid, settled: true, settledBy: sam.uid,
    })
    expect(await adminGet(`spaces/${space.id}/settlements/2026-09_${lee.uid}_${sam.uid}`)).toMatchObject({ uid: lee.uid, settled: true })
    await settlePairs(space.id, '2026-08', [{ uid: alex.uid, other: sam.uid }], true)
    const live = observe(startSettlements(space.id, '2026-09'))
    const mine = (l: Live<{ uid: string; settled: boolean }[]>) => l.data?.find((x) => x.uid === alex.uid)
    await live.until((l) => l.data?.length === 2 && mine(l)?.settled === true)
    expect(live.current().data?.every((x) => x.monthId === '2026-09')).toBe(true)
    await settlePairs(space.id, '2026-09', [{ uid: alex.uid, other: sam.uid }], false)
    await live.until((l) => mine(l)?.settled === false)
    live.stop()
  })

  it('loads profiles, skipping unknown uids', async () => {
    const live = observe(combine([alex.uid, sam.uid, 'nobody'].map((uid) => ({ key: `${sam.uid}|profile|${uid}`, start: startProfile(uid) })), mergeProfiles))
    const state = await live.until((l) => !l.loading)
    expect(Object.keys(state.data ?? {}).sort()).toEqual([alex.uid, sam.uid].sort())
    expect(state.data?.[alex.uid]).toMatchObject({ name: 'Alex', color: colorForUid(alex.uid) })
    live.stop()
  })
})

describe('account deletion', () => {
  it('needs the right password', async () => {
    await as(kim)
    await rejectsWith(deleteMyAccount('not-it'), 'Wrong password.')
  })

  it('leaves every space and deletes the user\'s docs and auth user', async () => {
    await seed({ [`users/${kim.uid}/push/sub1`]: { endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' }, createdAt: ts(Date.now()), ua: 'test' } })
    await as(kim)
    await deleteMyAccount(PASSWORD)
    expect(await adminGet(`users/${kim.uid}`)).toBeUndefined()
    expect(await adminGet(`users/${kim.uid}/push/sub1`)).toBeUndefined()
    expect((await adminGet(`spaces/${space.id}`))?.memberIds).toEqual([alex.uid, sam.uid])
    // Next week hasn't locked, so Kim is out of it too. This week has locked: Kim stays in it.
    expect((await adminGet(weekPath(addWeeks(thisWeek(), 1))))?.members).toEqual([alex.uid, sam.uid])
    expect((await adminGet(weekPath(thisWeek())))?.members).toContain(kim.uid)
    await rejectsWith(signIn(kim.email, PASSWORD), 'Wrong email or password.')
  })
})
