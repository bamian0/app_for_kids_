// Account lifecycle: sign up / in / out, profile name and photo, account deletion.
import {
  createUserWithEmailAndPassword,
  deleteUser,
  EmailAuthProvider,
  reauthenticateWithCredential,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  updateProfile,
  type User,
} from 'firebase/auth'
import { collection, deleteDoc, deleteField, getDoc, getDocs, onSnapshot, setDoc, updateDoc } from 'firebase/firestore'
import type { UID, UserProfile } from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import type { Live } from './api.ts'
import { isProfilePhoto, toProfile } from './convert.ts'
import { withdrawAllWaitingDeals } from './deals.ts'
import { errorCode, humanError, isDenied, MSG } from './errors.ts'
import { deleteAllMoney } from './money.ts'
import { deleteMyFriendCodes, deleteMyFriendships } from './friends.ts'
import { cleanText, duringSignUp, ensureProfile, newProfile, profileRef, requireUser, startAuth } from './session.ts'
import { leaveAllSharedGoals } from './shared.ts'
import { deleteScoreDocs, deleteShowcase, hideShowcase } from './showcase.ts'
import { leaveAllSpaces } from './spaces.ts'
import type { Start } from './store.ts'

const MIN_PASSWORD = 6

function checkEmail(email: string): string {
  const clean = email.trim()
  if (!clean) throw new Error('Enter your email address.')
  return clean
}

