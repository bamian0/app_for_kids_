// Admin access to the emulators for seeding (the Admin SDK bypasses security rules).
// `firebase emulators:exec` sets the *_EMULATOR_HOST variables; the defaults match firebase.json.
import { getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore'

export const PROJECT_ID = 'demo-stakes'
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080'
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099'

const app = getApps()[0] ?? initializeApp({ projectId: PROJECT_ID })
export const db: Firestore = getFirestore(app)
export const ts = (ms: number) => Timestamp.fromMillis(ms)

/** Wipes every document and account, so each run starts from an empty project. */
export async function resetEmulators(): Promise<void> {
  const firestore = process.env.FIRESTORE_EMULATOR_HOST
  const auth = process.env.FIREBASE_AUTH_EMULATOR_HOST
  const responses = await Promise.all([
    fetch(`http://${firestore}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, { method: 'DELETE' }),
    fetch(`http://${auth}/emulator/v1/projects/${PROJECT_ID}/accounts`, { method: 'DELETE' }),
  ])
  for (const r of responses) if (!r.ok) throw new Error(`Emulator reset failed: ${r.status} ${r.url}`)
}

export async function uidOf(email: string): Promise<string> {
  return (await getAuth(app).getUserByEmail(email)).uid
}

export interface SeedTask {
  id: string
  title: string
}

export interface SeedWeek {
  startAt: number
  lockAt: number
  reviewOpenAt: number
  deadlineAt: number
  members: string[]
  submittedBy: string[]
}

export function weekDoc(spaceId: string, weekId: string) {
  return db.doc(`spaces/${spaceId}/weeks/${weekId}`)
}

export async function setWeek(spaceId: string, weekId: string, w: SeedWeek): Promise<void> {
  await weekDoc(spaceId, weekId).set({
    startAt: ts(w.startAt),
    lockAt: ts(w.lockAt),
    reviewOpenAt: ts(w.reviewOpenAt),
    deadlineAt: ts(w.deadlineAt),
    members: w.members,
    submittedBy: w.submittedBy,
  })
}

export async function setPlan(spaceId: string, weekId: string, uid: string, tasks: SeedTask[], at: number): Promise<void> {
  await weekDoc(spaceId, weekId).collection('plans').doc(uid).set({ tasks, updatedAt: ts(at) })
}

export async function setProgress(spaceId: string, weekId: string, uid: string, done: Record<string, boolean>, at: number): Promise<void> {
  await weekDoc(spaceId, weekId).collection('progress').doc(uid).set({ done, updatedAt: ts(at) })
}

export async function setReview(spaceId: string, weekId: string, reviewerId: string, revieweeId: string, marks: Record<string, number>, at: number): Promise<void> {
  await weekDoc(spaceId, weekId)
    .collection('reviews')
    .doc(`${reviewerId}_${revieweeId}`)
    .set({ reviewerId, revieweeId, marks, submittedAt: ts(at) })
}
