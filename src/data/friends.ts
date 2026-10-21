// Friends by friend request (batch 3, SPEC §11.6, §11.8): friend codes and links, and the pair docs friends/{a_b}.
// Every write that involves someone else is a transaction that fails at once offline (requireServer first): a queued
// request the rules refused later would show a state that never happened. Pure logic lives in domain/friends.ts.
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'
import { now } from '../domain/clock.ts'
import { ASK_AGAIN_DAYS, FRIEND_PARAM, friendsView, isSpaceInviteLink, normalizeFriendCode, pairId } from '../domain/friends.ts'
import { isUid, newInviteCode } from '../domain/ids.ts'
import type { AskResult, FriendLookup, Friendship, FriendsView, UID } from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import { ms, toFriendship, toProfile } from './convert.ts'
import { humanError, isDenied, MSG } from './errors.ts'
import { requireUser } from './session.ts'
import { requireServer } from './spaces.ts'
import { forgetWhere, type Start } from './store.ts'

const DAY = 86_400_000
/** How long the code hook waits for the server before saying it's offline (as requireServer). */
const REACH_TIMEOUT_MS = 8_000
/** New codes tried when one is taken (a create of an existing code is refused: there is no update rule). */
const CODE_TRIES = 5

export const FRIEND_MSG = {
  ownCode: 'That’s your own code.',
  noCode: 'No one has that code. Check it and try again.',
  spaceInvite: 'That’s a space invite. Join it from Spaces.',
  you: 'That’s you.',
  askFailed: 'Couldn’t send the request. Try again.',
  gone: 'This request is no longer there.',
  failed: 'Couldn’t do that. Try again.',
}

function db() {
  return getFirebase().db
}

function pairRef(a: UID, b: UID) {
  return doc(db(), 'friends', pairId(a, b))
}

function codeRef(code: string) {
  return doc(db(), 'friendCodes', code)
}

function myCodes(me: UID) {
  return query(collection(db(), 'friendCodes'), where('uid', '==', me))
}

const nonNull = <T>(x: T | null): x is T => x !== null

// ---------- Live data ----------

/**
 * Your pairs (one query: friends where users array-contains you), split by friendsView. When someone becomes your
 * friend, a ring of theirs that was refused before (not friends yet) is looked up again: Firestore never resumes a
 * refused listener, and useRing reads a refusal as "no ring".
 */
export function startFriendships(me: UID): Start<FriendsView> {
  return (emit) => {
    let known: Set<UID> | null = null
    return onSnapshot(
      query(collection(db(), 'friends'), where('users', 'array-contains', me)),
      (snap) => {
        const pairs: Friendship[] = snap.docs.map((d) => toFriendship(d, me)).filter(nonNull)
        const view = friendsView(pairs, me)
        const friends = new Set(view.friends.map((p) => p.uid))
        const fresh = known ? [...friends].filter((uid) => !known!.has(uid)) : []
        known = friends
        if (fresh.length > 0) {
          const keys = new Set(fresh.map((uid) => `${me}|ring|${uid}`))
          // After this emit: forgetting restarts listeners, which must not happen inside the store's own update.
          setTimeout(() => forgetWhere((key) => keys.has(key)), 0)
        }
        emit({ data: view, loading: false, error: null })
      },
      (error) => emit({ data: undefined, loading: false, error: humanError(error, MSG.noAccess) }),
    )
  }
}

/** The newest code: by createdAt (a pending one reads as the device's estimate), then by id. */
function newestCode(docs: QueryDocumentSnapshot[]): string | null {
  const codes = docs.map((d) => ({ code: d.id, at: ms(d.get('createdAt', { serverTimestamps: 'estimate' })) }))
  codes.sort((a, b) => b.at - a.at || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
  return codes[0]?.code ?? null
}

/** Creates a code for `me`, trying another when one is taken. Resolves once the server has it. */
async function createCode(me: UID): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const code = newInviteCode()
    try {
      await setDoc(codeRef(code), { uid: me, createdAt: serverTimestamp() })
      return code
    } catch (e) {
      if (!isDenied(e) || attempt >= CODE_TRIES) throw e
    }
  }
}

/**
 * Your current code: the newest friendCodes doc with your uid. With none on the server, it creates one. While only
 * the device's cache answers (offline) and it has none, the error is the offline message (the store retries).
 */