/** Creates the auth user and users/{uid} profile. Errors are thrown as `Error` with a human-readable message. */
export async function signUp(name: string, email: string, password: string): Promise<void> {
  const cleanName = cleanText(name, 40, 'Name')
  const cleanEmail = checkEmail(email)
  if (password.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters for your password.`)
  startAuth()
  const { auth } = getFirebase()
  const { user, saved } = await duringSignUp(async () => {
    let user: User
    try {
      user = (await createUserWithEmailAndPassword(auth, cleanEmail, password)).user
    } catch (e) {
      throw humanError(e)
    }
    await updateProfile(user, { displayName: cleanName }).catch(() => {})
    return { user, saved: await saveProfile(user, cleanName) }
  })
  // The account exists either way, so don't fail sign-up: a missing profile is created from displayName.
  if (!saved) void ensureProfile(user)
}

async function saveProfile(user: User, name: string): Promise<boolean> {
  const ref = profileRef(getFirebase().db, user.uid)
  try {
    await setDoc(ref, newProfile(user.uid, name))
    return true
  } catch (e) {
    if (!isDenied(e)) return false
    // Denied create = the doc already exists; only the name may change.
    return updateDoc(ref, { name }).then(
      () => true,
      () => false,
    )
  }
}

export async function signIn(email: string, password: string): Promise<void> {
  const cleanEmail = checkEmail(email)
  if (!password) throw new Error('Enter your password.')
  startAuth()
  try {
    const { user } = await signInWithEmailAndPassword(getFirebase().auth, cleanEmail, password)
    await ensureProfile(user)
  } catch (e) {
    throw humanError(e)
  }
}

/** Resolves for unknown emails too, so the form can't be used to find out who has an account
 *  (production Firebase does the same with email enumeration protection on). */
export async function sendPasswordReset(email: string): Promise<void> {
  const cleanEmail = checkEmail(email)
  try {
    await sendPasswordResetEmail(getFirebase().auth, cleanEmail)
  } catch (e) {
    if (errorCode(e) === 'auth/user-not-found') return
    throw humanError(e)
  }
}

export async function signOut(): Promise<void> {
  try {
    await firebaseSignOut(getFirebase().auth)
  } catch (e) {
    throw humanError(e)
  }
}

export async function updateMyName(name: string): Promise<void> {
  const clean = cleanText(name, 40, 'Name')
  const user = requireUser()
  const ref = profileRef(getFirebase().db, user.uid)
  try {
    const snap = await getDoc(ref)
    await (snap.exists() ? updateDoc(ref, { name: clean }) : setDoc(ref, newProfile(user.uid, clean)))
    await updateProfile(user, { displayName: clean }).catch(() => {})
  } catch (e) {
    throw humanError(e, MSG.noAccess)
  }
}

/**
 * Sets your profile photo, a square JPEG data URL from the photo picker (SPEC §7.3), or removes it
 * with null. Friends see it wherever your avatar shows. Like every write, it shows at once (the local
 * cache has it) and resolves when the server has it.
 */
export async function updateMyPhoto(photo: string | null): Promise<void> {
  // The rules would refuse it too, but only after the local cache had shown it for a moment.
  if (photo !== null && !isProfilePhoto(photo)) throw new Error('Try a different photo.')
  const user = requireUser()
  try {
    await updateDoc(profileRef(getFirebase().db, user.uid), { photo: photo ?? deleteField() })
  } catch (e) {
    throw humanError(e, MSG.noAccess)
  }
}

/**
 * Re-authenticates, leaves all spaces, deletes the user's docs (money included) and the auth user. Batch 3 (SPEC
 * §11.12), each step idempotent so a retry finishes the job: after the money, the showcase is switched off (strangers
 * see nothing from then on, stats included), every shared goal is left the way leaveSharedGoal leaves it (your part
 * stays in its totals) and every invitation declined, and your friend codes go; after the profile, every pair you are
 * in, then the job's rings, stats and scores docs (the job skips users without a profile, so it won't write them
 * again), and the showcase last. Deals (SPEC §12.13): before leaving the spaces, a deal of yours still waiting for
 * agreement is withdrawn; no deal is deleted.
 */
export async function deleteMyAccount(password: string): Promise<void> {
  const user = requireUser()
  if (!user.email) throw new Error(MSG.signedOut)
  try {
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password))
  } catch (e) {
    throw humanError(e, MSG.closed, {
      'auth/invalid-credential': MSG.wrongPassword,
      'auth/invalid-login-credentials': MSG.wrongPassword,
      'auth/wrong-password': MSG.wrongPassword,
      'auth/missing-password': 'Enter your password.',
    })
  }
  const { db } = getFirebase()
  try {
    // Money first: leaving can't be undone, so anything that can fail goes before it and a retry
    // finds the user still in their spaces.
    await deleteAllMoney(user.uid)
    await hideShowcase(user.uid)
    await leaveAllSharedGoals(user.uid)
    await deleteMyFriendCodes(user.uid)
    // Deals (SPEC §12.13), while still a member: a waiting deal of yours is withdrawn (best effort); nothing is
    // deleted, and an agreed one is lost by the leave like any leaver's.
    await withdrawAllWaitingDeals(user.uid).catch(() => {})
    await leaveAllSpaces(user.uid)
    const subs = await getDocs(collection(db, 'users', user.uid, 'push'))
    await Promise.all(subs.docs.map((sub) => deleteDoc(sub.ref)))
    await deleteDoc(profileRef(db, user.uid))
    await deleteMyFriendships(user.uid)
    await deleteScoreDocs(user.uid)
    await deleteShowcase(user.uid)
    await deleteUser(user)
  } catch (e) {
    throw humanError(e, MSG.noAccess)
  }
}

export function startProfile(uid: UID): Start<UserProfile | null> {
  return (emit) =>
    onSnapshot(
      profileRef(getFirebase().db, uid),
      (snap) => emit({ data: snap.exists() ? toProfile(snap) : null, loading: false, error: null }),
      (error) => emit({ data: null, loading: false, error: humanError(error, MSG.noAccess) }),
    )
}

export function mergeProfiles(states: Live<UserProfile | null>[]): Live<Record<UID, UserProfile>> {
  const data: Record<UID, UserProfile> = {}
  for (const state of states) if (state.data) data[state.data.uid] = state.data
  return { data, loading: states.some((s) => s.loading), error: null }
}
