// Seeding for the batch-3 friends e2e (SPEC §11.3), with admin rights like the reminders job: friend pairs, friend
// codes, rings and stats (only the job writes those two), showcases and the money a showcase copies.
import { pairId } from '../../src/domain/friends.ts'
import type { FriendState, RingFacts, ShowcaseDoc, StatsFacts } from '../../src/domain/types.ts'
import { db, ts } from './emulator.ts'

/** friends/{a_b}: `by` asked; `at` when asked, canceled, or since when friends. */
export async function setPair(a: string, b: string, p: { by: string; state: FriendState; at: number }): Promise<void> {
  const users = [a, b].sort()
  await db.doc(`friends/${pairId(a, b)}`).set({ users, by: p.by, state: p.state, at: ts(p.at) })
}

/** The pair as stored, or null. */
export async function readPair(a: string, b: string): Promise<{ by: string; state: FriendState; at: number } | null> {
  const snap = await db.doc(`friends/${pairId(a, b)}`).get()
  if (!snap.exists) return null
  return { by: snap.get('by') as string, state: snap.get('state') as FriendState, at: (snap.get('at') as { toMillis(): number }).toMillis() }
}

/** friendCodes/{code}: someone's friend link. */
export async function setFriendCode(code: string, uid: string, at: number): Promise<void> {
  await db.doc(`friendCodes/${code}`).set({ uid, createdAt: ts(at) })
}

/** The newest friend code of a user (what Add Friend shows), or null. */
export async function friendCodeOf(uid: string): Promise<string | null> {
  const snap = await db.collection('friendCodes').where('uid', '==', uid).get()
  const docs = [...snap.docs].sort((x, y) => (y.get('createdAt') as { toMillis(): number }).toMillis() - (x.get('createdAt') as { toMillis(): number }).toMillis())
  return docs[0]?.id ?? null
}

/** rings/{uid}, as the job writes it. */
export async function setRing(uid: string, ring: RingFacts, at = Date.now()): Promise<void> {
  await db.doc(`rings/${uid}`).set({ ...ring, updatedAt: ts(at) })
}

/** stats/{uid}, as the job writes it. */
export async function setStats(uid: string, stats: StatsFacts, at = Date.now()): Promise<void> {
  await db.doc(`stats/${uid}`).set({ ...stats, updatedAt: ts(at) })
}

/** showcases/{uid}, as the app writes it (item times as timestamps). */
export async function setShowcase(uid: string, doc: ShowcaseDoc, at = Date.now()): Promise<void> {
  const data: Record<string, unknown> = { show: doc.show, updatedAt: ts(at) }
  if (doc.achieved) data.achieved = doc.achieved.map((g) => ({ name: g.name, at: ts(g.at) }))
  if (doc.goals) data.goals = doc.goals
  if (doc.earnings) data.earnings = doc.earnings
  await db.doc(`showcases/${uid}`).set(data)
}

/** The stored showcase's switches and which item fields it holds. */
export async function readShowcase(uid: string): Promise<{ show: Record<string, boolean>; items: string[] } | null> {
  const snap = await db.doc(`showcases/${uid}`).get()
  if (!snap.exists) return null
  const items = ['achieved', 'goals', 'earnings'].filter((k) => snap.get(k) !== undefined)
  return { show: snap.get('show') as Record<string, boolean>, items }
}

/** A goal marked Bought: a spend move with goal: true, as markGoalBought writes it. */
export async function addBoughtGoal(uid: string, g: { name: string; amount: number; at: number }): Promise<void> {
  await db.collection(`users/${uid}/moves`).add({ kind: 'spend', amount: g.amount, note: g.name, at: ts(g.at), goal: true })
}

/** Whether any doc of a user's batch-3 data is left (pairs with them, codes, showcase, ring, stats, scores). */
export async function leftovers(uid: string): Promise<string[]> {
  const found: string[] = []
  const pairs = await db.collection('friends').where('users', 'array-contains', uid).get()
  for (const d of pairs.docs) found.push(`friends/${d.id}`)
  const codes = await db.collection('friendCodes').where('uid', '==', uid).get()
  for (const d of codes.docs) found.push(`friendCodes/${d.id}`)
  for (const coll of ['showcases', 'rings', 'stats', 'scores']) if ((await db.doc(`${coll}/${uid}`).get()).exists) found.push(`${coll}/${uid}`)
  return found
}