export function startMyFriendCode(me: UID): Start<string> {
  return (emit) => {
    let creating = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const offline = () => emit({ data: undefined, loading: false, error: new Error(MSG.offline) })
    const stop = onSnapshot(
      myCodes(me),
      { includeMetadataChanges: true },
      (snap) => {
        clearTimeout(timer)
        const code = newestCode(snap.docs)
        if (code) {
          emit({ data: code, loading: false, error: null })
          return
        }
        if (snap.metadata.fromCache) {
          // The cache has none; the server may. Wait for it a moment.
          if (typeof navigator !== 'undefined' && navigator.onLine === false) offline()
          else timer = setTimeout(offline, REACH_TIMEOUT_MS)
          return
        }
        if (creating) return
        creating = true
        createCode(me).catch((e: unknown) => {
          creating = false
          emit({ data: undefined, loading: false, error: humanError(e, MSG.generic) })
        })
      },
      (error) => emit({ data: undefined, loading: false, error: humanError(error, MSG.noAccess) }),
    )
    return () => {
      clearTimeout(timer)
      stop()
    }
  }
}

// ---------- Codes and links ----------

/** A new code, then the old ones deleted, in one batch: old links stop working at once. Fails at once offline. */
export async function resetFriendCode(): Promise<string> {
  const me = requireUser().uid
  await requireServer(me)
  try {
    const old = await getDocs(myCodes(me))
    for (let attempt = 1; ; attempt++) {
      const code = newInviteCode()
      const batch = writeBatch(db())
      batch.set(codeRef(code), { uid: me, createdAt: serverTimestamp() })
      for (const d of old.docs) if (d.id !== code) batch.delete(d.ref)
      try {
        await batch.commit()
        return code
      } catch (e) {
        // A taken code: try another.
        if (!isDenied(e) || attempt >= CODE_TRIES) throw e
      }
    }
  } catch (e) {
    throw humanError(e, MSG.generic)
  }
}

/** `<app url>?friend=CODE` for sharing (as inviteLink). */
export function friendLink(code: string): string {
  const base = typeof location !== 'undefined' ? `${location.origin}${location.pathname}` : ''
  return `${base}?${FRIEND_PARAM}=${encodeURIComponent(code)}`
}

/**
 * Whose code (or pasted link) it is, with their profile. A code whose owner has no profile (a deleted account's
 * leftover) is a miss; on a miss, one more read tells a space invite code apart.
 */
export async function lookupFriendCode(codeOrLink: string): Promise<FriendLookup> {
  const code = normalizeFriendCode(codeOrLink)
  if (code === null) throw new Error(isSpaceInviteLink(codeOrLink) ? FRIEND_MSG.spaceInvite : FRIEND_MSG.noCode)
  const me = requireUser().uid
  try {
    const snap = await getDoc(codeRef(code))
    const uid: unknown = snap.exists() ? snap.get('uid') : null
    if (uid === me) throw new Error(FRIEND_MSG.ownCode)
    if (isUid(uid)) {
      const profile = await getDoc(doc(db(), 'users', uid))
      if (profile.exists()) return { code, uid, profile: toProfile(profile) }
    }
    const invite = await getDoc(doc(db(), 'invites', code))
    throw new Error(invite.exists() ? FRIEND_MSG.spaceInvite : FRIEND_MSG.noCode)
  } catch (e) {
    throw humanError(e, MSG.noAccess)
  }
}

// ---------- Requests ----------

function checkOther(me: UID, uid: UID, message: string): void {
  if (uid === me) throw new Error(FRIEND_MSG.you)
  if (!isUid(uid)) throw new Error(message)
}

/**
 * A transaction reads the pair: none → a request; theirs asked or declined → friends (mutual); theirs withdrawn →
 * taken over (now yours, asked); yours asked or declined → 'already-asked'; yours withdrawn → asked again once 30
 * days have passed, else 'too-soon' (nothing written); friends → 'already-friends'.
 */
