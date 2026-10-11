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
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type DocumentSnapshot,
} from 'firebase/firestore'
import { newInviteCode, normalizeInviteCode } from '../domain/ids.ts'
import type { Invite, Space } from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import { toInvite, toSpace } from './convert.ts'
import { humanError, isDenied, MSG } from './errors.ts'
import { cleanText, myName, requireUser } from './session.ts'
import type { Start } from './store.ts'

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

/** Creates the space (timezone = this device's IANA zone) and its invite doc. */
export async function createSpace(input: { name: string; reward: string; penalty: string }): Promise<Space> {
  const name = cleanText(input.name, 40, 'Space name')
  const reward = cleanText(input.reward, 120, 'Reward')
  const penalty = cleanText(input.penalty, 120, 'Penalty')
  const user = requireUser()
  const uid = user.uid
  const { db } = getFirebase()
  const ref = doc(collection(db, 'spaces'))
  const inviteCode = newInviteCode()
  const timezone = deviceTimeZone()
  try {
    const inviterName = await myName(user)
    await setDoc(ref, {
      name,
      reward,
      penalty,
      ownerId: uid,
      memberIds: [uid],
      joinedAt: { [uid]: serverTimestamp() },
      timezone,
      inviteCode,
      threshold: 90,
      latePenalty: 5,
      createdAt: serverTimestamp(),
    })
    // The invite rule reads the space, so it must exist on the server first.
    await setDoc(doc(db, 'invites', inviteCode), { spaceId: ref.id, spaceName: name, inviterName, createdBy: uid, createdAt: serverTimestamp() })
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
    inviteCode,
    threshold: 90,
    latePenalty: 5,
    createdAt: at,
  }
}

/** Accepts a code or invite link; null if unknown. */
export async function lookupInvite(codeOrLink: string): Promise<Invite | null> {
  const code = normalizeInviteCode(codeOrLink)
  if (!code) return null
  requireUser()
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
    // The invite exists, so a denied join means the member cap was hit.
    throw humanError(e, MSG_FULL)
  }
  return invite.spaceId
}

async function leave(snap: DocumentSnapshot, uid: string): Promise<void> {
  if (!snap.exists()) return
  const space = toSpace(snap)
  if (!space.memberIds.includes(uid)) return
  if (space.memberIds.length === 1 && space.inviteCode) {
    // Last one out retires the invite, so the code can't revive an empty space.
    await deleteDoc(doc(getFirebase().db, 'invites', space.inviteCode)).catch(() => {})
  }
  await updateDoc(snap.ref, 'memberIds', arrayRemove(uid), new FieldPath('joinedAt', uid), deleteField())
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
  if (clean.name !== undefined) {
    // The join preview shows the invite's copy of the name. Best effort: the space is already renamed.
    const code = (await getDoc(spaceRef(spaceId)).catch(() => null))?.get('inviteCode')
    if (typeof code === 'string' && code) await updateDoc(doc(getFirebase().db, 'invites', code), { spaceName: clean.name }).catch(() => {})
  }
}

/** `<app url>?join=CODE` for sharing. */
export function inviteLink(space: Space): string {
  return `${location.origin}${location.pathname}?join=${space.inviteCode}`
}
