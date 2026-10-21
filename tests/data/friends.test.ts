// Friends by friend request (SPEC §11.6, §11.8) against the emulators and the real rules, through the functions the
// screens call: codes and links, asking, accepting, the silent decline, the 30-day wait after a cancel, taking over a
// canceled request, removing, and who can read a ring.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { collection, disableNetwork, enableNetwork, getDocsFromServer, query, where } from 'firebase/firestore'
import {
  acceptFriend,
  askFriend,
  cancelFriendRequest,
  declineFriend,
  friendLink,
  lookupFriendCode,
  removeFriend,
  resetFriendCode,
} from '../../src/data/api.ts'
import { startFriendships, startMyFriendCode } from '../../src/data/friends.ts'
import { ringKey, startRing } from '../../src/data/showcase.ts'
import { forget, peek, watch } from '../../src/data/store.ts'
import { formatInviteCode } from '../../src/domain/ids.ts'
import { friendsView, pairId } from '../../src/domain/friends.ts'
import { toFriendship } from '../../src/data/convert.ts'
import type { FriendsView, Ring } from '../../src/domain/types.ts'
import { getFirebase } from '../../src/firebase/app.ts'
import {
  adminGet,
  adminList,
  as,
  createUser,
  DAY,
  eventually,
  observe,
  rejectsWith,
  seed,
  setupEmulators,
  teardownEmulators,
  ts,
  type TestUser,
} from './helpers.ts'

const OFFLINE = 'You’re offline. Check your connection and try again.'
const NO_CODE = 'No one has that code. Check it and try again.'
const SPACE_INVITE = 'That’s a space invite. Join it from Spaces.'

let ana: TestUser
let ben: TestUser
let cleo: TestUser
let dan: TestUser
let zed: TestUser

beforeAll(async () => {
  await setupEmulators()
  ana = await createUser('Ana')
  ben = await createUser('Ben')
  cleo = await createUser('Cleo')
  dan = await createUser('Dan')
  zed = await createUser('Zed')
})
afterAll(teardownEmulators)

const pairPath = (a: TestUser, b: TestUser) => `friends/${pairId(a.uid, b.uid)}`

/** `user`'s friends view, as a listener signed in as them sees it once it has the server's answer (the device's cache
 *  may hold another account's copy first: the tests switch accounts on one client). */
async function viewOf(user: TestUser): Promise<FriendsView> {
  await as(user)
  const { db } = getFirebase()
  const server = await getDocsFromServer(query(collection(db, 'friends'), where('users', 'array-contains', user.uid)))
  const expected = friendsView(server.docs.map((d) => toFriendship(d, user.uid)).filter((p) => p !== null), user.uid)
  const live = observe(startFriendships(user.uid))
  const state = await live.until((l) => JSON.stringify(l.data) === JSON.stringify(expected))
  live.stop()
  return state.data!
}

/** Who is in each list of a view, by name. */
function lists(view: FriendsView) {
  const name = (uid: string) => [ana, ben, cleo, dan, zed].find((u) => u.uid === uid)?.name ?? uid
  return {
    friends: view.friends.map((p) => name(p.uid)),
    incoming: view.incoming.map((p) => name(p.uid)),
    sent: view.sent.map((p) => name(p.uid)),
    withdrawn: view.withdrawn.map((p) => name(p.uid)),
  }
}

async function myCode(user: TestUser): Promise<string> {
  await as(user)
  const live = observe(startMyFriendCode(user.uid))
  const state = await live.until((l) => l.data !== undefined)
  live.stop()
  return state.data!
}

