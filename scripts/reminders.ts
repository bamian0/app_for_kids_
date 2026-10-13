// Hourly reminders job (run by .github/workflows/reminders.yml). See docs/SPEC.md §4.
//
//   FIREBASE_SERVICE_ACCOUNT='<service account JSON>' APP_URL=https://… node scripts/reminders.ts
//
// FIREBASE_SERVICE_ACCOUNT missing: logs and exits 0. DRY_RUN=1: logs what it would send, sends
// and records nothing. FIRESTORE_EMULATOR_HOST set: runs against the emulator (project
// GCLOUD_PROJECT or demo-stakes), where REMINDERS_NOW=<ISO time> may also fake the clock.
//
// Firestore reads stay small on the free plan: outside a reminder window a run reads only the
// spaces, and a window's week data is loaded only while someone with a device still waits for it.
// The midweek nudges read only the week doc and those people's plans, and progress for the ones with tasks.
import { pathToFileURL } from 'node:url'
import { cert, deleteApp, initializeApp, type App, type ServiceAccount } from 'firebase-admin/app'
import { FieldValue, getFirestore, Timestamp, type DocumentReference, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore'
import { IANAZone } from 'luxon'
import webpush from 'web-push'
import { decodeTasks } from '../src/data/tasks.ts'
import type { Mark, MonthId, Plan, Progress, Space, UID, Week, WeekData, WeekId } from '../src/domain/types.ts'
import { dueWindows, isNudge, offsetToStore, planSpace, reminderKey, type PlanInput, type Reminder, type SpaceInput } from './reminders-plan.ts'

export const DEFAULT_APP_URL = 'https://bamian0.github.io/app_for_kids_/'
const FOUR_WEEKS_S = 28 * 24 * 3600
/** gRPC status of a create() on an existing doc. */
const ALREADY_EXISTS = 6

export interface PushKeys {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface SendOptions {
  TTL: number
  urgency: 'normal' | 'high'
  /** Socket timeout for web-push, in ms. */
  timeout: number
}

/** A push service that doesn't answer in time counts as a failed delivery (retried next run). */
export const SEND_TIMEOUT_MS = 10_000
/** One space can't hold up the others for longer than this; the next run picks it up again. */
export const SPACE_BUDGET_MS = 60_000
/** Devices per user that get reminders: the newest ones (old subscriptions pile up otherwise). */
export const MAX_DEVICES = 5
/** Only real push services, as in firestore.rules (validPushSub). */
export const PUSH_HOST = /^https:\/\/(web\.push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.notify\.windows\.com)\//

/** Delivers one push; rejects with an error carrying `statusCode` when the push service refuses it. */
export type SendPush = (subscription: PushKeys, payload: string, options: SendOptions) => Promise<unknown>

export interface RunOptions {
  db: Firestore
  send: SendPush
  nowMs: number
  dryRun?: boolean
  log?: (message: string) => void
  /** Overrides for tests. */
  sendTimeoutMs?: number
  spaceBudgetMs?: number
}

export interface RunSummary {
  spaces: number
  windows: number
  /** Reminders delivered to at least one device. */
  sent: number
  devices: number
  skipped: number
  expiredSubscriptions: number
  failedDeliveries: number
  /** Spaces left for the next run: an unsupported timezone, or over their time budget. */
  skippedSpaces: number
  /** Spaces that could not be processed. */
  errors: number
}

interface Device {
  ref: DocumentReference
  sub: PushKeys
}

// ---------- Firestore → domain ----------

function ms(value: unknown): number {
  if (value instanceof Timestamp) return value.toMillis()
  return typeof value === 'number' ? value : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function times(value: unknown): Record<UID, number> {
  return Object.fromEntries(Object.entries((value ?? {}) as Record<string, unknown>).map(([uid, t]) => [uid, ms(t)]))
}

function toSpace(snap: DocumentSnapshot): Space {
  const d = snap.data() ?? {}
  const space: Space = {
    id: snap.id,
    name: str(d.name),
    reward: str(d.reward),
    penalty: str(d.penalty),
    ownerId: str(d.ownerId),
    memberIds: strings(d.memberIds),
    joinedAt: times(d.joinedAt),
    timezone: str(d.timezone) || 'UTC',
    inviteCode: str(d.inviteCode),
    threshold: typeof d.threshold === 'number' ? d.threshold : 90,
    latePenalty: typeof d.latePenalty === 'number' ? d.latePenalty : 5,
    createdAt: ms(d.createdAt),
  }
  if (typeof d.utcOffsetMin === 'number') space.utcOffsetMin = d.utcOffsetMin
  if (d.leftAt && typeof d.leftAt === 'object') space.leftAt = times(d.leftAt)
  return space
}

/** Push docs → the newest MAX_DEVICES with a real push service and usable keys. */
export function pickDevices(docs: { ref: DocumentReference; data: Record<string, unknown> }[]): { ref: DocumentReference; sub: PushKeys }[] {
  return docs
    .flatMap(({ ref, data }) => {
      const { endpoint, keys, createdAt } = data as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; createdAt?: unknown }
      const valid = typeof endpoint === 'string' && PUSH_HOST.test(endpoint) && typeof keys?.p256dh === 'string' && typeof keys?.auth === 'string'
      return valid ? [{ ref, at: ms(createdAt), sub: { endpoint, keys: { p256dh: keys.p256dh as string, auth: keys.auth as string } } }] : []
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_DEVICES)
    .map(({ ref, sub }) => ({ ref, sub }))
}

/** Rejects with `statusCode`-less timeout error after `ms`, so a hanging push service can't stall the run. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function toWeek(spaceId: string, weekId: WeekId, d: Record<string, unknown>): Week {
  return {
    id: weekId,
    spaceId,
    startAt: ms(d.startAt),
    lockAt: ms(d.lockAt),
    reviewOpenAt: ms(d.reviewOpenAt),
    deadlineAt: ms(d.deadlineAt),
    members: strings(d.members),
    submittedBy: strings(d.submittedBy),
  }
}

function toPlan(snap: DocumentSnapshot): Plan {
  // Steps and mid-week additions decode as in the app, so a task with steps scores by its steps.
  const tasks = decodeTasks(snap.get('tasks'), snap.get('added'), (v) => (v instanceof Timestamp ? v.toMillis() : null))
  return { uid: snap.id, tasks, updatedAt: ms(snap.get('updatedAt')) }
}

function toProgress(snap: DocumentSnapshot): Progress {
  return { uid: snap.id, done: (snap.get('done') ?? {}) as Record<string, boolean>, updatedAt: ms(snap.get('updatedAt')) }
}

async function loadWeek(db: Firestore, spaceId: string, weekId: WeekId): Promise<WeekData> {
  const data: WeekData = { spaceId, weekId, week: null, plans: {}, progress: {}, reviews: [] }
  const ref = db.doc(`spaces/${spaceId}/weeks/${weekId}`)
  const snap = await ref.get()
  const d = snap.data()
  // Plans, progress and reviews can't exist without the week doc (see firestore.rules).
  if (!d) return data
  data.week = toWeek(spaceId, weekId, d)
  const [plans, progress, reviews] = await Promise.all(['plans', 'progress', 'reviews'].map((name) => ref.collection(name).get()))
  for (const p of plans.docs) data.plans[p.id] = toPlan(p)
  for (const p of progress.docs) data.progress[p.id] = toProgress(p)
  data.reviews = reviews.docs.map((r) => ({
    id: r.id,
    reviewerId: str(r.get('reviewerId')),
    revieweeId: str(r.get('revieweeId')),
    marks: (r.get('marks') ?? {}) as Record<string, Mark>,
    submittedAt: ms(r.get('submittedAt')),
  }))
  return data
}

/**
 * What the midweek nudges need, and only for `uids` (those still waiting for one, with a device): the
 * week doc, their plans if they take part, and the progress of those with tasks. Everyone else reads
 * as having no tasks, which the planner never treats as final. No reviews: there are none before Friday.
 */
async function loadNudgeWeek(db: Firestore, spaceId: string, weekId: WeekId, uids: UID[]): Promise<WeekData> {
  const data: WeekData = { spaceId, weekId, week: null, plans: {}, progress: {}, reviews: [] }
  const ref = db.doc(`spaces/${spaceId}/weeks/${weekId}`)
  const d = (await ref.get()).data()
  if (!d) return data
  const week = toWeek(spaceId, weekId, d)
  data.week = week
  const participants = uids.filter((uid) => week.members.includes(uid))
  if (participants.length === 0) return data
  for (const snap of await db.getAll(...participants.map((uid) => ref.collection('plans').doc(uid)))) {
    if (snap.exists) data.plans[snap.id] = toPlan(snap)
  }
  const withTasks = participants.filter((uid) => (data.plans[uid]?.tasks.length ?? 0) > 0)
  if (withTasks.length === 0) return data
  for (const snap of await db.getAll(...withTasks.map((uid) => ref.collection('progress').doc(uid)))) {
    if (snap.exists) data.progress[snap.id] = toProgress(snap)
  }
  return data
}

function logRef(db: Firestore, key: string): DocumentReference {
  return db.doc(`_private/sent/log/${key}`)
}

function errorCode(e: unknown): unknown {
  return typeof e === 'object' && e !== null && 'code' in e ? e.code : undefined
}

function statusCode(e: unknown): number | undefined {
  return typeof e === 'object' && e !== null && 'statusCode' in e && typeof e.statusCode === 'number' ? e.statusCode : undefined
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Creates the log doc; false if another run already did. This is what makes each reminder go out once. */
async function claim(db: Firestore, key: string, data: Record<string, unknown>): Promise<boolean> {
  try {
    await logRef(db, key).create({ ...data, at: FieldValue.serverTimestamp() })
    return true
  } catch (e) {
    if (errorCode(e) === ALREADY_EXISTS) return false
    throw e
  }
}

// ---------- VAPID ----------

export interface VapidKeys {
  publicKey: string
  privateKey: string
}

/** Reads the VAPID keys from _private/vapid, creating them on the first run, and mirrors the
 *  public key to public/config where the app reads it. */
export async function ensureVapidKeys(db: Firestore, generate: () => VapidKeys): Promise<VapidKeys> {
  const ref = db.doc('_private/vapid')
  const read = async (): Promise<VapidKeys | null> => {
    const snap = await ref.get()
    if (!snap.exists) return null
    const publicKey = snap.get('publicKey')
    const privateKey = snap.get('privateKey')
    if (typeof publicKey !== 'string' || typeof privateKey !== 'string' || !publicKey || !privateKey) {
      throw new Error('_private/vapid exists but has no publicKey/privateKey. Delete the doc to generate new keys.')
    }
    return { publicKey, privateKey }
  }

  let keys = await read()
  if (!keys) {
    const fresh = generate()
    try {
      await ref.create({ ...fresh, createdAt: FieldValue.serverTimestamp() })
      keys = fresh
    } catch (e) {
      // Another run won the race; use its keys.
      if (errorCode(e) !== ALREADY_EXISTS) throw e
      keys = await read()
      if (!keys) throw e
    }
  }

  const config = db.doc('public/config')
  if ((await config.get()).get('vapidPublicKey') !== keys.publicKey) {
    await config.set({ vapidPublicKey: keys.publicKey }, { merge: true })
  }
  return keys
}

// ---------- the run ----------

export async function runReminders({
  db,
  send,
  nowMs,
  dryRun = false,
  log = console.log,
  sendTimeoutMs = SEND_TIMEOUT_MS,
  spaceBudgetMs = SPACE_BUDGET_MS,
}: RunOptions): Promise<RunSummary> {
  const summary: RunSummary = {
    spaces: 0, windows: 0, sent: 0, devices: 0, skipped: 0, expiredSubscriptions: 0, failedDeliveries: 0, skippedSpaces: 0, errors: 0,
  }
  const deviceCache = new Map<UID, Promise<Device[]>>()
  const profiles: PlanInput['profiles'] = {}

  const devicesOf = (uid: UID): Promise<Device[]> => {
    let pending = deviceCache.get(uid)
    if (!pending) {
      pending = db
        .collection(`users/${uid}/push`)
        .get()
        .then((snap) => pickDevices(snap.docs.map((doc) => ({ ref: doc.ref, data: doc.data() }))))
      deviceCache.set(uid, pending)
    }
    return pending
  }

  const loadProfiles = async (uids: UID[]) => {
    const missing = uids.filter((uid) => !(uid in profiles))
    if (missing.length === 0) return
    const snaps = await db.getAll(...missing.map((uid) => db.doc(`users/${uid}`)))
    for (const snap of snaps) profiles[snap.id] = { name: str(snap.get('name')) }
  }

  const deliver = async (reminder: Reminder) => {
    const devices = await devicesOf(reminder.uid)
    // Left unclaimed: if they turn reminders on later in the window, they still get it.
    if (devices.length === 0) return
    if (dryRun) {
      log(`[dry run] ${reminder.key} → ${devices.length} device(s): ${reminder.title} · ${reminder.body}`)
      summary.sent++
      return
    }
    const claimed = await claim(db, reminder.key, { kind: reminder.kind, spaceId: reminder.spaceId, uid: reminder.uid, title: reminder.title })
    if (!claimed) return

    const payload = JSON.stringify({ title: reminder.title, body: reminder.body, url: reminder.url, tag: reminder.tag })
    const options: SendOptions = {
      TTL: Math.max(60, Math.min(FOUR_WEEKS_S, Math.round((reminder.expiresAt - nowMs) / 1000))),
      urgency: reminder.kind === 'last-call' ? 'high' : 'normal',
      timeout: sendTimeoutMs,
    }
    const results = await Promise.allSettled(devices.map((d) => withTimeout(send(d.sub, payload, options), sendTimeoutMs, 'push')))
    let delivered = 0
    let failed = 0
    const expired = new Set<Device>()
    for (const [i, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        delivered++
        continue
      }
      const status = statusCode(result.reason)
      if (status === 404 || status === 410) {
        // The browser dropped this subscription for good.
        await devices[i].ref.delete()
        expired.add(devices[i])
        summary.expiredSubscriptions++
      } else {
        failed++
        log(`push failed for ${reminder.key}: ${status ?? ''} ${message(result.reason)}`.trim())
      }
    }
    if (expired.size > 0) deviceCache.set(reminder.uid, Promise.resolve(devices.filter((d) => !expired.has(d))))
    summary.failedDeliveries += failed
    summary.devices += delivered
    if (delivered > 0) summary.sent++
    // Nothing got through for a temporary reason: release the claim so the next run retries.
    else if (failed > 0) await logRef(db, reminder.key).delete()
  }

  const runSpace = async (space: Space) => {
    const windows = dueWindows(space, nowMs)
    if (windows.length === 0 || space.memberIds.length === 0) return
    summary.windows += windows.length

    const keyed = windows.flatMap((window) => space.memberIds.map((uid) => ({ window, uid, key: reminderKey(space.id, window.period, window.kind, uid) })))
    const logged = await db.getAll(...keyed.map(({ key }) => logRef(db, key)))
    const sent = new Set(logged.filter((snap) => snap.exists).map((snap) => snap.id))

    // Load a window's weeks only if someone with a device is still waiting for it. For a nudge, only
    // what those people need (loadNudgeWeek).
    const weekIds = new Set<WeekId>()
    const nudged = new Map<WeekId, Set<UID>>()
    for (const window of windows) {
      const waiting = keyed.filter((k) => k.window === window && !sent.has(k.key)).map((k) => k.uid)
      const devices = await Promise.all(waiting.map(devicesOf))
      const reachable = waiting.filter((_, i) => devices[i].length > 0)
      if (reachable.length === 0) continue
      for (const id of window.weekIds) {
        if (isNudge(window.kind)) nudged.set(id, new Set([...(nudged.get(id) ?? []), ...reachable]))
        else weekIds.add(id)
      }
    }
    if (weekIds.size === 0 && nudged.size === 0) return

    const weeks = Object.fromEntries(await Promise.all([...weekIds].map(async (id) => [id, await loadWeek(db, space.id, id)] as const)))
    // A week loaded whole for another window serves the nudges too.
    for (const [id, uids] of nudged) if (!weekIds.has(id)) weeks[id] = await loadNudgeWeek(db, space.id, id, [...uids])
    const stakes: NonNullable<SpaceInput['stakes']> = {}
    for (const window of windows) if (window.kind === 'verdict') Object.assign(stakes, await loadStakes(db, space.id, window.period))
    // Names are for the review reminders, never the nudges. Week members too: someone who left after
    // lock is still named as a friend to review.
    if (weekIds.size > 0) await loadProfiles([...new Set([...space.memberIds, ...[...weekIds].flatMap((id) => weeks[id].week?.members ?? [])])])
    const plan = planSpace({ space, weeks, stakes }, profiles, sent, nowMs)

    if (!dryRun) {
      for (const key of plan.skipped) {
        const uid = keyed.find((k) => k.key === key)?.uid
        if (await claim(db, key, { skipped: true, spaceId: space.id, uid })) summary.skipped++
      }
    }
    for (const reminder of plan.send) await deliver(reminder)
  }

  const spaces = await db.collection('spaces').get()
  summary.spaces = spaces.size
  for (const snap of spaces.docs) {
    const space = toSpace(snap)
    // A zone the runtime doesn't know (anyone can create a space with any zone-shaped string) is that
    // space's problem, not a failed run.
    if (!IANAZone.isValidZone(space.timezone)) {
      summary.skippedSpaces++
      log(`space ${snap.id} skipped: unsupported timezone ${JSON.stringify(space.timezone)}`)
      continue
    }
    try {
      if (!dryRun) await backfillOffset(snap.ref, space, nowMs)
      const outcome = await withTimeout(runSpace(space).then(() => 'done' as const), spaceBudgetMs, `space ${snap.id}`).catch((e: unknown) => {
        if (e instanceof Error && e.message.startsWith(`space ${snap.id} timed out`)) return 'slow' as const
        throw e
      })
      if (outcome === 'slow') {
        summary.skippedSpaces++
        log(`space ${snap.id} skipped: over its ${spaceBudgetMs} ms budget`)
      }
    } catch (e) {
      summary.errors++
      log(`space ${snap.id} failed: ${message(e)}`)
    }
  }
  return summary
}

/** Frozen stakes of one month, keyed by month, or nothing if the month was never frozen. */
async function loadStakes(db: Firestore, spaceId: string, monthId: MonthId): Promise<NonNullable<SpaceInput['stakes']>> {
  const snap = await db.doc(`spaces/${spaceId}/months/${monthId}`).get()
  const reward = snap.get('reward')
  const penalty = snap.get('penalty')
  return snap.exists && typeof reward === 'string' && typeof penalty === 'string' ? { [monthId]: { reward, penalty } } : {}
}

/**
 * Spaces from before utcOffsetMin get it from here, computed from their own zone, and so do spaces
 * created with an offset that doesn't fit their zone (clients can't be trusted to set it; the rules
 * then anchor every new week to it).
 */
async function backfillOffset(ref: DocumentReference, space: Space, nowMs: number): Promise<void> {
  const offset = offsetToStore(space, nowMs)
  if (offset === null) return
  await ref.update({ utcOffsetMin: offset })
  space.utcOffsetMin = offset
}

// ---------- entry point ----------

function initFirebase(): App | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim()
  if (raw) {
    // The key file uses snake_case (project_id, private_key…), which cert() also accepts.
    let account: ServiceAccount & { project_id?: string }
    try {
      account = JSON.parse(raw)
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the whole service account key file as the secret.')
    }
    return initializeApp({ credential: cert(account), projectId: account.project_id ?? account.projectId })
  }
  if (process.env.FIRESTORE_EMULATOR_HOST) return initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-stakes' })
  return null
}

async function main(): Promise<void> {
  const app = initFirebase()
  if (!app) {
    console.log('FIREBASE_SERVICE_ACCOUNT is not set, so there is nothing to do. Add it as a repository secret to turn reminders on.')
    return
  }
  const db = getFirestore(app)
  try {
    const fakeNow = process.env.FIRESTORE_EMULATOR_HOST ? Date.parse(process.env.REMINDERS_NOW ?? '') : NaN
    const nowMs = Number.isNaN(fakeNow) ? Date.now() : fakeNow
    const dryRun = ['1', 'true'].includes(process.env.DRY_RUN ?? '')
    const appUrl = process.env.APP_URL?.trim() || DEFAULT_APP_URL

    const vapid = await ensureVapidKeys(db, () => webpush.generateVAPIDKeys())
    // Apple rejects pushes whose VAPID subject isn't a real https: or mailto: contact.
    webpush.setVapidDetails(appUrl, vapid.publicKey, vapid.privateKey)

    const summary = await runReminders({
      db,
      nowMs,
      dryRun,
      // web-push's own socket timeout; runReminders also races each send against the same limit.
      send: (sub, payload, options) => webpush.sendNotification(sub, payload, options),
    })
    console.log(`${new Date(nowMs).toISOString()}${dryRun ? ' (dry run)' : ''}`, JSON.stringify(summary))
    if (summary.errors > 0) process.exitCode = 1
  } finally {
    await deleteApp(app)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e)
    process.exit(1)
  })
}
