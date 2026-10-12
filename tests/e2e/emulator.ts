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
  /** Steps as stored: "<stepId>|<title>". */
  subs?: string[]
}

/** An account and its profile, as sign-up makes them. Resolves with the uid. */
export async function createAccount(who: { name: string; email: string; password: string }, color: string, at: number): Promise<string> {
  const user = await getAuth(app).createUser({ email: who.email, password: who.password, displayName: who.name })
  await db.doc(`users/${user.uid}`).set({ name: who.name, color, createdAt: ts(at) })
  return user.uid
}

export interface SeedSpace {
  name: string
  reward: string
  penalty: string
  /** The first member is the owner. */
  members: string[]
  timezone: string
  utcOffsetMin: number
  inviteCode: string
  /** When the space was created and everyone joined. */
  at: number
}

/** A space and its invite, as createSpace and joining leave them. */
export async function setSpace(spaceId: string, s: SeedSpace): Promise<void> {
  const owner = s.members[0]
  await db.doc(`spaces/${spaceId}`).set({
    name: s.name,
    reward: s.reward,
    penalty: s.penalty,
    ownerId: owner,
    memberIds: s.members,
    joinedAt: Object.fromEntries(s.members.map((uid) => [uid, ts(s.at)])),
    timezone: s.timezone,
    utcOffsetMin: s.utcOffsetMin,
    inviteCode: s.inviteCode,
    threshold: 90,
    latePenalty: 5,
    createdAt: ts(s.at),
  })
  const inviter = (await db.doc(`users/${owner}`).get()).get('name') as string
  await db.doc(`invites/${s.inviteCode}`).set({
    spaceId,
    spaceName: s.name,
    reward: s.reward,
    penalty: s.penalty,
    inviterName: inviter,
    createdBy: owner,
    createdAt: ts(s.at),
  })
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

/** `added`: tasks appended after the lock, with their add times. */
export async function setPlan(spaceId: string, weekId: string, uid: string, tasks: SeedTask[], at: number, added?: Record<string, number>): Promise<void> {
  const plan: Record<string, unknown> = { tasks, updatedAt: ts(at) }
  if (added) plan.added = Object.fromEntries(Object.entries(added).map(([id, ms]) => [id, ts(ms)]))
  await weekDoc(spaceId, weekId).collection('plans').doc(uid).set(plan)
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

// ---------- Money (users/{uid}/...) ----------

export function moneyDoc(uid: string, path: string) {
  return db.doc(`users/${uid}/${path}`)
}

/** A revenue task: earned at `earnedAt`, or not done yet (null). */
export async function setEarning(
  uid: string,
  e: { spaceId: string; weekId: string; taskId: string; title: string; amount: number; earnedAt: number | null },
): Promise<void> {
  await moneyDoc(uid, `earnings/${e.spaceId}_${e.weekId}_${e.taskId}`).set({
    ...e,
    earnedAt: e.earnedAt === null ? null : ts(e.earnedAt),
    updatedAt: ts(e.earnedAt ?? Date.now()),
  })
}

export async function setMoneyState(uid: string, s: { currency: string; baseline: number | null; baselineAt: number | null }): Promise<void> {
  await moneyDoc(uid, 'money/state').set({ ...s, baselineAt: s.baselineAt === null ? null : ts(s.baselineAt), updatedAt: ts(s.baselineAt ?? Date.now()) })
}

export async function addMove(uid: string, m: { kind: 'add' | 'spend'; amount: number; note: string; at: number }): Promise<void> {
  await db.collection(`users/${uid}/moves`).add({ ...m, at: ts(m.at) })
}

export async function addGoal(uid: string, g: { name: string; cost: number; order: number; createdAt: number }): Promise<void> {
  await db.collection(`users/${uid}/goals`).add({ ...g, createdAt: ts(g.createdAt) })
}

/** Reads a document or collection as `who` would from a client, through the real rules: the HTTP status. */
export async function readAs(who: { email: string; password: string }, path: string): Promise<number> {
  const auth = process.env.FIREBASE_AUTH_EMULATOR_HOST
  const firestore = process.env.FIRESTORE_EMULATOR_HOST
  const signIn = await fetch(`http://${auth}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: who.email, password: who.password, returnSecureToken: true }),
  })
  const { idToken } = (await signIn.json()) as { idToken: string }
  const res = await fetch(`http://${firestore}/v1/projects/${PROJECT_ID}/databases/(default)/documents/${path}`, {
    headers: { Authorization: `Bearer ${idToken}` },
  })
  return res.status
}