describe('asking and answering', () => {
  it('a request, then an accept: both are friends', async () => {
    await as(ana)
    expect(await askFriend(ben.uid)).toBe('asked')
    expect(await adminGet(pairPath(ana, ben))).toMatchObject({ users: [ana.uid, ben.uid].sort(), by: ana.uid, state: 'asked' })
    expect(lists(await viewOf(ana))).toEqual({ friends: [], incoming: [], sent: ['Ben'], withdrawn: [] })
    expect(lists(await viewOf(ben))).toEqual({ friends: [], incoming: ['Ana'], sent: [], withdrawn: [] })
    // Asking again changes nothing.
    await as(ana)
    expect(await askFriend(ben.uid)).toBe('already-asked')
    await as(ben)
    await acceptFriend(ana.uid)
    expect(await adminGet(pairPath(ana, ben))).toMatchObject({ by: ana.uid, state: 'friends' })
    expect(lists(await viewOf(ana)).friends).toEqual(['Ben'])
    expect(lists(await viewOf(ben)).friends).toEqual(['Ana'])
    expect(await askFriend(ana.uid)).toBe('already-friends')
    // A second accept (another device) resolves.
    await acceptFriend(ana.uid)
  })

  it('asking someone who asked you makes you friends at once', async () => {
    await as(ana)
    expect(await askFriend(cleo.uid)).toBe('asked')
    await as(cleo)
    expect(await askFriend(ana.uid)).toBe('friends')
    expect((await adminGet(pairPath(ana, cleo)))?.state).toBe('friends')
  })

  it('a decline is silent: the asker still sees "Requested"; the decliner can still add them later', async () => {
    await as(dan)
    expect(await askFriend(ben.uid)).toBe('asked')
    const asked = await adminGet(pairPath(dan, ben))
    await as(ben)
    await declineFriend(dan.uid)
    const declined = await adminGet(pairPath(dan, ben))
    expect(declined).toMatchObject({ state: 'declined', by: dan.uid })
    expect(declined!.at.isEqual(asked!.at)).toBe(true)
    // Declining again (another device) resolves.
    await declineFriend(dan.uid)
    expect(lists(await viewOf(ben)).incoming).toEqual([])
    expect(lists(await viewOf(dan)).sent).toEqual(['Ben'])
    expect(await askFriend(ben.uid)).toBe('already-asked')
    // Ben changes his mind: asking Dan accepts Dan's request, which still stands.
    await as(ben)
    expect(await askFriend(dan.uid)).toBe('friends')
    expect((await adminGet(pairPath(dan, ben)))?.state).toBe('friends')
  })

  it('accepting after declining works too', async () => {
    await as(zed)
    await askFriend(cleo.uid)
    await as(cleo)
    await declineFriend(zed.uid)
    await acceptFriend(zed.uid)
    expect((await adminGet(pairPath(zed, cleo)))?.state).toBe('friends')
    await removeFriend(zed.uid)
  })

  it('a canceled request is hidden from both and can be sent again only after 30 days', async () => {
    await as(ana)
    expect(await askFriend(dan.uid)).toBe('asked')
    await cancelFriendRequest(dan.uid)
    const pair = await adminGet(pairPath(ana, dan))
    expect(pair).toMatchObject({ state: 'withdrawn', by: ana.uid })
    expect(lists(await viewOf(ana))).toMatchObject({ sent: [], withdrawn: ['Dan'] })
    expect(lists(await viewOf(dan))).toMatchObject({ incoming: [], sent: [], withdrawn: [] })
    await as(ana)
    expect(await askFriend(dan.uid)).toBe('too-soon')
    expect((await adminGet(pairPath(ana, dan)))?.at.isEqual(pair!.at)).toBe(true)
    // Canceling again changes nothing.
    await cancelFriendRequest(dan.uid)
    // 31 days later.
    await seed({ [pairPath(ana, dan)]: { ...pair, at: ts(Date.now() - 31 * DAY) } })
    expect(await askFriend(dan.uid)).toBe('asked')
    expect(lists(await viewOf(dan)).incoming).toEqual(['Ana'])
    await as(ana)
    await cancelFriendRequest(dan.uid)
  })

  it('the other person can add the asker after a cancel: the request becomes theirs', async () => {
    await as(cleo)
    await askFriend(dan.uid)
    await cancelFriendRequest(dan.uid)
    await as(dan)
    expect(await askFriend(cleo.uid)).toBe('asked')
    expect(await adminGet(pairPath(cleo, dan))).toMatchObject({ by: dan.uid, state: 'asked' })
    expect(lists(await viewOf(cleo)).incoming).toEqual(['Dan'])
    await acceptFriend(dan.uid)
    expect((await adminGet(pairPath(cleo, dan)))?.state).toBe('friends')
  })

  it('either side removes a friendship; either can ask again at once', async () => {
    await as(ben)
    await removeFriend(ana.uid)
    expect(await adminGet(pairPath(ana, ben))).toBeUndefined()
    expect(lists(await viewOf(ana)).friends).not.toContain('Ben')
    expect(lists(await viewOf(ben)).friends).not.toContain('Ana')
    // Nothing to remove: resolves. A pending request isn't removed by it.
    await removeFriend(ana.uid)
    expect(await askFriend(ana.uid)).toBe('asked')
    await removeFriend(ana.uid)
    expect((await adminGet(pairPath(ana, ben)))?.state).toBe('asked')
    await as(ana)
    await acceptFriend(ben.uid)
    expect((await adminGet(pairPath(ana, ben)))?.state).toBe('friends')
  })

  it('refuses requests that can\'t be', async () => {
    await as(ana)
    await rejectsWith(askFriend(ana.uid), 'That’s you.')
    // Someone without a profile (a deleted account).
    await rejectsWith(askFriend('nobodyHere123'), 'Couldn’t send the request. Try again.')
    await rejectsWith(askFriend('not_a_uid'), 'Couldn’t send the request. Try again.')
    // Accepting or declining what isn't there.
    await rejectsWith(acceptFriend(zed.uid), 'This request is no longer there.')
    await rejectsWith(declineFriend(zed.uid), 'This request is no longer there.')
    // Your own request isn't yours to accept.
    await askFriend(zed.uid)
    await rejectsWith(acceptFriend(zed.uid), 'This request is no longer there.')
    await rejectsWith(declineFriend(zed.uid), 'This request is no longer there.')
    await cancelFriendRequest(zed.uid)
  })
})

