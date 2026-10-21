// Fixtures for the reminders job's emulator tests (tests/data/reminders*.test.ts): an admin connection, seeding
// in the shapes the app writes, a fake push service and a look at the sent log.
import { deleteApp, initializeApp } from 'firebase-admin/app'
import { getFirestore, Timestamp, type DocumentReference, type Firestore } from 'firebase-admin/firestore'
import { DEFAULT_SCHEDULE, monthlyBounds, weekBounds } from '../../src/domain/time.ts'
import type { Mark, PairTerms, ReviewMark, WeekSchedule } from '../../src/domain/types.ts'
import type { PushKeys, SendOptions } from '../../scripts/reminders.ts'

const PROJECT = 'demo-stakes'
export const FIRESTORE = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8180'
process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE

/** One admin app per test file (each file has its own module instance). */
export function connect(name: string): { db: Firestore; close: () => Promise<void> } {
  const app = initializeApp({ projectId: PROJECT }, name)
  return { db: getFirestore(app), close: () => deleteApp(app) }
}

/** Wipes the emulator. Retried: right after another test file it sometimes answers 500 once. */
export async function clear(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`http://${FIRESTORE}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' })
    if (res.ok) return
    if (attempt === 5) throw new Error(`Could not clear the emulator: ${res.status}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

export const HOUR = 3_600_000
export const DAY = 24 * HOUR
export const at = (iso: string) => Date.parse(iso)
export const ts = (ms: number) => Timestamp.fromMillis(ms)
export const quiet = () => {}

export function seedSpace(db: Firestore, id: string, memberIds: string[], extra: Record<string, unknown> = {}) {
  const t = ts(at('2026-09-01T00:00:00Z'))
  return db.doc(`spaces/${id}`).set({
    name: id, reward: 'Dinner on me', penalty: 'Coffee for a week', ownerId: memberIds[0], memberIds,
    joinedAt: Object.fromEntries(memberIds.map((m) => [m, t])), timezone: 'UTC', utcOffsetMin: 0, inviteCode: 'ABCD2345',
    threshold: 90, latePenalty: 5, createdAt: t, ...extra,
  })
}

export function device(db: Firestore, uid: string, id = 'd', endpoint = `https://web.push.apple.com/${uid}`, createdAt = at('2026-09-01T00:00:00Z')) {
  return db.doc(`users/${uid}/push/${id}`).set({ endpoint, keys: { p256dh: 'p', auth: 'a' }, createdAt: ts(createdAt), ua: 'test' })
}

export function profile(db: Firestore, uid: string, name: string) {
  return db.doc(`users/${uid}`).set({ name, color: '#336699', createdAt: ts(at('2026-09-01T00:00:00Z')) })
}

export interface PeriodSeed {
  members: string[]
  submittedBy?: string[]
  /** Task count per member: ids `${uid}1`, `${uid}2`, … (`${uid}m1` … on a monthly list). */
  plans?: Record<string, number>
  done?: Record<string, string[]>
  /** Cross-outs (SPEC §10.3): task id → its number of changes (1, 3, 5 crossed out; 2, 4 restored), written as
   *  the app writes the plan's `cancels` log, an hour after the lock. */
  cancels?: Record<string, number>
  reviews?: [reviewer: string, reviewee: string, marks: Record<string, ReviewMark>][]
  judges?: string[]
  schedule?: WeekSchedule
  tz?: string
  /** Overrides of the stored bounds (ms). */
  bounds?: Partial<Record<'startAt' | 'lockAt' | 'reviewOpenAt' | 'deadlineAt', number>>
}

async function seedParts(ref: DocumentReference, seed: PeriodSeed, prefix: string, reviewAt: number, lockAt: number) {
  for (const [uid, n] of Object.entries(seed.plans ?? {})) {
    const tasks = Array.from({ length: n }, (_, i) => ({ id: `${uid}${prefix}${i + 1}`, title: `Task ${i + 1}` }))
    const cancels: Record<string, { at: Timestamp; why?: string }> = {}
    for (const { id } of tasks) {
      for (let c = 1; c <= (seed.cancels?.[id] ?? 0); c++) cancels[`${c}:${id}`] = c % 2 === 1 ? { at: ts(lockAt + c * HOUR), why: 'The pool is closed all week' } : { at: ts(lockAt + c * HOUR) }
    }
    await ref.collection('plans').doc(uid).set({ tasks, ...(Object.keys(cancels).length > 0 ? { cancels } : {}), updatedAt: ts(reviewAt - 3 * DAY) })
  }
  for (const [uid, ids] of Object.entries(seed.done ?? {})) await ref.collection('progress').doc(uid).set({ done: Object.fromEntries(ids.map((id) => [id, true])), updatedAt: ts(reviewAt) })
  for (const [reviewerId, revieweeId, marks] of seed.reviews ?? []) {
    await ref.collection('reviews').doc(`${reviewerId}_${revieweeId}`).set({ reviewerId, revieweeId, marks, submittedAt: ts(reviewAt) })
  }
}

/** A week doc (bounds on its schedule in its zone, UTC by default) with its plans, progress and reviews. */
export async function seedWeek(db: Firestore, spaceId: string, weekId: string, seed: PeriodSeed) {
  const b = { ...weekBounds(weekId, seed.tz ?? 'UTC', seed.schedule ?? DEFAULT_SCHEDULE), ...seed.bounds }
  const ref = db.doc(`spaces/${spaceId}/weeks/${weekId}`)
  await ref.set({
    startAt: ts(b.startAt), lockAt: ts(b.lockAt), reviewOpenAt: ts(b.reviewOpenAt), deadlineAt: ts(b.deadlineAt),
    members: seed.members, submittedBy: seed.submittedBy ?? [],
    ...(seed.schedule ? { schedule: seed.schedule } : {}), ...(seed.judges ? { judges: seed.judges } : {}),
  })
  await seedParts(ref, seed, '', b.reviewOpenAt, b.lockAt)
  return b
}

/** A month's list (bounds from its weeks, computed in its zone) with its plans, progress and reviews. */
export async function seedList(db: Firestore, spaceId: string, monthId: string, seed: PeriodSeed) {
  const b = { ...monthlyBounds(monthId, (w) => weekBounds(w, seed.tz ?? 'UTC')), ...seed.bounds }
  const ref = db.doc(`spaces/${spaceId}/monthly/${monthId}`)
  await ref.set({
    startAt: ts(b.startAt), lockAt: ts(b.lockAt), reviewOpenAt: ts(b.reviewOpenAt), deadlineAt: ts(b.deadlineAt),
    members: seed.members, submittedBy: seed.submittedBy ?? [], judges: seed.judges ?? [],
  })
  await seedParts(ref, seed, 'm', b.reviewOpenAt, b.lockAt)
  return b
}

/** Everyone in `members` reviewed everyone else's single task with `marks[reviewee]` (1 by default). */
export function allReviews(members: string[], marks: Record<string, Mark> = {}): [string, string, Record<string, Mark>][] {
  return members.flatMap((r) => members.filter((m) => m !== r).map((m): [string, string, Record<string, Mark>] => [r, m, { [`${m}1`]: marks[m] ?? 1 }]))
}

/** A member's stakes doc as the app writes it, with friends' agreements (`at` in ms). */
export function seedStakes(
  db: Firestore,
  spaceId: string,
  uid: string,
  terms: PairTerms,
  agreed: Record<string, number>,
  updatedAt: number,
  per: Record<string, { reward: string; penalty: string }> = {},
) {
  const clean = { rewardMode: terms.rewardMode, penaltyMode: terms.penaltyMode, reward: terms.reward, penalty: terms.penalty, tiers: terms.tiers }
  // Each friend agrees to their own pair terms: a per-friend line is their entry's text.
  const termsFor = (friend: string) => ({
    ...clean,
    reward: clean.rewardMode === 'each' ? (per[friend]?.reward ?? '') : clean.reward,
    penalty: clean.penaltyMode === 'each' ? (per[friend]?.penalty ?? '') : clean.penalty,
  })
  return db.doc(`spaces/${spaceId}/stakes/${uid}`).set({
    ...clean,
    per,
    agreed: Object.fromEntries(Object.entries(agreed).map(([friend, t]) => [friend, { at: ts(t), terms: termsFor(friend), past: [] }])),
    updatedAt: ts(updatedAt),
  })
}

/** A fake push service: records every send; endpoints containing "hang" never answer. */
export function fakePush() {
  const sent: { endpoint: string; title: string; body: string; url: string; tag: string; options: SendOptions }[] = []
  const send = (sub: PushKeys, payload: string, options: SendOptions) => {
    if (sub.endpoint.includes('hang')) return new Promise<never>(() => {})
    const { title, body, url, tag } = JSON.parse(payload) as { title: string; body: string; url: string; tag: string }
    sent.push({ endpoint: sub.endpoint, title, body, url, tag, options })
    return Promise.resolve()
  }
  /** "uid | title | body", the uid being the last part of the endpoint. */
  const lines = () => sent.map((p) => `${p.endpoint.slice(p.endpoint.lastIndexOf('/') + 1)} | ${p.title} | ${p.body}`)
  return { sent, send, lines }
}

/** Marks weeks' scores as already written (the scores writer's markers, SPEC §11.10), so a run reads just the one
 *  marker per space for them: for tests about other reads. */
export async function scoresWritten(db: Firestore, spaceId: string, weekIds: string[]) {
  for (const weekId of weekIds) await db.doc(`_private/sent/log/${spaceId}_${weekId}_scores`).set({ kind: 'scores', spaceId, at: ts(at('2026-09-01T00:00:00Z')) })
}

/** The sent log: key → the title sent, or 'skipped'. */
export async function sentLog(db: Firestore): Promise<Record<string, string>> {
  const snap = await db.collection('_private/sent/log').get()
  return Object.fromEntries(snap.docs.map((d) => [d.id, d.get('skipped') ? 'skipped' : d.get('title')]))
}

/** The database, noting the path of every doc read in a batch (getAll). */
export function recording(db: Firestore): { db: Firestore; paths: string[] } {
  const paths: string[] = []
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'getAll') {
        return (...refs: DocumentReference[]) => {
          paths.push(...refs.map((ref) => ref.path))
          return target.getAll(...refs)
        }
      }
      const value: unknown = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { db: proxy, paths }
}
