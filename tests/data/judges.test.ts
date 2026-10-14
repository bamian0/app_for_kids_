// Judges (SPEC §9.4) against the emulators: who only rates, written so that nobody judging writes exactly
// what the app wrote before batch 2.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { disableNetwork, enableNetwork } from 'firebase/firestore'
import { addTaskAfterLock, createSpace, ensureSpace, joinSpace, leaveSpace, savePlan, setJudge } from '../../src/data/api.ts'
import { now } from '../../src/domain/clock.ts'
import { addWeeks, weekIdFor } from '../../src/domain/time.ts'
import type { Space } from '../../src/domain/types.ts'
import { getFirebase } from '../../src/firebase/app.ts'
import {
  adminGet,
  adminSpace,
  as,
  boundsDoc,
  createUser,
  DAY,
  rejectsWith,
  resetClock,
  seed,
  setClock,
  setupEmulators,
  spaceDoc,
  teardownEmulators,
  ts,
  weekDoc,
  type TestUser,
} from './helpers.ts'

const OFFLINE = "You're offline. Check your connection and try again."
const JUDGING = 'You’re judging this week, so there’s no list to plan.'
/** The 12 keys of a space from before batch 2. */
const OLD_KEYS = ['createdAt', 'inviteCode', 'joinedAt', 'latePenalty', 'memberIds', 'name', 'ownerId', 'penalty', 'reward', 'threshold', 'timezone', 'utcOffsetMin']

let marco: TestUser
let lena: TestUser
let sam: TestUser

const thisWeekOf = (space: Space) => weekIdFor(now(), space.timezone)
const weekPath = (spaceId: string, weekId: string) => `spaces/${spaceId}/weeks/${weekId}`

beforeAll(async () => {
  await setupEmulators()
  marco = await createUser('Marco')
  lena = await createUser('Lena')
  sam = await createUser('Sam')
})
afterAll(teardownEmulators)

describe('creating and joining', () => {
  let playing: Space
  let judging: Space

  it('without Only Rate Friends, writes exactly what the app wrote before batch 2', async () => {
    resetClock()
    await as(marco)
    playing = await createSpace({ name: 'Players', reward: 'Dinner', penalty: 'Coffee' })
    expect(playing.judges).toBeUndefined()
    expect(Object.keys((await adminGet(`spaces/${playing.id}`)) ?? {}).sort()).toEqual(OLD_KEYS)
    await as(lena)
    await joinSpace(playing.inviteCode)
    const stored = await adminGet(`spaces/${playing.id}`)
    expect(Object.keys(stored ?? {}).sort()).toEqual(OLD_KEYS)
    expect(stored?.memberIds).toEqual([marco.uid, lena.uid])
    // Week docs carry no judges either.
    await ensureSpace(await adminSpace(playing.id))
    const next = await adminGet(weekPath(playing.id, addWeeks(thisWeekOf(playing), 1)))
    expect(next?.members).toEqual([marco.uid, lena.uid])
    expect(Object.keys(next ?? {}).sort()).toEqual(['deadlineAt', 'lockAt', 'members', 'reviewOpenAt', 'startAt', 'submittedBy'])
  })

  it('creating or joining as a judge adds you to the space’s judges, and new weeks snapshot them', async () => {
    await as(marco)
    judging = await createSpace({ name: 'Judges', reward: 'Dinner', penalty: 'Coffee', judge: true })
    expect(judging.judges).toEqual([marco.uid])
    expect((await adminGet(`spaces/${judging.id}`))?.judges).toEqual([marco.uid])
    await as(lena)
    await joinSpace(judging.inviteCode, { judge: true })
    await as(sam)
    await joinSpace(judging.inviteCode)
    const stored = await adminGet(`spaces/${judging.id}`)
    expect(stored?.judges).toEqual([marco.uid, lena.uid])
    expect(stored?.memberIds).toEqual([marco.uid, lena.uid, sam.uid])
    await ensureSpace({ ...(await adminSpace(judging.id)), judges: [marco.uid, lena.uid] })
    const next = await adminGet(weekPath(judging.id, addWeeks(thisWeekOf(judging), 1)))
    expect(next).toMatchObject({ members: [marco.uid, lena.uid, sam.uid], judges: [marco.uid, lena.uid] })
  })

  it('joining to play with a stale judge entry from an earlier stay removes it', async () => {
    // An older app's leave left Kim's entry behind.
    const kim = await createUser('Kim')
    await seed({
      'spaces/stale': spaceDoc({ ownerId: marco.uid, memberIds: [marco.uid], inviteCode: 'STALE234', extra: { judges: [kim.uid] } }),
      'invites/STALE234': { spaceId: 'stale', spaceName: 'Film Club', reward: 'Dinner on me', penalty: 'Coffee for a week', inviterName: 'Marco', createdBy: marco.uid, createdAt: ts(Date.now()) },
    })
    await as(kim)
    await joinSpace('STALE234')
    const stored = await adminGet('spaces/stale')
    expect(stored?.memberIds).toEqual([marco.uid, kim.uid])
    expect(stored?.judges).toEqual([])
  })

  it('a judge who leaves drops their own entry', async () => {
    await as(lena)
    await leaveSpace(judging.id)
    const stored = await adminGet(`spaces/${judging.id}`)
    expect(stored?.judges).toEqual([marco.uid])
    expect(stored?.memberIds).toEqual([marco.uid, sam.uid])
  })
})

