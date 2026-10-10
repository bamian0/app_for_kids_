// Firebase web config. These values are public by design (security comes from firestore.rules).
// Paste the config from Firebase console → Project settings → Your apps → Web app.
export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
}

/** Local development / e2e against the Firebase emulators (auth :9099, firestore :8080). */
export const USE_EMULATORS = import.meta.env.VITE_EMULATORS === '1'

export const isConfigured = USE_EMULATORS || firebaseConfig.apiKey !== ''
