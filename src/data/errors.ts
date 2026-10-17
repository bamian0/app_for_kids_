// Maps Firebase errors to short messages the UI can show as-is.
import { FirebaseError } from 'firebase/app'

export const MSG = {
  offline: 'You’re offline. Check your connection and try again.',
  closed: 'You can’t change this anymore.',
  noAccess: 'You don’t have access to this.',
  wrongCredentials: 'Wrong email or password.',
  wrongPassword: 'Wrong password.',
  busy: 'The server is busy. Try again in a minute.',
  generic: 'Something went wrong. Try again.',
  signedOut: 'Please sign in first.',
}

/** A tick on a task you crossed out (SPEC §10.3, §10.6), or on one of its steps: refused until you undo it. Lives
 *  here so the tick code (weeks.ts, monthly.ts) and cancel.ts share it without importing each other. */
export const CROSSED_OUT_TICK = 'You crossed this task out, so it can’t be ticked.'

const AUTH: Record<string, string> = {
  'auth/email-already-in-use': 'An account with this email already exists. Try signing in.',
  'auth/weak-password': 'Use at least 6 characters for your password.',
  'auth/password-does-not-meet-requirements': 'Use at least 6 characters for your password.',
  'auth/missing-password': 'Enter your password.',
  'auth/invalid-email': 'That email address doesn’t look right.',
  'auth/missing-email': 'Enter your email address.',
  'auth/invalid-credential': MSG.wrongCredentials,
  'auth/invalid-login-credentials': MSG.wrongCredentials,
  'auth/wrong-password': MSG.wrongCredentials,
  'auth/user-not-found': MSG.wrongCredentials,
  'auth/user-mismatch': MSG.wrongCredentials,
  'auth/user-disabled': 'This account has been disabled.',
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
  'auth/network-request-failed': MSG.offline,
  'auth/requires-recent-login': 'For your security, sign out, sign in again and retry.',
  'auth/user-token-expired': 'Your session expired. Please sign in again.',
  'auth/operation-not-allowed': 'Email sign-in is not enabled for this app yet.',
}

const FIRESTORE: Record<string, string> = {
  unavailable: MSG.offline,
  'deadline-exceeded': MSG.offline,
  'resource-exhausted': MSG.busy,
  unauthenticated: MSG.signedOut,
  'not-found': 'This no longer exists.',
}

export function errorCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : undefined
}

export function isDenied(e: unknown): boolean {
  return errorCode(e) === 'permission-denied'
}

/**
 * Human-readable Error for the UI. Errors we threw ourselves pass through unchanged.
 * `denied` is the message for permission-denied, which on writes almost always means a time window closed.
 * `overrides` replaces messages for specific codes (e.g. a wrong password on re-authentication).
 */
export function humanError(e: unknown, denied: string = MSG.closed, overrides: Record<string, string> = {}): Error {
  const code = errorCode(e)
  if (!(e instanceof FirebaseError) && !code) return e instanceof Error ? e : new Error(String(e))
  const known = code ? (overrides[code] ?? (code === 'permission-denied' ? denied : (AUTH[code] ?? FIRESTORE[code]))) : undefined
  return new Error(known ?? MSG.generic, { cause: e })
}
