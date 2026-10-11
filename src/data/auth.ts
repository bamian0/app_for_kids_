// Account lifecycle: sign up / in / out, profile name, account deletion.
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
import { collection, deleteDoc, getDoc, getDocs, onSnapshot, setDoc, updateDoc } from 'firebase/firestore'
import type { UID, UserProfile } from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import type { Live } from './api.ts'
import { toProfile } from './convert.ts'
import { errorCode, humanError, isDenied, MSG } from './errors.ts'
import { deleteAllMoney } from './money.ts'
import { cleanText, duringSignUp, ensureProfile, newProfile, profileRef, requireUser, startAuth } from './session.ts'
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

/** Re-authenticates, leaves all spaces, deletes the user's docs (money included) and the auth user. */
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
    await leaveAllSpaces(user.uid)
    await deleteAllMoney(user.uid)
    const subs = await getDocs(collection(db, 'users', user.uid, 'push'))
    await Promise.all(subs.docs.map((sub) => deleteDoc(sub.ref)))
    await deleteDoc(profileRef(db, user.uid))
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
