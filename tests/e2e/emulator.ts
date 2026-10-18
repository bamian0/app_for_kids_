// Admin access to the emulators for seeding (the Admin SDK bypasses security rules).
// `firebase emulators:exec` sets the *_EMULATOR_HOST variables; the defaults match firebase.json.
import { getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore, Timestamp, type DocumentReference, type Firestore } from 'firebase-admin/firestore'
import { settlementDocId } from '../../src/domain/ids.ts'
import type { PairTerms, WeekSchedule } from '../../src/domain/types.ts'

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
  /** Someone who joined later than `at`. */
  joinedAt?: Record<string, number>
  /** Former members: when they left (they are no longer in `members`). */
  leftAt?: Record<string, number>
  /** Batch 2 (SPEC §9): the space's own times, the members who only rate, a completed pause per month. */
  schedule?: WeekSchedule
  judges?: string[]
  paused?: Record<string, string>
}

/** A space and its invite, as createSpace and joining leave them. */
export async function setSpace(spaceId: string, s: SeedSpace): Promise<void> {
  const owner = s.members[0]
  const doc: Record<string, unknown> = {
    name: s.name,
    reward: s.reward,
    penalty: s.penalty,
    ownerId: owner,
    memberIds: s.members,
    joinedAt: Object.fromEntries(s.members.map((uid) => [uid, ts(s.joinedAt?.[uid] ?? s.at)])),
    timezone: s.timezone,
    utcOffsetMin: s.utcOffsetMin,
    inviteCode: s.inviteCode,
    threshold: 90,
    latePenalty: 5,
    createdAt: ts(s.at),
  }
  if (s.leftAt) doc.leftAt = Object.fromEntries(Object.entries(s.leftAt).map(([uid, ms]) => [uid, ts(ms)]))
  if (s.schedule) doc.schedule = s.schedule
  if (s.judges) doc.judges = s.judges
  if (s.paused) doc.paused = s.paused
  await db.doc(`spaces/${spaceId}`).set(doc)
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

export const spaceDoc = (spaceId: string) => db.doc(`spaces/${spaceId}`)

export interface SeedWeek {
  startAt: number
  lockAt: number
  reviewOpenAt: number
  deadlineAt: number
  members: string[]
  submittedBy: string[]
  /** Batch 2: the schedule its bounds follow (absent = the usual one) and its judges snapshot. */
  schedule?: WeekSchedule
  judges?: string[]
}

export function weekDoc(spaceId: string, weekId: string) {
  return db.doc(`spaces/${spaceId}/weeks/${weekId}`)
}

function periodFields(w: SeedWeek): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    startAt: ts(w.startAt),
    lockAt: ts(w.lockAt),
    reviewOpenAt: ts(w.reviewOpenAt),
    deadlineAt: ts(w.deadlineAt),
    members: w.members,
    submittedBy: w.submittedBy,
  }
  if (w.schedule) doc.schedule = w.schedule
  if (w.judges) doc.judges = w.judges
  return doc
}

export async function setWeek(spaceId: string, weekId: string, w: SeedWeek): Promise<void> {
  await weekDoc(spaceId, weekId).set(periodFields(w))
}

/** One change of a task's cross-out log (SPEC §10.3): crossed out with a reason (odd changes), or restored. */
export interface SeedChange {
  at: number
  /** Given on a cross-out; left out on an undo. */
  why?: string
}

/**
 * A plan's `cancels` log as crossOutTask / undoCrossOut leave it: for each task id, its changes in order, written as
 * `${n}:${taskId}` → { at, why } (n odd) or { at } (n even).
 */
export function cancelsLog(changes: Record<string, SeedChange[]>): Record<string, { at: Timestamp; why?: string }> {
  const log: Record<string, { at: Timestamp; why?: string }> = {}
  for (const [taskId, list] of Object.entries(changes)) {
    list.forEach((c, i) => {
      const n = i + 1
      log[`${n}:${taskId}`] = n % 2 === 1 ? { at: ts(c.at), why: c.why ?? 'Something came up' } : { at: ts(c.at) }
    })
  }
  return log
}

function planFields(tasks: SeedTask[], at: number, added?: Record<string, number>, cancels?: Record<string, SeedChange[]>): Record<string, unknown> {
  const plan: Record<string, unknown> = { tasks, updatedAt: ts(at) }
  if (added) plan.added = Object.fromEntries(Object.entries(added).map(([id, ms]) => [id, ts(ms)]))
  if (cancels) plan.cancels = cancelsLog(cancels)
  return plan
}

/** `added`: tasks appended after the lock, with their add times. `cancels` (batch 2.5): each task's cross-out changes. */
export async function setPlan(
  spaceId: string,
  weekId: string,
  uid: string,
  tasks: SeedTask[],
  at: number,
  added?: Record<string, number>,
  cancels?: Record<string, SeedChange[]>,
): Promise<void> {
  await weekDoc(spaceId, weekId).collection('plans').doc(uid).set(planFields(tasks, at, added, cancels))
}

