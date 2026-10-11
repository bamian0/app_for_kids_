// Firebase singletons, created on first use.
import { initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app'
import { browserLocalPersistence, connectAuthEmulator, indexedDBLocalPersistence, initializeAuth, type Auth } from 'firebase/auth'
import {
  connectFirestoreEmulator,
  initializeFirestore,
  memoryLocalCache,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore'
import { firebaseConfig, isConfigured, USE_EMULATORS } from './config.ts'

export interface EmulatorTarget {
  host: string
  authPort: number
  firestorePort: number
}

const EMULATOR_CONFIG: FirebaseOptions = { projectId: 'demo-stakes', apiKey: 'demo-key', authDomain: 'demo-stakes.firebaseapp.com' }

let instance: { app: FirebaseApp; auth: Auth; db: Firestore } | null = null
let emulatorOverride: EmulatorTarget | null = null

/** Tests only: use the emulators at these ports (e.g. a second emulator suite). Call before the first getFirebase(). */
export function setEmulatorPorts(target: EmulatorTarget): void {
  if (instance) throw new Error('setEmulatorPorts() must be called before Firebase is first used.')
  emulatorOverride = target
}

function emulatorTarget(): EmulatorTarget | null {
  if (emulatorOverride) return emulatorOverride
  if (!USE_EMULATORS) return null
  // The page's own host, so a phone on the LAN opening http://<laptop-ip>:5173 reaches the laptop's emulators.
  const host = typeof location !== 'undefined' && location.hostname ? location.hostname : '127.0.0.1'
  return { host, authPort: 9099, firestorePort: 8080 }
}

/** Lazily initialized; throws if the app is not configured (see isConfigured in ./config.ts). */
export function getFirebase(): { app: FirebaseApp; auth: Auth; db: Firestore } {
  if (instance) return instance
  const emulators = emulatorTarget()
  if (!emulators && !isConfigured) {
    throw new Error('Firebase is not configured yet. Paste the web app config into src/firebase/config.ts.')
  }

  const app = initializeApp(emulators ? EMULATOR_CONFIG : firebaseConfig)
  // Unavailable persistences are skipped in order, ending at in-memory (e.g. in Node tests).
  const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] })
  const db = initializeFirestore(app, {
    localCache:
      typeof indexedDB === 'undefined'
        ? memoryLocalCache()
        : persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  })

  if (emulators) {
    const host = emulators.host.includes(':') && !emulators.host.startsWith('[') ? `[${emulators.host}]` : emulators.host
    connectAuthEmulator(auth, `http://${host}:${emulators.authPort}`, { disableWarnings: true })
    connectFirestoreEmulator(db, emulators.host, emulators.firestorePort)
  }

  instance = { app, auth, db }
  return instance
}
