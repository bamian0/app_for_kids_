// Spaces, invites and membership.
import {
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  deleteField,
  doc,
  FieldPath,
  getDoc,
  getDocFromServer,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
  type DocumentReference,
  type DocumentSnapshot,
  type WriteBatch,
} from 'firebase/firestore'
import { now } from '../domain/clock.ts'
import { newInviteCode, normalizeInviteCode } from '../domain/ids.ts'
import { addWeeks, utcOffsetMinutes, weekIdFor } from '../domain/time.ts'
import type { Invite, Space, UID } from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import { toInvite, toSpace, toWeek } from './convert.ts'
import { errorCode, humanError, isDenied, MSG } from './errors.ts'
import { cleanText, myName, profileRef, requireUser } from './session.ts'
import { forgetWhere, type Start } from './store.ts'
import { weekRef } from './weeks.ts'

export const MAX_MEMBERS = 8

const MSG_BAD_CODE = "That code doesn't look right. Invite codes have 8 letters and numbers."
const MSG_UNKNOWN_CODE = 'No space uses this code. Check it with your friend and try again.'
const MSG_FULL = `This space is full. A space can have up to ${MAX_MEMBERS} people.`

/** This device's IANA zone. Some environments report a zone they can't use (e.g. "Etc/Unknown"). */
export function deviceTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return zone
  } catch {
    return 'UTC'
  }
}

function spaceRef(spaceId: string) {
  return doc(getFirebase().db, 'spaces', spaceId)
}

export function startMySpaces(uid: string): Start<Space[]> {
  return (emit) =>
    onSnapshot(
      query(collection(getFirebase().db, 'spaces'), where('memberIds', 'array-contains', uid)),
      (snap) => {
        const spaces = snap.docs.map(toSpace)
        // The order you joined them in: stable, and new spaces land at the bottom.
        spaces.sort((a, b) => (a.joinedAt[uid] ?? a.createdAt) - (b.joinedAt[uid] ?? b.createdAt) || a.id.localeCompare(b.id))
        emit({ data: spaces, loading: false, error: null })
      },
      (error) => emit({ data: undefined, loading: false, error: humanError(error, MSG.noAccess) }),
    )
}

export function startSpace(spaceId: string): Start<Space | null> {
  return (emit) =>
    onSnapshot(
      spaceRef(spaceId),
      (snap) => emit({ data: snap.exists() ? toSpace(snap) : null, loading: false, error: null }),
      // Reads are denied once you are not a member (e.g. you just left): that space is simply gone for you.
      (error) => emit(isDenied(error) ? { data: null, loading: false, error: null } : { data: undefined, loading: false, error: humanError(error, MSG.noAccess) }),
    )
}

/** How long createSpace waits to hear from the server before calling it offline. */
const REACH_TIMEOUT_MS = 8_000

/**
 * Resolves once the server answers, or throws the offline message. Writes made while offline wait
 * in a queue and land later, which for a new space means a spinner that never ends and a duplicate
 * when the user tries again.
 */
async function requireServer(uid: UID): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error(MSG.offline)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(MSG.offline)), REACH_TIMEOUT_MS)
  })
  try {
    await Promise.race([getDocFromServer(profileRef(getFirebase().db, uid)), timeout])
  } catch (e) {
    if (e instanceof Error && e.message === MSG.offline) throw e
    // Denied or missing profile still proves the server answered.
    if (errorCode(e) === 'unavailable' || errorCode(e) === 'deadline-exceeded') throw new Error(MSG.offline)
  } finally {
    clearTimeout(timer)
  }
}

/** Creating the same space twice at once (tap, cancel, tap again) returns the first attempt. */
const creating = new Map<string, Promise<Space>>()

