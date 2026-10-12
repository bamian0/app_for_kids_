// Whether this device has seen the intro. It lives in localStorage through the guarded helpers, so
// private mode or blocked storage only means the intro shows again next launch, never a crash.
import { readLocal, writeLocal } from '../components/storage.ts'

const KEY = 'introSeen'
/** Bump to show a reworked intro once more to everyone (the flag stores the version they saw). */
export const INTRO_VERSION = 1

// Storage can fail silently, so the session also remembers: finishing the intro signed out and
// then signing in must not bring it straight back.
let seenThisSession = false

export function hasSeenIntro(): boolean {
  if (seenThisSession) return true
  const saved = Number(readLocal(KEY))
  return Number.isFinite(saved) && saved >= INTRO_VERSION
}

export function markIntroSeen(): void {
  seenThisSession = true
  writeLocal(KEY, String(INTRO_VERSION))
}

/** Tests only: forget the session memory, as a fresh launch would. */
export function resetIntroSessionForTests(): void {
  seenThisSession = false
}
