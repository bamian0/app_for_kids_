// Data layer against the emulators, through the same functions the screens call.
// One scenario, in order: accounts -> spaces -> weeks -> reviews -> months -> account deletion.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createSpace,
  deleteMyAccount,
  joinSpace,
  joinWeek,
  leaveSpace,
  lookupInvite,
  savePlan,
  setSettled,
  setTaskDone,
  signIn,
  signOut,
  signUp,
  submitReviews,
  updateMyName,
  updateSpace,
} from '../../src/data/api.ts'
import { mergeProfiles, startProfile } from '../../src/data/auth.ts'
import { authState } from '../../src/data/session.ts'
import { startSettlements } from '../../src/data/settlements.ts'
import { startMySpaces, startSpace } from '../../src/data/spaces.ts'
import { combine } from '../../src/data/store.ts'
import { mergeWeeks, startWeek, weekKey } from '../../src/data/weeks.ts'
import { now } from '../../src/domain/clock.ts'
import { colorForUid, formatInviteCode } from '../../src/domain/ids.ts'
import { addWeeks, weekBounds, weekIdFor, weekIdsInMonth } from '../../src/domain/time.ts'
import type { Space } from '../../src/domain/types.ts'
import {
  adminGet,
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

const CLOSED = "You can't change this anymore."
/** Seeded in its review window; everyone submits, so it ends up revealed. */
const REVIEW_WEEK = '2026-09-21'

let alex: TestUser
let sam: TestUser
let kim: TestUser
let space: Space

const thisWeek = () => weekIdFor(now(), space.timezone)
const weekPath = (weekId: string) => `spaces/${space.id}/weeks/${weekId}`

beforeAll(setupEmulators)
afterAll(teardownEmulators)

describe('accounts', () => {
  it('signs up users with a profile doc', async () => {
    alex = await createUser('Alex')
    sam = await createUser('Sam')
    kim = await createUser('Kim')
    const profile = await adminGet(`users/${alex.uid}`)
    expect(profile).toMatchObject({ name: 'Alex', color: colorForUid(alex.uid) })
    expect(profile?.createdAt.toMillis()).toBeGreaterThan(Date.now() - 60_000)
  })

  it('turns auth errors into short messages', async () => {
    await signOut()
    await rejectsWith(signUp('Alex', alex.email, PASSWORD), 'An account with this email already exists. Try signing in.')
    await rejectsWith(signUp('Pat', 'pat@example.com', '12345'), 'Use at least 6 characters for your password.')
    await rejectsWith(signUp('Pat', 'not-an-email', PASSWORD), "That email address doesn't look right.")
    await rejectsWith(signUp('   ', 'pat@example.com', PASSWORD), "Name can't be empty.")
    await rejectsWith(signIn(alex.email, 'wrong-password'), 'Wrong email or password.')
    await rejectsWith(signIn('nobody@example.com', PASSWORD), 'Wrong email or password.')
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
    expect(stored).toMatchObject({ name: 'Film crew', memberIds: [alex.uid], inviteCode: space.inviteCode, timezone: space.timezone })
    expect(Object.keys(stored?.joinedAt)).toEqual([alex.uid])
    expect(await adminGet(`invites/${space.inviteCode}`)).toMatchObject({ spaceId: space.id, spaceName: 'Film crew', inviterName: 'Alex', createdBy: alex.uid })
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

  it('edits the space live', async () => {
    await as(sam)
    const live = observe(startSpace(space.id))
    await live.until((l) => l.data?.reward === 'Dinner on me')
    await updateSpace(space.id, { reward: 'Sushi' })
    await live.until((l) => l.data?.reward === 'Sushi')
    live.stop()
    space = { ...space, reward: 'Sushi' }
  })

  it('renaming a space renames its invite preview', async () => {
    await as(sam)
    await updateSpace(space.id, { name: 'Crew Two' })
    expect((await lookupInvite(space.inviteCode))?.spaceName).toBe('Crew Two')
    await updateSpace(space.id, { name: space.name })
    expect((await lookupInvite(space.inviteCode))?.spaceName).toBe(space.name)
  })

  it('leaves and rejoins; the last one out retires the invite', async () => {
    await as(kim)
    const solo = await createSpace({ name: 'Solo', reward: 'r', penalty: 'p' })
    await leaveSpace(solo.id)
    expect(await lookupInvite(solo.inviteCode)).toBeNull()

    const live = observe(startSpace(space.id))
    await live.until((l) => l.data != null)
    await leaveSpace(space.id)
    // Losing read access reads as "no space" rather than an error.
    await live.until((l) => l.data === null && l.error === null)
    live.stop()
    const stored = await adminGet(`spaces/${space.id}`)
    expect(stored?.memberIds).toEqual([alex.uid, sam.uid])
    expect(Object.keys(stored?.joinedAt).sort()).toEqual([alex.uid, sam.uid].sort())
    await leaveSpace(space.id)
    expect(await lookupInvite(space.inviteCode)).not.toBeNull()

    await joinSpace(space.inviteCode)
    expect((await adminGet(`spaces/${space.id}`))?.memberIds).toEqual([alex.uid, sam.uid, kim.uid])
    space = { ...space, memberIds: [alex.uid, sam.uid, kim.uid] }
  })
})

describe('weeks', () => {
  it('opening a week before lock creates it, later openers join it', async () => {
    resetClock()
    const next = addWeeks(thisWeek(), 1)
    await as(alex)
    const live = observe(startWeek(space.id, next, alex.uid))
    await live.until((l) => l.data?.week === null)
    expect(await joinWeek(space, next)).toBe(true)
    await live.until((l) => l.data?.week?.members.join() === alex.uid)
    live.stop()
    const bounds = weekBounds(next, space.timezone)
    const stored = await adminGet(weekPath(next))
    expect(stored?.startAt.toMillis()).toBe(bounds.startAt)
    expect(stored?.lockAt.toMillis()).toBe(bounds.lockAt)
    expect(stored?.reviewOpenAt.toMillis()).toBe(bounds.reviewOpenAt)
    expect(stored?.deadlineAt.toMillis()).toBe(bounds.deadlineAt)
    expect(stored).toMatchObject({ members: [alex.uid], submittedBy: [] })

    await as(sam)
    expect(await joinWeek(space, next)).toBe(true)
    expect((await adminGet(weekPath(next)))?.members).toEqual([alex.uid, sam.uid])
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

    // Saving a plan is also how a member who hasn't opened the week joins it.
    await as(kim)
    await savePlan(space, next, [{ id: 'k1', title: 'Shoot B-roll' }])
    expect((await adminGet(weekPath(next)))?.members).toEqual([alex.uid, sam.uid, kim.uid])
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
      live = observe(startWeek(space.id, W, kim.uid))
      state = await live.until((l) => l.data?.week != null)
      expect(state.data?.reviews).toEqual([])
      await submitReviews(space, W, [
        { revieweeId: alex.uid, marks: { a1: 0.5, a2: 1 } },
        { revieweeId: sam.uid, marks: { s1: 1, s2: 1 } },
      ])
      // The last submission reveals the week while we're watching.
      state = await live.until((l) => l.data?.reviews.length === 6)
      expect(state.data?.reviews.find((r) => r.id === `${alex.uid}_${kim.uid}`)?.marks).toEqual({ k1: 0 })
      expect(state.data?.reviews.every((r) => r.submittedAt > 0)).toBe(true)
      live.stop()
    } finally {
      resetClock()
    }
  })

  it('refuses reviews outside the window before writing', async () => {
    await as(alex)
    await rejectsWith(submitReviews(space, addWeeks(thisWeek(), 1), []), 'Reviews open on Friday.')
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

describe('months, settlements and profiles', () => {
  it('combines the weeks of a month without creating week docs', async () => {
    await as(alex)
    const month = '2026-09'
    const weekIds = weekIdsInMonth(month)
    const live = observe(
      combine(
        weekIds.map((weekId) => ({ key: weekKey(alex.uid, space.id, weekId), start: startWeek(space.id, weekId, alex.uid) })),
        mergeWeeks,
      ),
    )
    const state = await live.until((l) => l.data !== undefined && l.data.find((w) => w.weekId === REVIEW_WEEK)?.reviews.length === 6)
    expect(state.data?.map((w) => w.weekId)).toEqual(weekIds)
    expect(state.data?.find((w) => w.weekId === '2026-09-07')?.week).toBeNull()
    live.stop()
    expect(await adminGet(weekPath('2026-09-07'))).toBeUndefined()
  })

  it('stores settlements', async () => {
    await as(sam)
    await setSettled(space.id, '2026-09', alex.uid, true)
    expect(await adminGet(`spaces/${space.id}/settlements/2026-09_${alex.uid}`)).toMatchObject({ monthId: '2026-09', uid: alex.uid, settled: true, settledBy: sam.uid })
    const live = observe(startSettlements(space.id))
    await live.until((l) => l.data?.length === 1 && l.data[0].settled)
    await setSettled(space.id, '2026-09', alex.uid, false)
    await live.until((l) => l.data?.[0]?.settled === false)
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
    await rejectsWith(signIn(kim.email, PASSWORD), 'Wrong email or password.')
  })
})