/** Creates the space (timezone = this device's IANA zone) and its invite doc, in one batch. */
export function createSpace(input: { name: string; reward: string; penalty: string }): Promise<Space> {
  let name: string, reward: string, penalty: string, uid: UID
  try {
    name = cleanText(input.name, 40, 'Space name')
    reward = cleanText(input.reward, 120, 'Reward')
    penalty = cleanText(input.penalty, 120, 'Penalty')
    uid = requireUser().uid
  } catch (e) {
    return Promise.reject(e)
  }
  const key = JSON.stringify([uid, name, reward, penalty])
  let pending = creating.get(key)
  if (!pending) {
    pending = writeSpace(uid, name, reward, penalty).finally(() => creating.delete(key))
    creating.set(key, pending)
  }
  return pending
}

async function writeSpace(uid: UID, name: string, reward: string, penalty: string): Promise<Space> {
  const user = requireUser()
  const { db } = getFirebase()
  const ref = doc(collection(db, 'spaces'))
  const inviteCode = newInviteCode()
  const timezone = deviceTimeZone()
  // The zone's offset today. The rules anchor every week to it; ±1h covers DST.
  const utcOffsetMin = Math.round(utcOffsetMinutes(timezone, Date.now()))
  try {
    await requireServer(uid)
    const inviterName = await myName(user)
    const batch = writeBatch(db)
    batch.set(ref, {
      name,
      reward,
      penalty,
      ownerId: uid,
      memberIds: [uid],
      joinedAt: { [uid]: serverTimestamp() },
      timezone,
      utcOffsetMin,
      inviteCode,
      threshold: 90,
      latePenalty: 5,
      createdAt: serverTimestamp(),
    })
    batch.set(doc(db, 'invites', inviteCode), { spaceId: ref.id, spaceName: name, reward, penalty, inviterName, createdBy: uid, createdAt: serverTimestamp() })
    await batch.commit()
  } catch (e) {
    throw humanError(e, MSG.generic)
  }
  const at = Date.now()
  return {
    id: ref.id,
    name,
    reward,
    penalty,
    ownerId: uid,
    memberIds: [uid],
    joinedAt: { [uid]: at },
    timezone,
    utcOffsetMin,
    inviteCode,
    threshold: 90,
    latePenalty: 5,
    createdAt: at,
  }
}

/** Accepts a code or invite link; null if unknown. Works signed out (the welcome screen's preview). */
export async function lookupInvite(codeOrLink: string): Promise<Invite | null> {
  const code = normalizeInviteCode(codeOrLink)
  if (!code) return null
  try {
    const snap = await getDoc(doc(getFirebase().db, 'invites', code))
    return snap.exists() ? toInvite(snap) : null
  } catch (e) {
    throw humanError(e, MSG.noAccess)
  }
}

/** Joins via code or link and returns the spaceId. No-op if already a member. */
export async function joinSpace(codeOrLink: string): Promise<string> {
  const code = normalizeInviteCode(codeOrLink)
  if (!code) throw new Error(MSG_BAD_CODE)
  const invite = await lookupInvite(code)
  if (!invite) throw new Error(MSG_UNKNOWN_CODE)
  const uid = requireUser().uid
  const { db } = getFirebase()
  const ref = spaceRef(invite.spaceId)
  try {
    // Members can read the space; everyone else is denied, which just means "not joined yet".
    const snap = await getDoc(ref)
    if (snap.exists() && toSpace(snap).memberIds.includes(uid)) return invite.spaceId
  } catch (e) {
    if (!isDenied(e)) throw humanError(e)
  }
  const batch = writeBatch(db)
  batch.set(doc(db, 'spaces', invite.spaceId, 'joins', uid), { code, createdAt: serverTimestamp() })
  batch.update(ref, 'memberIds', arrayUnion(uid), new FieldPath('joinedAt', uid), serverTimestamp())
  try {
    await batch.commit()
  } catch (e) {
    // The invite exists, so a denied join means the member cap was hit (or the code was just reset).
    throw humanError(e, MSG_FULL)
  }
  // A refusal from before the join (left a moment ago) must not linger on screen.
  forgetSpace(uid, invite.spaceId)
  return invite.spaceId
}

