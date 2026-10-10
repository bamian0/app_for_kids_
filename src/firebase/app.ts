// Firebase singletons. STUB: the data agent implements this (emulator wiring, persistence).
import type { FirebaseApp } from 'firebase/app'
import type { Auth } from 'firebase/auth'
import type { Firestore } from 'firebase/firestore'

/** Lazily initialized; throws if the app is not configured (see isConfigured in ./config.ts). */
export function getFirebase(): { app: FirebaseApp; auth: Auth; db: Firestore } {
  throw new Error('not implemented')
}