export async function askFriend(uid: UID): Promise<AskResult> {
  const me = requireUser().uid
  checkOther(me, uid, FRIEND_MSG.askFailed)
  await requireServer(me)
  const ref = pairRef(me, uid)
  try {
    return await runTransaction(db(), async (tx): Promise<AskResult> => {
      const snap = await tx.get(ref)
      if (!snap.exists()) {
        tx.set(ref, { users: me < uid ? [me, uid] : [uid, me], by: me, state: 'asked', at: serverTimestamp() })
        return 'asked'
      }
      const pair = toFriendship(snap, me)
      if (!pair) throw new Error(FRIEND_MSG.askFailed)
      if (pair.state === 'friends') return 'already-friends'
      if (pair.by !== me) {
        if (pair.state === 'withdrawn') {
          tx.update(ref, { by: me, state: 'asked', at: serverTimestamp() })
          return 'asked'
        }
        tx.update(ref, { state: 'friends', at: serverTimestamp() })
        return 'friends'
      }
      if (pair.state !== 'withdrawn') return 'already-asked'
      // As askAgainAt: the rules need the server's time to be past it.
      if (now() <= pair.at + ASK_AGAIN_DAYS * DAY) return 'too-soon'
      tx.update(ref, { state: 'asked', at: serverTimestamp() })
      return 'asked'
    })
  } catch (e) {
    throw humanError(e, FRIEND_MSG.askFailed)
  }
}

/** Accepts `uid`'s pending (or earlier declined) request. Already friends: resolves. Fails at once offline. */
export async function acceptFriend(uid: UID): Promise<void> {
  const me = requireUser().uid
  checkOther(me, uid, FRIEND_MSG.failed)
  await requireServer(me)
  const ref = pairRef(me, uid)
  try {
    await runTransaction(db(), async (tx) => {
      const snap = await tx.get(ref)
      const pair = snap.exists() ? toFriendship(snap, me) : null
      if (pair?.state === 'friends') return
      if (!pair || pair.by === me || (pair.state !== 'asked' && pair.state !== 'declined')) throw new Error(FRIEND_MSG.gone)
      tx.update(ref, { state: 'friends', at: serverTimestamp() })
    })
  } catch (e) {
    throw humanError(e, FRIEND_MSG.failed)
  }
}

/** Declines `uid`'s request, silently (`at` stays: they keep seeing "Requested"). Fails at once offline. */
export async function declineFriend(uid: UID): Promise<void> {
  const me = requireUser().uid
  checkOther(me, uid, FRIEND_MSG.failed)
  await requireServer(me)
  const ref = pairRef(me, uid)
  try {
    await runTransaction(db(), async (tx) => {
      const snap = await tx.get(ref)
      const pair = snap.exists() ? toFriendship(snap, me) : null
      if (pair && pair.by !== me && pair.state === 'declined') return
      if (!pair || pair.by === me || pair.state !== 'asked') throw new Error(FRIEND_MSG.gone)
      tx.update(ref, { state: 'declined' })
    })
  } catch (e) {
    throw humanError(e, FRIEND_MSG.failed)
  }
}

/** Cancels your request to `uid` (pending or silently declined): a 'withdrawn' tombstone, dated now. Anything else
 *  is left as it is. Fails at once offline. */
export async function cancelFriendRequest(uid: UID): Promise<void> {
  const me = requireUser().uid
  checkOther(me, uid, FRIEND_MSG.failed)
  await requireServer(me)
  const ref = pairRef(me, uid)
  try {
    await runTransaction(db(), async (tx) => {
      const snap = await tx.get(ref)
      const pair = snap.exists() ? toFriendship(snap, me) : null
      if (!pair || pair.by !== me || (pair.state !== 'asked' && pair.state !== 'declined')) return
      tx.update(ref, { state: 'withdrawn', at: serverTimestamp() })
    })
  } catch (e) {
    throw humanError(e, FRIEND_MSG.failed)
  }
}

/** Ends a friendship (deletes the pair); anything that isn't a friendship is left as it is. Fails at once offline. */
export async function removeFriend(uid: UID): Promise<void> {
  const me = requireUser().uid
  checkOther(me, uid, FRIEND_MSG.failed)
  await requireServer(me)
  const ref = pairRef(me, uid)
  try {
    await runTransaction(db(), async (tx) => {
      const snap = await tx.get(ref)
      if (snap.exists() && toFriendship(snap, me)?.state === 'friends') tx.delete(ref)
    })
  } catch (e) {
    throw humanError(e, FRIEND_MSG.failed)
  }
}

// ---------- Account deletion (SPEC §11.12) ----------

/** Step 3: every friend code of yours. */
export async function deleteMyFriendCodes(me: UID): Promise<void> {
  const snap = await getDocs(myCodes(me))
  await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)))
}

/** Step 4 (after the profile is gone): every pair you are in, friendships, requests both ways and tombstones. */
export async function deleteMyFriendships(me: UID): Promise<void> {
  const snap = await getDocs(query(collection(db(), 'friends'), where('users', 'array-contains', me)))
  await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)))
}