/** Drops everything cached about a space for this user (after joining or leaving it). */
function forgetSpace(uid: UID, spaceId: string): void {
  const exact = [`${uid}|space|${spaceId}`, `${uid}|settlements|${spaceId}`]
  const prefixes = [`${uid}|week|${spaceId}|`, `${uid}|month|${spaceId}|`, `${uid}|months|${spaceId}|`]
  forgetWhere((key) => exact.includes(key) || prefixes.some((p) => key.startsWith(p)))
}

/**
 * Adds to `batch` the removal of `uid` from the weeks that haven't locked yet: this week while it is
 * still planning, and next week. A week that has locked is a commitment and is never touched: the
 * leaver stays in it, is still reviewed, and their score counts toward the month (see SPEC §1).
 */
async function leaveUnlockedWeeks(batch: WriteBatch, space: Space, uid: UID): Promise<void> {
  let thisWeek: string
  try {
    thisWeek = weekIdFor(now(), space.timezone)
  } catch {
    return
  }
  for (const weekId of [thisWeek, addWeeks(thisWeek, 1)]) {
    const snap = await getDoc(weekRef(space.id, weekId)).catch(() => null)
    if (!snap?.exists()) continue
    const week = toWeek(snap, space.id)
    // The stored lockAt decides, as in the rules.
    if (!week.members.includes(uid) || now() >= week.lockAt) continue
    batch.update(snap.ref, { members: arrayRemove(uid) })
  }
}

/** The member who joined first (ownership passes to them when the owner leaves). */
function earliestJoined(space: Space, among: UID[]): UID {
  return among.reduce((best, uid) => ((space.joinedAt[uid] ?? Infinity) < (space.joinedAt[best] ?? Infinity) ? uid : best))
}

/**
 * Takes `uid` out of the space (and the weeks that haven't locked) in one batch. `patch` adds to the
 * space update (the new owner). If the weeks part is refused (a lock just passed), the space part
 * still goes and the leaver stays in that week, as they should once it has locked.
 */
async function removeFromSpace(ref: DocumentReference, space: Space, uid: UID, patch: Record<string, unknown> = {}): Promise<void> {
  const write = async (withWeeks: boolean) => {
    const batch = writeBatch(getFirebase().db)
    if (withWeeks) await leaveUnlockedWeeks(batch, space, uid)
    const extra = Object.entries(patch).flat()
    batch.update(ref, 'memberIds', arrayRemove(uid), new FieldPath('joinedAt', uid), deleteField(), new FieldPath('leftAt', uid), serverTimestamp(), ...extra)
    await batch.commit()
  }
  try {
    await write(true)
  } catch (e) {
    if (!isDenied(e)) throw e
    await write(false)
  }
}

async function leave(snap: DocumentSnapshot, uid: string): Promise<void> {
  if (!snap.exists()) return
  const space = toSpace(snap)
  if (!space.memberIds.includes(uid)) return
  const others = space.memberIds.filter((m) => m !== uid)
  if (others.length === 0 && space.inviteCode) {
    // Last one out retires the invite, so the code can't revive an empty space.
    await deleteDoc(doc(getFirebase().db, 'invites', space.inviteCode)).catch(() => {})
  }
  // An owner who leaves others behind hands the space to whoever joined first.
  const patch = space.ownerId === uid && others.length > 0 ? { ownerId: earliestJoined(space, others) } : {}
  await removeFromSpace(snap.ref, space, uid, patch)
  forgetSpace(uid, space.id)
}

export async function leaveSpace(spaceId: string): Promise<void> {
  const uid = requireUser().uid
  try {
    await leave(await getDoc(spaceRef(spaceId)), uid)
  } catch (e) {
    // Denied reading the space: already not a member.
    if (!isDenied(e)) throw humanError(e)
  }
}

/** Leaves every space the user is in (account deletion). */
export async function leaveAllSpaces(uid: string): Promise<void> {
  const snap = await getDocs(query(collection(getFirebase().db, 'spaces'), where('memberIds', 'array-contains', uid)))
  for (const space of snap.docs) await leave(space, uid)
}