describe('codes and links', () => {
  it('your code is created the first time it is needed, and stays', async () => {
    const code = await myCode(ana)
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
    // Shown as soon as this device has it; on the server a moment later.
    await eventually(async () => (await adminGet(`friendCodes/${code}`))?.uid === ana.uid)
    expect(await myCode(ana)).toBe(code)
    expect(await adminList('friendCodes')).toEqual([code])
    expect(friendLink(code)).toBe(`?friend=${code}`)
  })

  it('looks a code up by code, with a dash, in lower case, or in a link', async () => {
    const code = await myCode(ana)
    await as(ben)
    for (const input of [code, formatInviteCode(code), formatInviteCode(code).toLowerCase(), ` ${code.slice(0, 4)} ${code.slice(4)} `, `https://stakes.app/?friend=${code}`]) {
      const found = await lookupFriendCode(input)
      expect(found).toMatchObject({ code, uid: ana.uid, profile: { uid: ana.uid, name: 'Ana' } })
    }
  })

  it('says what a code is when it isn\'t a friend\'s', async () => {
    const code = await myCode(ana)
    await rejectsWith(lookupFriendCode(code), 'That’s your own code.')
    await seed({
      'invites/SPCE2345': { spaceId: 's1', spaceName: 'Film Club', reward: 'r', penalty: 'p', inviterName: 'Ben', createdBy: ben.uid, createdAt: ts(Date.now()) },
      'friendCodes/GHST2345': { uid: 'deletedAccount1', createdAt: ts(Date.now()) },
    })
    await rejectsWith(lookupFriendCode('ZZZZ2345'), NO_CODE)
    await rejectsWith(lookupFriendCode('not a code'), NO_CODE)
    await rejectsWith(lookupFriendCode('https://stakes.app/?join=SPCE2345'), SPACE_INVITE)
    await rejectsWith(lookupFriendCode('SPCE-2345'), SPACE_INVITE)
    // The owner's profile is gone: a miss.
    await rejectsWith(lookupFriendCode('GHST2345'), NO_CODE)
  })

  it('Reset Link: a new code, and the old one stops working at once', async () => {
    const old = await myCode(cleo)
    await as(cleo)
    const live = observe(startMyFriendCode(cleo.uid))
    await live.until((l) => l.data === old)
    const fresh = await resetFriendCode()
    expect(fresh).not.toBe(old)
    await live.until((l) => l.data === fresh)
    live.stop()
    expect(await adminGet(`friendCodes/${old}`)).toBeUndefined()
    expect(await adminGet(`friendCodes/${fresh}`)).toMatchObject({ uid: cleo.uid })
    await as(ben)
    await rejectsWith(lookupFriendCode(old), NO_CODE)
    expect((await lookupFriendCode(fresh)).uid).toBe(cleo.uid)
  })
})