describe('switching role', () => {
  const id = 'roles'
  let space: Space

  beforeAll(async () => {
    resetClock()
    await seed({ [`spaces/${id}`]: spaceDoc({ ownerId: marco.uid, memberIds: [marco.uid, lena.uid, sam.uid], inviteCode: 'ROLES234' }) })
    space = await adminSpace(id)
    await as(marco)
    await ensureSpace(space)
  })

  it('setJudge updates the space and every period that hasn’t locked, in one transaction', async () => {
    await as(lena)
    await setJudge(id, true)
    expect((await adminGet(`spaces/${id}`))?.judges).toEqual([lena.uid])
    const next = addWeeks(thisWeekOf(space), 1)
    expect((await adminGet(weekPath(id, next)))?.judges).toEqual([lena.uid])
    const thisWeek = await adminGet(weekPath(id, thisWeekOf(space)))
    if (thisWeek && Date.now() >= thisWeek.lockAt.toMillis()) expect(thisWeek.judges).toBeUndefined()
    // Playing again: the list drops you, and the week follows.
    await as(sam)
    await setJudge(id, true)
    await as(lena)
    await setJudge(id, false)
    expect((await adminGet(`spaces/${id}`))?.judges).toEqual([sam.uid])
    expect((await adminGet(weekPath(id, next)))?.judges).toEqual([sam.uid])
    await as(sam)
    await setJudge(id, false)
    expect((await adminGet(`spaces/${id}`))?.judges).toEqual([])
  })

  it('a judge has no list to plan or add to', async () => {
    await as(lena)
    await setJudge(id, true)
    const next = addWeeks(thisWeekOf(space), 1)
    await rejectsWith(savePlan({ ...space, judges: [lena.uid] }, next, [{ id: 't1', title: 'Edit' }]), JUDGING)
    // A locked week she judges.
    const active = '2026-01-05'
    await seed({ [weekPath(id, active)]: { ...weekDoc('active', [marco.uid, lena.uid, sam.uid]), judges: [lena.uid] } })
    await rejectsWith(addTaskAfterLock(space, active, { title: 'Late one' }), JUDGING)
    await setJudge(id, false)
  })

  it('when a lock passes between reading and writing, only the space changes and that week keeps your role', async () => {
    // This week's doc locked a minute ago on the server; the device is ten minutes behind and thinks it hasn't.
    const at = Date.now()
    setClock(at - 10 * 60_000)
    const week = weekIdFor(now(), 'UTC')
    await seed({ [weekPath(id, week)]: { ...boundsDoc({ startAt: at - DAY, lockAt: at - 60_000, reviewOpenAt: at + 2 * DAY, deadlineAt: at + 3 * DAY }, [marco.uid, lena.uid, sam.uid]), judges: [] } })
    try {
      await as(sam)
      await setJudge(id, true)
    } finally {
      resetClock()
    }
    expect((await adminGet(`spaces/${id}`))?.judges).toEqual([sam.uid])
    expect((await adminGet(weekPath(id, week)))?.judges).toEqual([])
    await setJudge(id, false)
  })

  it('upkeep keeps an unlocked week’s judges equal to the space’s', async () => {
    const next = addWeeks(thisWeekOf(space), 1)
    await seed({ [`spaces/${id}`]: spaceDoc({ ownerId: marco.uid, memberIds: [marco.uid, lena.uid, sam.uid], inviteCode: 'ROLES234', extra: { judges: [sam.uid] } }) })
    await as(marco)
    await ensureSpace({ ...space, judges: [sam.uid] })
    expect((await adminGet(weekPath(id, next)))?.judges).toEqual([sam.uid])
  })

  it('fails at once offline', async () => {
    await as(lena)
    const { db } = getFirebase()
    await disableNetwork(db)
    try {
      await rejectsWith(setJudge(id, true), OFFLINE)
    } finally {
      await enableNetwork(db)
    }
  })
})