export async function setProgress(spaceId: string, weekId: string, uid: string, done: Record<string, boolean>, at: number): Promise<void> {
  await weekDoc(spaceId, weekId).collection('progress').doc(uid).set({ done, updatedAt: ts(at) })
}

/** `marks`: 0, 0.5 or 1 per task, or (batch 2.5) 'fair' on a crossed-out task. */
export async function setReview(spaceId: string, weekId: string, reviewerId: string, revieweeId: string, marks: Record<string, number | 'fair'>, at: number): Promise<void> {
  await weekDoc(spaceId, weekId)
    .collection('reviews')
    .doc(`${reviewerId}_${revieweeId}`)
    .set({ reviewerId, revieweeId, marks, submittedAt: ts(at) })
}

// ---------- Batch 2: monthly lists, stakes, month freezes, results, settlements ----------

export function monthlyDoc(spaceId: string, monthId: string) {
  return db.doc(`spaces/${spaceId}/monthly/${monthId}`)
}

/** A month's list (SPEC §9.5): a week's shape with `judges` always present and never a `schedule`. */
export async function setMonthly(spaceId: string, monthId: string, w: Omit<SeedWeek, 'schedule'>): Promise<void> {
  const { judges, ...period } = w
  await monthlyDoc(spaceId, monthId).set({ ...periodFields(period), judges: judges ?? [] })
}

/** Batch 2.5: a list's plan may hold `added` (tasks added after its lock) and a `cancels` log, like a week's. */
export async function setMonthlyPlan(
  spaceId: string,
  monthId: string,
  uid: string,
  tasks: SeedTask[],
  at: number,
  added?: Record<string, number>,
  cancels?: Record<string, SeedChange[]>,
): Promise<void> {
  await monthlyDoc(spaceId, monthId).collection('plans').doc(uid).set(planFields(tasks, at, added, cancels))
}

export async function setMonthlyReview(spaceId: string, monthId: string, reviewerId: string, revieweeId: string, marks: Record<string, number | 'fair'>, at: number): Promise<void> {
  await monthlyDoc(spaceId, monthId)
    .collection('reviews')
    .doc(`${reviewerId}_${revieweeId}`)
    .set({ reviewerId, revieweeId, marks, submittedAt: ts(at) })
}

export async function setMonthlyProgress(spaceId: string, monthId: string, uid: string, done: Record<string, boolean>, at: number): Promise<void> {
  await monthlyDoc(spaceId, monthId).collection('progress').doc(uid).set({ done, updatedAt: ts(at) })
}

/** One friend's agreement as stored: the current terms at `at`, earlier ones (oldest first) in `past`. */
export interface SeedAgreement {
  at: number
  terms: PairTerms
  past?: (PairTerms & { at: number })[]
}

export interface SeedStakes {
  rewardMode: 'group' | 'each'
  penaltyMode: 'group' | 'each'
  reward: string
  penalty: string
  per?: Record<string, { reward: string; penalty: string }>
  tiers?: { months: number; reward: string }[]
  agreed?: Record<string, SeedAgreement>
  updatedAt: number
}

/** spaces/{id}/stakes/{uid} as saveMyStakes and agreeToStakes leave it (SPEC §9.7). */
export async function setStakes(spaceId: string, uid: string, s: SeedStakes): Promise<void> {
  const agreed = Object.fromEntries(
    Object.entries(s.agreed ?? {}).map(([friend, a]) => [friend, { at: ts(a.at), terms: a.terms, past: (a.past ?? []).map((p) => ({ ...p, at: ts(p.at) })) }]),
  )
  await db.doc(`spaces/${spaceId}/stakes/${uid}`).set({
    rewardMode: s.rewardMode,
    penaltyMode: s.penaltyMode,
    reward: s.reward,
    penalty: s.penalty,
    per: s.per ?? {},
    tiers: s.tiers ?? [],
    agreed,
    updatedAt: ts(s.updatedAt),
  })
}

/** The exact pair terms a friend agrees to: what pairTerms gives for them. */
export function pairOf(s: Pick<SeedStakes, 'rewardMode' | 'penaltyMode' | 'reward' | 'penalty' | 'per' | 'tiers'>, friend: string): PairTerms {
  return {
    rewardMode: s.rewardMode,
    penaltyMode: s.penaltyMode,
    reward: s.rewardMode === 'group' ? s.reward : (s.per?.[friend]?.reward ?? ''),
    penalty: s.penaltyMode === 'group' ? s.penalty : (s.per?.[friend]?.penalty ?? ''),
    tiers: s.tiers ?? [],
  }
}

export function monthStakesDoc(spaceId: string, monthId: string) {
  return db.doc(`spaces/${spaceId}/months/${monthId}`)
}