describe('offline', () => {
  it('every friend write fails at once, and nothing is queued', async () => {
    await as(zed)
    const { db } = getFirebase()
    await disableNetwork(db)
    try {
      await rejectsWith(askFriend(dan.uid), OFFLINE)
      await rejectsWith(acceptFriend(dan.uid), OFFLINE)
      await rejectsWith(declineFriend(dan.uid), OFFLINE)
      await rejectsWith(cancelFriendRequest(dan.uid), OFFLINE)
      await rejectsWith(removeFriend(dan.uid), OFFLINE)
      await rejectsWith(resetFriendCode(), OFFLINE)
      await rejectsWith(lookupFriendCode('QQQQ2345'), OFFLINE)
    } finally {
      await enableNetwork(db)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await adminGet(pairPath(zed, dan))).toBeUndefined()
  })

  it('your code, offline before it exists: the offline message', async () => {
    await as(dan)
    const { db } = getFirebase()
    await disableNetwork(db)
    try {
      const live = observe(startMyFriendCode(dan.uid))
      const state = await live.until((l) => l.error !== null, 15_000)
      live.stop()
      expect(state.error?.message).toBe(OFFLINE)
    } finally {
      await enableNetwork(db)
    }
  })
})

describe('rings', () => {
  const ring = { monthId: '2026-10', score: 92.5, final: false, spaces: 2, updatedAt: ts(Date.now()) }

  it('a friend reads your ring; anyone else reads none', async () => {
    await seed({ [`rings/${ana.uid}`]: ring })
    // Ana and Cleo are friends (above).
    await as(cleo)
    const live = observe(startRing(ana.uid))
    expect((await live.until((l) => l.data !== undefined)).data).toMatchObject({ uid: ana.uid, monthId: '2026-10', score: 92.5, final: false, spaces: 2 })
    live.stop()
    await as(zed)
    const stranger = observe(startRing(ana.uid))
    // (This client's cache still has Cleo's copy: the server's refusal follows it.)
    expect(await stranger.until((l) => l.data === null)).toEqual({ data: null, loading: false, error: null })
    stranger.stop()
    // Your own.
    await as(ana)
    const own = observe(startRing(ana.uid))
    expect((await own.until((l) => l.data !== undefined)).data?.score).toBe(92.5)
    own.stop()
  })

  it('a ring refused before becomes readable once you are friends', async () => {
    await seed({ [`rings/${ana.uid}`]: ring })
    await as(zed)
    const noop = () => {}
    const releaseFriends = watch(`${zed.uid}|friends`, startFriendships(zed.uid), noop)
    const releaseRing = watch(ringKey(zed.uid, ana.uid), startRing(ana.uid), noop)
    await eventually(() => peek(`${zed.uid}|friends`).data !== undefined && peek(ringKey(zed.uid, ana.uid)).data === null)
    await seed({ [pairPath(ana, zed)]: { users: [ana.uid, zed.uid].sort(), by: ana.uid, state: 'friends', at: ts(Date.now()) } })
    await eventually(() => (peek<Ring | null>(ringKey(zed.uid, ana.uid)).data?.score ?? null) === 92.5)
    releaseRing()
    releaseFriends()
    forget(ringKey(zed.uid, ana.uid))
    forget(`${zed.uid}|friends`)
  })
})
