// Firebase web config. These values are public by design (security comes from firestore.rules).
// Paste the config from Firebase console → Project settings → Your apps → Web app.
export const firebaseConfig = {
  apiKey: 'AIzaSyDYSHvOn1wOEBfcI4mwKOBE3wBRj77GrYo',
  authDomain: 'stakes-97daf.firebaseapp.com',
  projectId: 'stakes-97daf',
  storageBucket: 'stakes-97daf.firebasestorage.app',
  messagingSenderId: '347133678900',
  appId: '1:347133678900:web:d7a2fdabd461db27350161',
}

/** Local development / e2e against the Firebase emulators (auth :9099, firestore :8080). */
export const USE_EMULATORS = import.meta.env.VITE_EMULATORS === '1'

export const isConfigured = USE_EMULATORS || firebaseConfig.apiKey !== ''