/**
 * A space whose owner left before ownership moved with them (older versions) goes to its
 * earliest-joined member, so someone can remove members and reset the code again.
 */
export async function claimOwnership(space: Space): Promise<void> {
  const me = getFirebase().auth.currentUser?.uid
  if (!me || space.memberIds.length === 0 || space.memberIds.includes(space.ownerId)) return
  if (earliestJoined(space, space.memberIds) !== me) return
  await updateDoc(spaceRef(space.id), { ownerId: me })
}

/**
 * The owner takes someone out of the space (a leaked invite, a second account). Like leaving, it only
 * takes them out of weeks that haven't locked: a locked week still reviews and scores them.
 */
export async function removeMember(spaceId: string, uid: UID): Promise<void> {
  const me = requireUser().uid
  try {
    const snap = await getDoc(spaceRef(spaceId))
    if (!snap.exists()) throw new Error(MSG.noAccess)
    const space = toSpace(snap)
    if (space.ownerId !== me) throw new Error('Only the owner can remove people.')
    if (uid === me) throw new Error(MSG.generic)
    if (!space.memberIds.includes(uid)) return
    await removeFromSpace(snap.ref, space, uid)
  } catch (e) {
    throw humanError(e, MSG.noAccess)
  }
}

/**
 * The owner replaces the invite code: the space gets a new one, its invite moves to it, and the old
 * code stops working (the rules only accept joins with the space's current code). Returns the new code.
 */
export async function resetInviteCode(spaceId: string): Promise<string> {
  const user = requireUser()
  const { db } = getFirebase()
  try {
    const snap = await getDocFromServer(spaceRef(spaceId))
    if (!snap.exists()) throw new Error(MSG.noAccess)
    const space = toSpace(snap)
    if (space.ownerId !== user.uid) throw new Error('Only the owner can reset the invite code.')
    const code = newInviteCode()
    const inviterName = await myName(user)
    const batch = writeBatch(db)
    batch.update(snap.ref, { inviteCode: code })
    batch.set(doc(db, 'invites', code), {
      spaceId, spaceName: space.name, reward: space.reward, penalty: space.penalty, inviterName, createdBy: user.uid, createdAt: serverTimestamp(),
    })
    if (space.inviteCode) {
      const old = doc(db, 'invites', space.inviteCode)
      // Deleting a missing doc is refused by the rules, so only delete what is there.
      if ((await getDoc(old).catch(() => null))?.exists()) batch.delete(old)
    }
    await batch.commit()
    return code
  } catch (e) {
    throw humanError(e, MSG.noAccess)
  }
}

export async function updateSpace(spaceId: string, patch: Partial<Pick<Space, 'name' | 'reward' | 'penalty'>>): Promise<void> {
  const clean: Partial<Record<'name' | 'reward' | 'penalty', string>> = {}
  if (patch.name !== undefined) clean.name = cleanText(patch.name, 40, 'Space name')
  if (patch.reward !== undefined) clean.reward = cleanText(patch.reward, 120, 'Reward')
  if (patch.penalty !== undefined) clean.penalty = cleanText(patch.penalty, 120, 'Penalty')
  if (Object.keys(clean).length === 0) return
  requireUser()
  try {
    await updateDoc(spaceRef(spaceId), clean)
  } catch (e) {
    throw humanError(e, MSG.noAccess)
  }
  // The join preview shows the invite's copy of the name and stakes. Best effort: the space is
  // already updated, and the invite must match it exactly.
  const snap = await getDoc(spaceRef(spaceId)).catch(() => null)
  if (!snap?.exists()) return
  const space = toSpace(snap)
  if (space.inviteCode) {
    await updateDoc(doc(getFirebase().db, 'invites', space.inviteCode), { spaceName: space.name, reward: space.reward, penalty: space.penalty }).catch(() => {})
  }
}

/** `<app url>?join=CODE` for sharing. */
export function inviteLink(space: Space): string {
  return `${location.origin}${location.pathname}?join=${space.inviteCode}`
}