/** A month's frozen house stakes (`months/{monthId}`), e.g. the previous app's early freeze at a first lock. */
export async function setMonthStakes(spaceId: string, monthId: string, m: { reward: string; penalty: string; createdAt: number }): Promise<void> {
  await monthStakesDoc(spaceId, monthId).set({ reward: m.reward, penalty: m.penalty, createdAt: ts(m.createdAt) })
}

/** A month's results doc as the reminders job writes it (SPEC §9.8). */
export async function setResults(
  spaceId: string,
  monthId: string,
  r: { completeAt: number; members: Record<string, { score: number | null; passed: boolean | null; streak: number; tierRuns?: Record<string, number> }>; createdAt: number },
): Promise<void> {
  await db.doc(`spaces/${spaceId}/results/${monthId}`).set({ monthId, completeAt: ts(r.completeAt), members: r.members, createdAt: ts(r.createdAt) })
}

export interface SeedSettlement {
  monthId: string
  uid: string
  /** Absent: the legacy per-member doc from before batch 2. */
  other?: string
  tier?: number
  settled: boolean
  settledBy: string
  settledAt: number
}

export function settlementDoc(spaceId: string, monthId: string, uid: string, other?: string, tier?: number) {
  return db.doc(`spaces/${spaceId}/settlements/${settlementDocId(monthId, uid, other, tier)}`)
}

export async function setSettlement(spaceId: string, s: SeedSettlement): Promise<void> {
  const doc: Record<string, unknown> = { monthId: s.monthId, uid: s.uid, settled: s.settled, settledBy: s.settledBy, settledAt: ts(s.settledAt) }
  if (s.other !== undefined) doc.other = s.other
  if (s.tier !== undefined) doc.tier = s.tier
  await settlementDoc(spaceId, s.monthId, s.uid, s.other, s.tier).set(doc)
}

/**
 * A week that has been played and reviewed: the doc, a plan per player, everything ticked, and a review from
 * every player of every other player marking each task `marks[reviewee]` (default 1), with everyone submitted.
 * `skip` lists reviewers who never reviewed (they aren't in submittedBy and lose 5 points per friend).
 */
export async function setPlayedWeek(
  spaceId: string,
  weekId: string,
  bounds: { startAt: number; lockAt: number; reviewOpenAt: number; deadlineAt: number },
  plans: Record<string, SeedTask[]>,
  opts: { marks?: Record<string, 0 | 0.5 | 1>; skip?: string[]; judges?: string[]; members?: string[] } = {},
): Promise<void> {
  const players = Object.keys(plans)
  const members = opts.members ?? [...players, ...(opts.judges ?? [])]
  const reviewers = members.filter((uid) => !(opts.skip ?? []).includes(uid))
  await setWeek(spaceId, weekId, { ...bounds, members, submittedBy: reviewers, ...(opts.judges ? { judges: opts.judges } : {}) })
  for (const [uid, tasks] of Object.entries(plans)) {
    await setPlan(spaceId, weekId, uid, tasks, bounds.startAt)
    await setProgress(spaceId, weekId, uid, Object.fromEntries(tasks.map((t) => [t.id, true])), bounds.reviewOpenAt)
  }
  for (const reviewer of reviewers) {
    for (const reviewee of players) {
      if (reviewee === reviewer) continue
      const mark = opts.marks?.[reviewee] ?? 1
      await setReview(spaceId, weekId, reviewer, reviewee, Object.fromEntries(plans[reviewee].map((t) => [t.id, mark])), bounds.reviewOpenAt + 3_600_000)
    }
  }
}

/**
 * Ends a month at `deadlineAt` as the server sees it (SPEC §9.6: its last week's stored deadline, or its list's
 * if later): moves the last week's stored deadline and, when a list exists, the list's too, keeping each
 * timeline in order.
 */
export async function endMonthAt(spaceId: string, lastWeekId: string, monthId: string, deadlineAt: number): Promise<void> {
  const move = async (ref: DocumentReference) => {
    const snap = await ref.get()
    if (!snap.exists) return false
    const ms = (key: string) => (snap.get(key) as Timestamp).toMillis()
    const reviewOpenAt = Math.min(ms('reviewOpenAt'), deadlineAt - 3 * 3_600_000)
    const lockAt = Math.min(ms('lockAt'), reviewOpenAt - 3_600_000)
    const startAt = Math.min(ms('startAt'), lockAt - 3_600_000)
    await ref.update({ startAt: ts(startAt), lockAt: ts(lockAt), reviewOpenAt: ts(reviewOpenAt), deadlineAt: ts(deadlineAt) })
    return true
  }
  if (!(await move(weekDoc(spaceId, lastWeekId)))) throw new Error(`No week doc ${lastWeekId} to end ${monthId} with`)
  await move(monthlyDoc(spaceId, monthId))
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
