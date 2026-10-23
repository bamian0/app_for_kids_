// Module-level auth state shared by every useAuth() caller, plus helpers the other data modules use.
import { onAuthStateChanged, type User } from 'firebase/auth'
import { doc, getDoc, getDocFromServer, onSnapshot, serverTimestamp, setDoc, type Firestore } from 'firebase/firestore'
import { colorForUid } from '../domain/ids.ts'
import type { UID } from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import type { AuthState } from './api.ts'
import { toProfile } from './convert.ts'
import { errorCode, MSG } from './errors.ts'
import { signal } from './store.ts'

const SIGNED_OUT: AuthState = { status: 'signedOut', uid: null, email: null, profile: null }

export const authState = signal<AuthState>({ status: 'loading', uid: null, email: null, profile: null })

let started = false
let stopProfile = () => {}
/** While signUp() writes the profile itself, the auth listener must not create a fallback one. */
let signUpInFlight = false
const ensured = new Map<UID, Promise<void>>()

export function startAuth(): void {
  if (started) return
  started = true
  let fb: ReturnType<typeof getFirebase>
  try {
    fb = getFirebase()
  } catch {
    // Not configured: the app shows its setup screen; sign-in calls will surface the same error.
    authState.set(SIGNED_OUT)
    return
  }
  const { auth, db } = fb
  onAuthStateChanged(auth, (user) => {
    stopProfile()
    stopProfile = () => {}
    if (!user) {
      authState.set(SIGNED_OUT)
      return
    }
    const base = { uid: user.uid, email: user.email }
    // Stay in the previous status until the profile's first snapshot, so screens don't flash a nameless user.
    stopProfile = onSnapshot(
      profileRef(db, user.uid),
      (snap) => {
        if (auth.currentUser?.uid !== user.uid) return
        authState.set({ status: 'signedIn', ...base, profile: snap.exists() ? toProfile(snap) : null })
      },
      () => authState.set({ status: 'signedIn', ...base, profile: null }),
    )
    void ensureProfile(user)
  })
}

export function profileRef(db: Firestore, uid: UID) {
  return doc(db, 'users', uid)
}

export function newProfile(uid: UID, name: string) {
  return { name, color: colorForUid(uid), createdAt: serverTimestamp() }
}

function fallbackName(user: User): string {
  const name = user.displayName?.trim() || user.email?.split('@')[0]?.trim() || 'Friend'
  return name.slice(0, 40)
}

/** Creates users/{uid} if it is missing (accounts made before profiles, or a sign-up that lost its connection). */
export function ensureProfile(user: User): Promise<void> {
  if (signUpInFlight) return Promise.resolve()
  let pending = ensured.get(user.uid)
  if (!pending) {
    pending = (async () => {
      const ref = profileRef(getFirebase().db, user.uid)
      const snap = await getDocFromServer(ref)
      if (!snap.exists()) await setDoc(ref, newProfile(user.uid, fallbackName(user)))
    })().catch(() => {
      // Offline or denied: try again on the next sign-in or app launch.
      ensured.delete(user.uid)
    })
    ensured.set(user.uid, pending)
  }
  return pending
}

/** Runs `fn` with the auth listener's fallback profile creation paused. */
export async function duringSignUp<T>(fn: () => Promise<T>): Promise<T> {
  signUpInFlight = true
  try {
    return await fn()
  } finally {
    signUpInFlight = false
  }
}

export function requireUser(): User {
  const user = getFirebase().auth.currentUser
  if (!user) throw new Error(MSG.signedOut)
  return user
}

/** The current user's display name, for invites. */
export async function myName(user: User): Promise<string> {
  const state = authState.get()
  if (state.uid === user.uid && state.profile?.name) return state.profile.name
  try {
    const snap = await getDoc(profileRef(getFirebase().db, user.uid))
    const name = snap.get('name')
    if (typeof name === 'string' && name.trim()) return name
  } catch {
    // Fall through to the auth profile.
  }
  return fallbackName(user)
}

/** Trims and checks a user-visible text field against the limits in firestore.rules. */
export function cleanText(value: string, max: number, label: string): string {
  const clean = value.trim()
  if (!clean) throw new Error(`${label} can't be empty.`)
  if (clean.length > max) throw new Error(`${label} is too long (${max} characters max).`)
  return clean
}

/** How long createSpace waits to hear from the server before calling it offline. */
const REACH_TIMEOUT_MS = 8_000

/**
 * Resolves once the server answers, or throws the offline message. Writes made while offline wait
 * in a queue and land later, which for a new space means a spinner that never ends and a duplicate
 * when the user tries again.
 */
export async function requireServer(uid: UID): Promise<void> {
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
