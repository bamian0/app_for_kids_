// Hourly reminders job (run by .github/workflows/reminders.yml). See docs/SPEC.md §4, §9.11 and §11.10.
//
//   FIREBASE_SERVICE_ACCOUNT='<service account JSON>' APP_URL=https://… node scripts/reminders.ts
//
// FIREBASE_SERVICE_ACCOUNT missing: logs and exits 0. DRY_RUN=1: logs what it would send and write, sends
// and records nothing. FIRESTORE_EMULATOR_HOST set: runs against the emulator (project GCLOUD_PROJECT or
// demo-stakes), where REMINDERS_NOW=<ISO time> may also fake the clock.
//
// Firestore reads stay small on the free plan: outside a reminder window a run reads only the spaces and each
// space's newest month results doc, and a window's data is loaded only while someone with a device still waits
// for it. The midweek nudges read only the week doc and those people's plans, and progress for the ones with
// tasks. Each run first writes the month results (streaks) of months that are complete (ensureResults) and, once a
// week's deadline has passed, each member's scores, ring and stats (ensureScores, batch 3); between Saturday 15:00 and
// Monday 13:00 UTC it also sends the shared goals' weekly check-in push. The summary it logs counts every doc it read.
// Deals (SPEC §12.11): only in a space with `hasDeals`, it confirms each deal's periods and end (ensureDeals) and sends
// the `deal` and `deal-end` pushes; it records the month stakes cutover (public/config.dealsFrom) once, from the first
// deal. A space without `hasDeals` costs and gets exactly what it did before deals.
import { pathToFileURL } from 'node:url'
import { cert, deleteApp, initializeApp, type App, type ServiceAccount } from 'firebase-admin/app'
import { FieldValue, getFirestore, Timestamp, type DocumentReference, type DocumentSnapshot, type Firestore, type Query } from 'firebase-admin/firestore'
import { IANAZone } from 'luxon'
import webpush from 'web-push'
import { decodeTasks } from '../src/data/tasks.ts'
import { dealClock, dealPeriodsToLoad, dealState, monthDealPeriod, weekDealPeriod } from '../src/domain/deals.ts'
import { decodeCheckin, decodeDeal, decodeMemberStakes, decodeMonthResults, decodeScores, decodeSharedGoal, decodeSpaceExtras, decodeWeekExtras } from '../src/domain/decode.ts'
import { boundsFor } from '../src/domain/schedule.ts'
import { computeMonth, judgesOf, monthEndsAt, monthEndsAtFor } from '../src/domain/scoring.ts'
import { isGoalId } from '../src/domain/shared.ts'
import { ringOf, statsOf } from '../src/domain/showcase.ts'
import { buildMonthResults, DEALS_FROM_MONTH, dealsFromAt, FIRST_RESULTS_MONTH, freezeBinds, monthTerms, type House } from '../src/domain/stakes.ts'
import { addMonths, addWeeks, firstMonthOf, weekIdFor, weekIdsInMonth } from '../src/domain/time.ts'
import type {
  Deal,
  DealEnd,
  DealPeriod,
  LineInForce,
  MemberStakes,
  MonthId,
  MonthlyData,
  MonthlyList,
  MonthResults,
  Plan,
  Progress,
  Review,
  ReviewMark,
  ScoreEntry,
  ScoreMonths,
  SharedGoal,
  Space,
  UID,
  Week,
  WeekData,
  WeekId,
} from '../src/domain/types.ts'
import {
  checkinCandidates,
  checkinGateOpen,
  dealCandidates,
  dealHours,
  dueWindows,
  isMuted,
  isNudge,
  offsetToStore,
  planShared,
  planSpace,
  planWindows,
  resultsTarget,
  scoreEntries,
  SCORES_PER_RUN,
  SCORES_PER_SPACE,
  scoresKey,
  scoresTarget,
  stakesCandidates,
  stakesWindow,
  weekLoad,
  statsKey,
  windowKeys,
  type DueWindow,
  type FrozenStakes,
  type PlanInput,
  type Reminder,
  type SpaceInput,
  type WeekLoad,
} from './reminders-plan.ts'

export const DEFAULT_APP_URL = 'https://bamian0.github.io/app_for_kids_/'
const FOUR_WEEKS_S = 28 * 24 * 3600
const DAY_MS = 24 * 3_600_000
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
/** After a change of times, stored week timelines can differ from computed ones for this long: a week that
 *  couldn't be retimed locks within 7 days, its deadline is at most 7 days later, then results and the verdict
 *  take up to 3 more. Within it the job reads last, this and next week's docs first (SPEC §9.11). */
export const PRELOAD_MS = 21 * DAY_MS
/** Month results docs written per space and per run (SPEC §9.11): a backfill after an outage spreads over runs. */
export const RESULTS_PER_SPACE = 2
export const RESULTS_PER_RUN = 6
/** How many months back the results writer looks for the newest results doc before giving up. */
const MAX_RESULTS_WALK = 24
/** How far back the `stakes` push looks for changed stakes. */
const STAKES_RECENT_MS = 7 * DAY_MS
/** A space everyone has left still gets its scores written this long after the last one left, so the month they
 *  left in (and its list) is written as final for them (SPEC §11.10): at most ~6 weeks to the month's end, plus a week. */
export const EMPTIED_SCORES_MS = 60 * DAY_MS

/** Deal period loads (SPEC §12.11): a whole week, or a whole month with its list, per space and per run. Loads the
 *  results and scores writers already made in the run are free. The rest wait for the next run. */
export const DEAL_LOADS_PER_SPACE = 4
export const DEAL_LOADS_PER_RUN = 16
/** The deals whose end the `deal-end` push may still tell (SPEC §12.11): ended in the last 3 days. */
const DEAL_RECENT_MS = 3 * DAY_MS

const MONTH_ID = /^\d{4}-(0[1-9]|1[0-2])$/

/** A stored `dealsFrom`: a 'YYYY-MM' at or after DEALS_FROM_MONTH (the floor), else null (absent or malformed). */
export function storedDealsFrom(v: unknown): MonthId | null {
  if (typeof v !== 'string' || !MONTH_ID.test(v)) return null
  return v >= DEALS_FROM_MONTH ? v : DEALS_FROM_MONTH
}

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
  /**
   * The month stakes cutover (SPEC §12.3, §12.11), as main read it from public/config (ensureVapidKeys): a month →
   * every space's planner and verdicts use it; null (read, absent) → the run records it from the first deal it finds
   * (a space with `hasDeals`), once ever, and uses it; while there is no deal to record it from (before the ship),
   * each space's is `dealsFromAt(space, nowMs)`, what the first deal would record if made now, so every month the
   * job decides keeps its stakes as before deals; undefined (not given, as in the tests) → DEALS_FROM_MONTH, never
   * recorded.
   */
  dealsFrom?: MonthId | null
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
  /** Month results docs written (in a dry run: that would have been). */
  results: number
  /** rings/{uid} and stats/{uid} docs written by the scores writer (in a dry run: that would have been). */
  rings: number
  stats: number
  /** Uids without a profile whose scores, ring and stats were deleted. */
  cleaned: number
  /** Shared goals looked at for the check-in push (only between Saturday 15:00 and Monday 13:00 UTC). */
  goals: number
  /** Deal docs the job updated (stamps, periods, ends, its withdrawals; in a dry run: that would have been). */
  deals: number
  /** Deals it ended won, lost or off. */
  dealsEnded: number
  /** Docs read, as Firestore bills them: each doc fetched, one for a missing doc or an empty query. */
  reads: number
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

/** A stored time for the shared decoders (src/domain/decode.ts). */
function toMs(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis()
  return typeof value === 'number' ? value : null
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
  // Times, pause, judges and the house-stakes note, decoded as the app does (malformed values read as absent).
  return Object.assign(space, decodeSpaceExtras(d, toMs))
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

/** A week doc, or a monthly list (the same shape, `id` its MonthId), with its schedule and judges. */
function toPeriod(spaceId: string, id: string, d: Record<string, unknown>): Week {
  const period: Week = {
    id,
    spaceId,
    startAt: ms(d.startAt),
    lockAt: ms(d.lockAt),
    reviewOpenAt: ms(d.reviewOpenAt),
    deadlineAt: ms(d.deadlineAt),
    members: strings(d.members),
    submittedBy: strings(d.submittedBy),
  }
  const extras = decodeWeekExtras(d)
  if (extras.schedule) period.schedule = extras.schedule
  if (extras.judges) period.judges = extras.judges
  return period
}

function toPlan(snap: DocumentSnapshot): Plan {
  // Steps, mid-week additions and cross-outs decode as in the app, so a task with steps scores by its steps and a
  // crossed-out task is voted on (SPEC §10.4).
  const tasks = decodeTasks(snap.get('tasks'), snap.get('added'), (v) => (v instanceof Timestamp ? v.toMillis() : null), snap.get('cancels'))
  return { uid: snap.id, tasks, updatedAt: ms(snap.get('updatedAt')) }
}

function toProgress(snap: DocumentSnapshot): Progress {
  return { uid: snap.id, done: (snap.get('done') ?? {}) as Record<string, boolean>, updatedAt: ms(snap.get('updatedAt')) }
}

function toReview(snap: DocumentSnapshot): Review {
  return {
    id: snap.id,
    reviewerId: str(snap.get('reviewerId')),
    revieweeId: str(snap.get('revieweeId')),
    marks: (snap.get('marks') ?? {}) as Record<string, ReviewMark>,
    submittedAt: ms(snap.get('submittedAt')),
  }
}

/** spaces/{id}/months/{monthId}: a month's frozen house stakes, with when they were frozen. */
function toFrozen(snap: DocumentSnapshot): FrozenStakes | null {
  const reward = snap.get('reward')
  const penalty = snap.get('penalty')
  if (!snap.exists || typeof reward !== 'string' || typeof penalty !== 'string') return null
  const frozen: FrozenStakes = { reward, penalty }
  const createdAt = toMs(snap.get('createdAt'))
  if (createdAt !== null) frozen.createdAt = createdAt
  return frozen
}

// ---------- domain → Firestore ----------

function lineData(line: LineInForce): Record<string, unknown> {
  const out: Record<string, unknown> = { text: line.text, together: line.together, source: line.source }
  if (line.at !== undefined) out.at = Timestamp.fromMillis(line.at)
  return out
}

/** A month results doc as stored (SPEC §9.8): times as Timestamps, no undefined values, createdAt the server's. */
function resultsData(doc: Omit<MonthResults, 'createdAt'>): Record<string, unknown> {
  const members = Object.fromEntries(
    Object.entries(doc.members).map(([uid, e]) => [uid, { score: e.score, passed: e.passed, streak: e.streak, ...(e.tierRuns ? { tierRuns: e.tierRuns } : {}) }]),
  )
  const out: Record<string, unknown> = { monthId: doc.monthId, completeAt: Timestamp.fromMillis(doc.completeAt), members, createdAt: FieldValue.serverTimestamp() }
  if (doc.terms) {
    out.terms = Object.fromEntries(
      Object.entries(doc.terms).map(([subject, pairs]) => [
        subject,
        Object.fromEntries(
          Object.entries(pairs).map(([other, t]) => [
            other,
            { reward: lineData(t.reward), penalty: lineData(t.penalty), tiers: t.tiers.map(({ months, reward }) => ({ months, reward })) },
          ]),
        ),
      ]),
    )
  }
  return out
}

// ---------- helpers ----------

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

/** The member a sent-log key belongs to: its last part (uids have no `_`). */
function uidOfKey(key: string): UID {
  return key.slice(key.lastIndexOf('_') + 1)
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

const LOAD_RANK: Record<WeekLoad, number> = { doc: 0, nudge: 1, full: 2 }

// ---------- VAPID ----------

export interface VapidKeys {
  publicKey: string
  privateKey: string
}

/** Reads the VAPID keys from _private/vapid, creating them on the first run, and mirrors the
 *  public key to public/config where the app reads it. Also gives that config's `dealsFrom` (SPEC §12.11; null when
 *  absent or malformed), which main passes to the run. */
export async function ensureVapidKeys(db: Firestore, generate: () => VapidKeys): Promise<VapidKeys & { dealsFrom: MonthId | null }> {
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
  const snap = await config.get()
  if (snap.get('vapidPublicKey') !== keys.publicKey) {
    await config.set({ vapidPublicKey: keys.publicKey }, { merge: true })
  }
  return { ...keys, dealsFrom: storedDealsFrom(snap.get('dealsFrom')) }
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
  dealsFrom: givenDealsFrom,
}: RunOptions): Promise<RunSummary> {
  const summary: RunSummary = {
    spaces: 0, windows: 0, sent: 0, devices: 0, skipped: 0, expiredSubscriptions: 0, failedDeliveries: 0, skippedSpaces: 0, errors: 0, results: 0, reads: 0,
    rings: 0, stats: 0, cleaned: 0, goals: 0, deals: 0, dealsEnded: 0,
  }
  /** The cutover in force for this run (SPEC §12.3): given, recorded below from the first deal, or the floor; null
   *  while main read none and no deal exists to record it from (then each space's is cutoverOf's). */
  let dealsFrom: MonthId | null = givenDealsFrom === null ? null : (givenDealsFrom && storedDealsFrom(givenDealsFrom)) || DEALS_FROM_MONTH
  /** A space's cutover: the run's, else (nothing recorded, no deal yet: the job runs this code before the ship) the one
   *  the first deal would record if made now. A late ship then keeps the month in progress's stakes in the pushes too. */
  const cutoverOf = (space: Space): MonthId => dealsFrom ?? dealsFromAt(space, nowMs)
  /** Deal period loads this run may still make, across all spaces. */
  let dealLoadsLeft = DEAL_LOADS_PER_RUN
  const deviceCache = new Map<UID, Promise<Device[]>>()
  const profiles: PlanInput['profiles'] = {}
  /** Month results docs this run may still write, across all spaces. */
  let resultsLeft = RESULTS_PER_RUN
  /** Score months this run may still load, across all spaces. */
  let scoresLeft = SCORES_PER_RUN
  /** Whether users/{uid} exists, read at most once per run (with the name the planner uses, into `profiles`). */
  const hasProfile = new Map<UID, boolean>()
  /** scores/{uid}.months as this run last read or wrote them: later spaces build on the same copy. */
  const scoresCache = new Map<UID, ScoreMonths>()
  /** Uids without a profile whose batch-3 docs this run already deleted. */
  const cleaned = new Set<UID>()

  // Every read goes through these, so the summary can say what a run cost.
  const readDoc = async (ref: DocumentReference): Promise<DocumentSnapshot> => {
    summary.reads += 1
    return ref.get()
  }
  const readAll = async (refs: DocumentReference[]): Promise<DocumentSnapshot[]> => {
    if (refs.length === 0) return []
    summary.reads += refs.length
    return db.getAll(...refs)
  }
  const readQuery = async (query: Query) => {
    const snap = await query.get()
    summary.reads += Math.max(1, snap.size)
    return snap
  }

  const devicesOf = (uid: UID): Promise<Device[]> => {
    let pending = deviceCache.get(uid)
    if (!pending) {
      pending = readQuery(db.collection(`users/${uid}/push`)).then((snap) => pickDevices(snap.docs.map((doc) => ({ ref: doc.ref, data: doc.data() }))))
      deviceCache.set(uid, pending)
    }
    return pending
  }

  const loadProfiles = async (uids: UID[]) => {
    const missing = uids.filter((uid) => !(uid in profiles))
    if (missing.length === 0) return
    const snaps = await readAll(missing.map((uid) => db.doc(`users/${uid}`)))
    for (const snap of snaps) {
      profiles[snap.id] = { name: str(snap.get('name')) }
      hasProfile.set(snap.id, snap.exists)
    }
  }

  /** Whether each of `uids` has a profile: users/{uid} read once per run, its name kept for the planner. */
  const knowProfiles = async (uids: UID[]) => {
    const missing = uids.filter((uid) => !hasProfile.has(uid))
    if (missing.length === 0) return
    const snaps = await readAll(missing.map((uid) => db.doc(`users/${uid}`)))
    for (const snap of snaps) {
      hasProfile.set(snap.id, snap.exists)
      if (!(snap.id in profiles)) profiles[snap.id] = { name: str(snap.get('name')) }
    }
  }

  const deliver = async (reminder: Reminder) => {
    const devices = await devicesOf(reminder.uid)
    // Left unclaimed: if they turn reminders on later in the window, they still get it.
    if (devices.length === 0) return
    const keys = reminder.parts ?? [reminder.key]
    if (dryRun) {
      log(`[dry run] ${keys.join(' + ')} → ${devices.length} device(s): ${reminder.title} · ${reminder.body}`)
      summary.sent++
      return
    }
    const record = { kind: reminder.kind, spaceId: reminder.spaceId, uid: reminder.uid, title: reminder.title, ...(reminder.goalId ? { goalId: reminder.goalId } : {}) }
    if (!(await claim(db, keys[0], record))) return
    // A push that carries two parts (a week and its month's list) logs both, so neither goes out again.
    const claimed = [keys[0]]
    for (const key of keys.slice(1)) if (await claim(db, key, { ...record, part: true })) claimed.push(key)

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
    // Nothing got through for a temporary reason: release the claims so the next run retries.
    else if (failed > 0) for (const key of claimed) await logRef(db, key).delete()
  }

  // ----- Deals (SPEC §12.11): each space's two deal queries, read at most once per run (the cutover's recording may
  // read them before the space's turn), and the deals this run changed, so its pushes see them.
  const dealQueries = new Map<string, { open?: Promise<Deal[]>; recent?: Promise<Deal[]> }>()
  const dealChanges = new Map<string, Map<string, Deal>>()
  const decodeDeals = (spaceId: string, docs: DocumentSnapshot[]): Deal[] =>
    docs.flatMap((d) => {
      const deal = decodeDeal(d.id, d.data(), spaceId, toMs)
      if (!deal) log(`deal ${spaceId}/${d.id} skipped: malformed`)
      return deal ?? []
    })
  const queriesOf = (spaceId: string) => {
    let q = dealQueries.get(spaceId)
    if (!q) dealQueries.set(spaceId, (q = {}))
    return q
  }
  const changesOf = (spaceId: string) => dealChanges.get(spaceId) ?? new Map<string, Deal>()
  /** `deals where ended == null` (one query), with this run's changes: a deal it ended is no longer open. */
  const dealsOpen = async (spaceId: string): Promise<Deal[]> => {
    const q = queriesOf(spaceId)
    q.open ??= readQuery(db.collection(`spaces/${spaceId}/deals`).where('ended', '==', null)).then((snap) => decodeDeals(spaceId, snap.docs))
    const changed = changesOf(spaceId)
    return (await q.open).map((d) => changed.get(d.id) ?? d).filter((d) => d.ended === null)
  }
  /** `deals where ended.at >= now − 3 days` (one query), plus the ends this run wrote (or, dry, would have). */
  const dealsRecent = async (spaceId: string): Promise<Deal[]> => {
    const q = queriesOf(spaceId)
    q.recent ??= readQuery(db.collection(`spaces/${spaceId}/deals`).where('ended.at', '>=', Timestamp.fromMillis(nowMs - DEAL_RECENT_MS))).then((snap) =>
      decodeDeals(spaceId, snap.docs),
    )
    const recent = await q.recent
    const ids = new Set(recent.map((d) => d.id))
    return [...recent, ...[...changesOf(spaceId).values()].filter((d) => d.ended !== null && !ids.has(d.id))]
  }
  const dealChanged = (deal: Deal) => {
    const changed = dealChanges.get(deal.spaceId) ?? new Map<string, Deal>()
    changed.set(deal.id, deal)
    dealChanges.set(deal.spaceId, changed)
  }

  /** One space's reads, each made at most once per run: week docs and monthly lists (with their plans, progress
   *  and reviews when needed), results and freeze docs, and the stakes docs. */
  const makeLoader = (spaceId: string) => {
    const docs = new Map<string, Promise<DocumentSnapshot>>()
    const full = new Map<string, Promise<{ period: Week | null; plans: Record<UID, Plan>; progress: Record<UID, Progress>; reviews: Review[] }>>()
    const results = new Map<MonthId, Promise<MonthResults | null>>()
    const frozen = new Map<MonthId, Promise<FrozenStakes | null>>()
    let allStakes: Promise<Record<UID, MemberStakes>> | null = null
    let recentStakes: Promise<Record<UID, MemberStakes>> | null = null
    const ref = (coll: 'weeks' | 'monthly', id: string) => db.doc(`spaces/${spaceId}/${coll}/${id}`)
    const once = <K, V>(map: Map<K, Promise<V>>, key: K, load: () => Promise<V>): Promise<V> => {
      let pending = map.get(key)
      if (!pending) {
        pending = load()
        map.set(key, pending)
      }
      return pending
    }
    const doc = (coll: 'weeks' | 'monthly', id: string) => once(docs, `${coll}/${id}`, () => readDoc(ref(coll, id)))
    const period = async (coll: 'weeks' | 'monthly', id: string): Promise<Week | null> => {
      const d = (await doc(coll, id)).data()
      return d ? toPeriod(spaceId, id, d) : null
    }
    const whole = (coll: 'weeks' | 'monthly', id: string) =>
      once(full, `${coll}/${id}`, async () => {
        const snap = await doc(coll, id)
        const d = snap.data()
        const out = { period: null as Week | null, plans: {} as Record<UID, Plan>, progress: {} as Record<UID, Progress>, reviews: [] as Review[] }
        // Plans, progress and reviews can't exist without the period doc (see firestore.rules).
        if (!d) return out
        out.period = toPeriod(spaceId, id, d)
        const [plans, progress, reviews] = await Promise.all(['plans', 'progress', 'reviews'].map((name) => readQuery(snap.ref.collection(name))))
        for (const p of plans.docs) out.plans[p.id] = toPlan(p)
        for (const p of progress.docs) out.progress[p.id] = toProgress(p)
        out.reviews = reviews.docs.map(toReview)
        return out
      })
    const stakesOf = (snaps: DocumentSnapshot[]) => Object.fromEntries(snaps.map((s) => [s.id, decodeMemberStakes(s.id, s.data(), toMs)]))
    return {
      /** A doc read before (the preload), so later loads reuse it. */
      seed(coll: 'weeks' | 'monthly', id: string, snap: DocumentSnapshot) {
        docs.set(`${coll}/${id}`, Promise.resolve(snap))
      },
      period,
      async week(weekId: WeekId): Promise<WeekData> {
        const p = await whole('weeks', weekId)
        return { spaceId, weekId, week: p.period, plans: p.plans, progress: p.progress, reviews: p.reviews }
      },
      async monthly(monthId: MonthId): Promise<MonthlyData> {
        const p = await whole('monthly', monthId)
        return { spaceId, monthId, monthly: p.period, plans: p.plans, progress: p.progress, reviews: p.reviews }
      },
      /** Just the week doc (a pause request needs only who is in the week), or everything if already loaded. */
      async weekDoc(weekId: WeekId): Promise<[WeekData, WeekLoad]> {
        if (full.has(`weeks/${weekId}`)) return [await this.week(weekId), 'full']
        return [{ spaceId, weekId, week: await period('weeks', weekId), plans: {}, progress: {}, reviews: [] }, 'doc']
      },
      /**
       * What the midweek nudges need, and only for `uids` (those still waiting for one, with a device): the week
       * doc, their plans if they play in it (judges have no list), and the progress of those with tasks. Everyone
       * else reads as having no tasks, which the planner never treats as final. No reviews: there are none before
       * reviews open. A week already loaded whole serves as it is.
       */
      async nudgeWeek(weekId: WeekId, uids: UID[]): Promise<[WeekData, WeekLoad]> {
        if (full.has(`weeks/${weekId}`)) return [await this.week(weekId), 'full']
        const data: WeekData = { spaceId, weekId, week: null, plans: {}, progress: {}, reviews: [] }
        const snap = await doc('weeks', weekId)
        const d = snap.data()
        if (!d) return [data, 'nudge']
        const week = toPeriod(spaceId, weekId, d)
        data.week = week
        const judges = judgesOf(week)
        const players = uids.filter((uid) => week.members.includes(uid) && !judges.includes(uid))
        for (const p of await readAll(players.map((uid) => snap.ref.collection('plans').doc(uid)))) if (p.exists) data.plans[p.id] = toPlan(p)
        const withTasks = players.filter((uid) => (data.plans[uid]?.tasks.length ?? 0) > 0)
        for (const p of await readAll(withTasks.map((uid) => snap.ref.collection('progress').doc(uid)))) if (p.exists) data.progress[p.id] = toProgress(p)
        return [data, 'nudge']
      },
      results(monthId: MonthId): Promise<MonthResults | null> {
        return once(results, monthId, async () => {
          const snap = await readDoc(db.doc(`spaces/${spaceId}/results/${monthId}`))
          return snap.exists ? decodeMonthResults(snap.data(), toMs, monthId) : null
        })
      },
      /** A results doc this run wrote (or, dry, would have). */
      setResults(monthId: MonthId, doc: MonthResults) {
        results.set(monthId, Promise.resolve(doc))
      },
      frozen(monthId: MonthId): Promise<FrozenStakes | null> {
        return once(frozen, monthId, async () => toFrozen(await readDoc(db.doc(`spaces/${spaceId}/months/${monthId}`))))
      },
      setFrozen(monthId: MonthId, value: FrozenStakes) {
        frozen.set(monthId, Promise.resolve(value))
      },
      /** Every member's stakes doc (≤ 8): the verdict's and the results writer's terms. */
      stakesAll(): Promise<Record<UID, MemberStakes>> {
        allStakes ??= readQuery(db.collection(`spaces/${spaceId}/stakes`)).then((snap) => stakesOf(snap.docs))
        return allStakes
      },
      /** Whether a week or a list was already loaded whole this run (a deal's period load is then free). */
      hasWhole(coll: 'weeks' | 'monthly', id: string): boolean {
        return full.has(`${coll}/${id}`)
      },
      /** Every week doc and list read so far this run (no new reads): their stored bounds make a deal's clock. */
      async known(): Promise<{ weeks: Record<WeekId, Week>; lists: Record<MonthId, MonthlyList> }> {
        const out: { weeks: Record<WeekId, Week>; lists: Record<MonthId, MonthlyList> } = { weeks: {}, lists: {} }
        for (const [path, pending] of docs) {
          const d = (await pending.catch(() => null))?.data()
          if (!d) continue
          const [coll, id] = path.split('/')
          if (coll === 'weeks') out.weeks[id] = toPeriod(spaceId, id, d)
          else out.lists[id] = toPeriod(spaceId, id, d)
        }
        return out
      },
      dealsOpen: () => dealsOpen(spaceId),
      dealsRecent: () => dealsRecent(spaceId),
      /** The stakes changed in the last 7 days (one query), for the `stakes` push; all of them if already read. */
      stakesRecent(): Promise<Record<UID, MemberStakes>> {
        if (allStakes) return allStakes
        recentStakes ??= readQuery(
          db.collection(`spaces/${spaceId}/stakes`).where('updatedAt', '>', Timestamp.fromMillis(nowMs - STAKES_RECENT_MS)),
        ).then((snap) => stakesOf(snap.docs))
        return recentStakes
      },
    }
  }
  type Loader = ReturnType<typeof makeLoader>

  /**
   * Freezes a complete month's house stakes if nothing binding holds them yet (SPEC §9.7, §9.11): missing, or the
   * previous app's early freeze from FIRST_RESULTS_MONTH on. A transaction re-reads the doc, so a member's own
   * freeze that landed meanwhile wins. Gives the month's house stakes.
   */
  const freezeMonth = async (space: Space, load: Loader, monthId: MonthId, completeAt: number): Promise<House> => {
    const frozen = await load.frozen(monthId)
    if (frozen && freezeBinds(monthId, frozen, completeAt)) return { reward: frozen.reward, penalty: frozen.penalty }
    const house: House = { reward: space.reward, penalty: space.penalty }
    if (dryRun) {
      log(`[dry run] would freeze spaces/${space.id}/months/${monthId}: ${JSON.stringify(house)}`)
      return house
    }
    const ref = db.doc(`spaces/${space.id}/months/${monthId}`)
    const kept = await db.runTransaction(async (tx) => {
      summary.reads += 1
      const again = toFrozen(await tx.get(ref))
      if (again && freezeBinds(monthId, again, completeAt)) return again
      // Stamped with the run's own clock, which just found the month complete (the same as the server's in
      // production; under REMINDERS_NOW in the emulator it keeps the freeze consistent with the faked time).
      tx.set(ref, { ...house, createdAt: Timestamp.fromMillis(nowMs) })
      return null
    })
    if (kept) return { reward: kept.reward, penalty: kept.penalty }
    load.setFrozen(monthId, { ...house, createdAt: nowMs })
    return house
  }

  /**
   * One month's results doc (SPEC §9.8), once the month is complete by its stored deadlines: null (and nothing
   * written) while it isn't. Freezes its house stakes first when nothing binding holds them, then takes the terms
   * from the agreements made before it was complete, and the streaks and tier runs from `prev`.
   */
  const writeResults = async (space: Space, load: Loader, monthId: MonthId, prev: MonthResults | null): Promise<MonthResults | null> => {
    const weekIds = weekIdsInMonth(monthId)
    const last = weekIds[weekIds.length - 1]
    // Two reads say whether it is complete; only then is the whole month loaded.
    const [lastWeek, list] = await Promise.all([load.period('weeks', last), load.period('monthly', monthId)])
    const completeAt = monthEndsAtFor(space, monthId, lastWeek, list)
    if (nowMs < completeAt) return null
    const weeks = await Promise.all(weekIds.map((id) => load.week(id)))
    const monthly = await load.monthly(monthId)
    const stakes = await load.stakesAll()
    const month = computeMonth(space, monthId, weeks, nowMs, monthly)
    const house = await freezeMonth(space, load, monthId, completeAt)
    const firstLockAt = boundsFor(space, weekIds[0], weeks[0].week).lockAt
    const terms = monthTerms(space, monthId, month, stakes, house, { completeAt, firstLockAt }, null)
    const built = buildMonthResults(monthId, completeAt, month, prev, terms)
    const doc: MonthResults = { ...built, createdAt: nowMs }
    resultsLeft -= 1
    summary.results += 1
    if (dryRun) {
      log(`[dry run] would write spaces/${space.id}/results/${monthId}: ${JSON.stringify(built.members)}`)
      load.setResults(monthId, doc)
      return doc
    }
    const ref = db.doc(`spaces/${space.id}/results/${monthId}`)
    try {
      await ref.create(resultsData(built))
      log(`results ${monthId} written for space ${space.id}`)
    } catch (e) {
      if (errorCode(e) !== ALREADY_EXISTS) throw e
      // Another run won: go on from its doc.
      summary.results -= 1
      const theirs = decodeMonthResults((await readDoc(ref)).data(), toMs, monthId)
      if (theirs) {
        load.setResults(monthId, theirs)
        return theirs
      }
    }
    load.setResults(monthId, doc)
    return doc
  }

  /**
   * The results writer (SPEC §9.11), before the windows: the newest month to look at (resultsTarget), nothing before
   * the space's first month or FIRST_RESULTS_MONTH; if its doc is missing, the months back to the newest one with a
   * doc are written oldest first, at most RESULTS_PER_SPACE per space and RESULTS_PER_RUN per run, stopping at the
   * first month that isn't complete yet.
   */
  const ensureResults = async (space: Space, load: Loader, stored: Record<WeekId, Week>) => {
    const first = firstMonthOf(space)
    const floor = first && first > FIRST_RESULTS_MONTH ? first : FIRST_RESULTS_MONTH
    const target = resultsTarget(space, nowMs, { weeks: stored })
    if (target < floor || resultsLeft <= 0) return
    if (await load.results(target)) return
    const chain: MonthId[] = [target]
    let prev: MonthResults | null = null
    for (let month = addMonths(target, -1); month >= floor; month = addMonths(month, -1)) {
      if (chain.length > MAX_RESULTS_WALK) {
        log(`space ${space.id}: no month results found within ${MAX_RESULTS_WALK} months of ${target}; not writing any`)
        return
      }
      prev = await load.results(month)
      if (prev) break
      chain.unshift(month)
    }
    let written = 0
    for (const monthId of chain) {
      if (written >= RESULTS_PER_SPACE || resultsLeft <= 0) break
      const doc = await writeResults(space, load, monthId, prev)
      // A month that isn't complete yet: the later ones aren't either.
      if (!doc) break
      prev = doc
      written += 1
    }
  }

  /** Writes each uid's new entries into their scores doc and publishes their ring and stats (one batch per space). A
   *  uid without a profile gets its three docs deleted instead (once per run). */
  const writeScores = async (space: Space, months: { monthId: MonthId; entries: Record<UID, ScoreEntry> }[]) => {
    const uids = [...new Set(months.flatMap((m) => Object.keys(m.entries)))].sort()
    if (uids.length === 0) return
    await knowProfiles(uids)
    const gone = uids.filter((uid) => hasProfile.get(uid) !== true && !cleaned.has(uid))
    const live = uids.filter((uid) => hasProfile.get(uid) === true)
    const fresh = live.filter((uid) => !scoresCache.has(uid))
    for (const snap of await readAll(fresh.map((uid) => db.doc(`scores/${uid}`)))) scoresCache.set(snap.id, decodeScores(snap.data(), toMs))
    const batch = db.batch()
    for (const uid of gone) {
      cleaned.add(uid)
      summary.cleaned += 1
      for (const coll of ['scores', 'rings', 'stats']) batch.delete(db.doc(`${coll}/${uid}`))
    }
    for (const uid of live) {
      const all: ScoreMonths = { ...scoresCache.get(uid) }
      for (const { monthId, entries } of months) if (uid in entries) all[monthId] = { ...all[monthId], [space.id]: entries[uid] }
      scoresCache.set(uid, all)
      const ring = ringOf(all)
      const stats = statsOf(all)
      summary.rings += 1
      summary.stats += 1
      if (dryRun) {
        log(`[dry run] would write scores, ring and stats of ${uid} for space ${space.id}: ${JSON.stringify(ring)} ${JSON.stringify(stats)}`)
        continue
      }
      const updatedAt = FieldValue.serverTimestamp()
      batch.set(db.doc(`scores/${uid}`), { months: all, updatedAt })
      batch.set(db.doc(`rings/${uid}`), { ...ring, updatedAt })
      batch.set(db.doc(`stats/${uid}`), { ...stats, updatedAt })
    }
    if (dryRun) {
      if (gone.length > 0) log(`[dry run] would delete the scores, ring and stats of ${gone.join(', ')} (no profile)`)
      return
    }
    await batch.commit()
  }

  /**
   * The scores writer (SPEC §11.10), after the results writer: once a week's deadline has passed (W, M = its month), the
   * space's month so far goes into each player's scores doc, and their ring and stats are published from it. The
   * marker `${space}_${W}_scores` makes it once per week; when M is complete (and when the previous month P, complete,
   * has no `${space}_${P}_stats` marker yet: a month whose end the job missed) the entries are final. At most
   * SCORES_PER_SPACE month loads per space and SCORES_PER_RUN per run; a space that can't have all it needs waits for
   * the next run. Writes nothing but scores, rings, stats and its markers.
   */
  const ensureScores = async (space: Space, load: Loader, stored: Record<WeekId, Week>) => {
    const target = scoresTarget(space, nowMs, { weeks: stored })
    if (!target || scoresLeft <= 0) return
    const { weekId, monthId, floor } = target
    if ((await readDoc(logRef(db, scoresKey(space.id, weekId)))).exists) return
    // Its stored deadline decides (a change of times can make it later than computed); the month load reuses the doc.
    if (nowMs < boundsFor(space, weekId, await load.period('weeks', weekId)).deadlineAt) return
    const prev = addMonths(monthId, -1)
    let withPrev = false
    if (prev >= floor && !(await readDoc(logRef(db, statsKey(space.id, prev)))).exists) {
      const ids = weekIdsInMonth(prev)
      const [lastWeek, list] = await Promise.all([load.period('weeks', ids[ids.length - 1]), load.period('monthly', prev)])
      withPrev = nowMs >= monthEndsAtFor(space, prev, lastWeek, list)
    }
    const loads = withPrev ? 2 : 1
    if (loads > Math.min(SCORES_PER_SPACE, scoresLeft)) return
    scoresLeft -= loads

    // M so far: its weeks up to W (later ones haven't closed), and its list once W is its last week.
    const all = weekIdsInMonth(monthId)
    const ids = all.filter((id) => id <= weekId)
    const isLast = ids[ids.length - 1] === all[all.length - 1]
    const weeks = await Promise.all(ids.map((id) => load.week(id)))
    const monthly = isLast ? await load.monthly(monthId) : undefined
    const complete = isLast && nowMs >= monthEndsAt(space, monthId, weeks, monthly)
    const months = [{ monthId, entries: scoreEntries(computeMonth(space, monthId, weeks, nowMs, monthly)) }]
    if (withPrev) {
      const prevWeeks = await Promise.all(weekIdsInMonth(prev).map((id) => load.week(id)))
      const entries = scoreEntries(computeMonth(space, prev, prevWeeks, nowMs, await load.monthly(prev)))
      // Complete: every entry is final, whatever the rest of the doc says.
      for (const entry of Object.values(entries)) entry.final = true
      months.unshift({ monthId: prev, entries })
    }
    await writeScores(space, months)

    // A dry run leaves the markers unclaimed (and doesn't log them: they are bookkeeping, not content).
    if (dryRun) return
    const markers = [scoresKey(space.id, weekId), ...(complete ? [statsKey(space.id, monthId)] : []), ...(withPrev ? [statsKey(space.id, prev)] : [])]
    for (const key of markers) await claim(db, key, { kind: 'scores', spaceId: space.id })
  }

  // ---------- Deals (SPEC §12.11) ----------

  /** One finished period of a weeks deal for its person: null while its stored deadline (computed without a doc)
   *  is ahead, or when the loads are used up for this space and run. */
  const weekPeriod = async (space: Space, load: Loader, deal: Deal, weekId: WeekId, loads: { left: number }): Promise<DealPeriod | null> => {
    const doc = await load.period('weeks', weekId)
    if (nowMs < boundsFor(space, weekId, doc).deadlineAt) return null
    if (!doc) return weekDealPeriod(space, deal.uid, { spaceId: space.id, weekId, week: null, plans: {}, progress: {}, reviews: [] }, nowMs)
    if (!load.hasWhole('weeks', weekId)) {
      if (loads.left <= 0 || dealLoadsLeft <= 0) return null
      loads.left -= 1
      dealLoadsLeft -= 1
    }
    return weekDealPeriod(space, deal.uid, await load.week(weekId), nowMs)
  }

  /** One finished month of a months deal: null until it is complete by its stored deadlines (two reads, shared with
   *  the results writer), or when the loads are used up. A month and its list are one load. */
  const monthPeriod = async (space: Space, load: Loader, deal: Deal, monthId: MonthId, loads: { left: number }): Promise<DealPeriod | null> => {
    const weekIds = weekIdsInMonth(monthId)
    const [lastWeek, list] = await Promise.all([load.period('weeks', weekIds[weekIds.length - 1]), load.period('monthly', monthId)])
    if (nowMs < monthEndsAtFor(space, monthId, lastWeek, list)) return null
    if (!weekIds.every((id) => load.hasWhole('weeks', id)) || !load.hasWhole('monthly', monthId)) {
      if (loads.left <= 0 || dealLoadsLeft <= 0) return null
      loads.left -= 1
      dealLoadsLeft -= 1
    }
    const weeks = await Promise.all(weekIds.map((id) => load.week(id)))
    const monthly = await load.monthly(monthId)
    // monthDealPeriod can't tell a month without a result is complete: only complete months get here.
    if (nowMs < monthEndsAt(space, monthId, weeks, monthly)) return null
    return monthDealPeriod(deal.uid, computeMonth(space, monthId, weeks, nowMs, monthly)[deal.uid], weeks)
  }

  /** A track entry or an end as stored: no undefined values, times as Timestamps. */
  const periodData = (e: DealPeriod): Record<string, unknown> => ({
    id: e.id,
    result: e.result,
    score: e.score,
    ...(e.missed !== undefined ? { missed: e.missed } : {}),
    ...(e.why !== undefined ? { why: e.why } : {}),
  })
  const endData = (end: DealEnd): Record<string, unknown> => ({
    outcome: end.outcome,
    at: Timestamp.fromMillis(end.at),
    ...(end.by !== undefined ? { by: end.by } : {}),
    ...(end.period !== undefined ? { period: end.period } : {}),
    ...(end.score !== undefined ? { score: end.score } : {}),
    ...(end.reason !== undefined ? { reason: end.reason } : {}),
  })

  /**
   * What the job writes to a deal now (SPEC §12.11 step 2 and 4), from `deal` as stored and the periods it loaded
   * (`extra`): a waiting deal whose person is no longer a member is withdrawn for them (at their leftAt); a fully agreed
   * one gets its missing `agreedAt`/`start` stamps, the track entries after its stored track and, when the walk
   * determines it, its end; with `checkedAt` beside them. null when nothing changes. Also the deal as it would read.
   */
  const dealPatch = (space: Space, deal: Deal, rawTrack: unknown, extra: DealPeriod[], clock: ReturnType<typeof dealClock>): { patch: Record<string, unknown>; next: Deal } | null => {
    if (deal.ended) return null
    const state = dealState(deal, space, nowMs, clock, extra)
    if (state.phase === 'waiting') {
      if (space.memberIds.includes(deal.uid)) return null
      const end: DealEnd = { outcome: 'withdrawn', at: space.leftAt?.[deal.uid] ?? nowMs, by: deal.uid }
      return { patch: { ended: endData(end), checkedAt: Timestamp.fromMillis(nowMs) }, next: { ...deal, ended: end, checkedAt: nowMs } }
    }
    const patch: Record<string, unknown> = {}
    const next: Deal = { ...deal }
    if (deal.agreedAt === undefined && state.agreedAt !== null) {
      patch.agreedAt = Timestamp.fromMillis(state.agreedAt)
      next.agreedAt = state.agreedAt
    }
    if (deal.start === undefined && state.start !== null) {
      patch.start = state.start
      next.start = state.start
    }
    const added = state.track.slice((deal.track ?? []).length)
    if (added.length > 0) {
      // Appended to the track exactly as stored (a concurrent run's entries are kept as they are).
      const stored = rawTrack === undefined ? (deal.track ?? []).map(periodData) : Array.isArray(rawTrack) ? rawTrack : []
      patch.track = [...stored, ...added.map(periodData)]
      next.track = state.track
    }
    if (state.provisional && state.end) {
      patch.ended = endData(state.end)
      next.ended = state.end
    }
    if (Object.keys(patch).length === 0) return null
    patch.checkedAt = Timestamp.fromMillis(nowMs)
    next.checkedAt = nowMs
    return { patch, next }
  }

  /** Writes a deal's patch in a transaction that re-reads it and decides again on the stored doc (an end or a
   *  concurrent run's entries that landed meanwhile win); nothing when nothing changes then. */
  const writeDeal = async (space: Space, deal: Deal, extra: DealPeriod[], clock: ReturnType<typeof dealClock>, rawTrack: unknown) => {
    const planned = dealPatch(space, deal, rawTrack, extra, clock)
    if (!planned) return
    const ref = db.doc(`spaces/${space.id}/deals/${deal.id}`)
    const count = (next: Deal, patch: Record<string, unknown>) => {
      summary.deals += 1
      const outcome = next.ended?.outcome
      if (patch.ended && outcome && outcome !== 'withdrawn') summary.dealsEnded += 1
      dealChanged(next)
    }
    if (dryRun) {
      log(`[dry run] would update spaces/${space.id}/deals/${deal.id}: ${JSON.stringify(planned.patch)}`)
      count(planned.next, planned.patch)
      return
    }
    const done = await db.runTransaction(async (tx) => {
      summary.reads += 1
      const snap = await tx.get(ref)
      const fresh = snap.exists ? decodeDeal(snap.id, snap.data(), space.id, toMs) : null
      const again = fresh ? dealPatch(space, fresh, snap.get('track'), extra, clock) : null
      if (!again) return null
      tx.update(ref, again.patch)
      return again
    })
    if (!done) return
    count(done.next, done.patch)
    if (done.next.ended) log(`deal ${space.id}/${deal.id} ended: ${done.next.ended.outcome}`)
  }

  /**
   * The deal results (SPEC §12.11), only in a space with `hasDeals`: the deals in play (one query); for each, in uid
   * and seq order, the job's withdrawal when it waits and its person left, else, once fully agreed, its stamps, the
   * periods it needs (at most DEAL_LOADS_PER_SPACE loads here, DEAL_LOADS_PER_RUN per run) and its end. Waiting deals
   * cost nothing more. Nothing is deleted.
   */
  const ensureDeals = async (space: Space, load: Loader) => {
    if (!space.hasDeals) return
    const open = [...(await load.dealsOpen())].sort((a, b) => a.uid.localeCompare(b.uid) || a.seq - b.seq)
    const loads = { left: DEAL_LOADS_PER_SPACE }
    for (const deal of open) {
      try {
        const before = dealClock(space, deal.unit, await load.known())
        const extra: DealPeriod[] = []
        if (dealState(deal, space, nowMs, before).phase !== 'waiting') {
          // dealPeriodsToLoad assumes each unknown period passes: after skips, ask again (within the load caps).
          let open = true
          for (let round = 0; open && round < 24; round++) {
            const known = { ...deal, track: [...(deal.track ?? []), ...extra] }
            const ids = dealPeriodsToLoad(known, space, nowMs, before)
            if (ids.length === 0) break
            for (const id of ids) {
              const period = deal.unit === 'week' ? await weekPeriod(space, load, deal, id, loads) : await monthPeriod(space, load, deal, id, loads)
              // Not final yet by its stored deadline, or no loads left: the rest waits for the next run.
              if (!period) {
                open = false
                break
              }
              extra.push(period)
              // Nothing after a miss counts.
              if (period.result === 'miss') {
                open = false
                break
              }
            }
          }
        }
        // The stored bounds of what was just loaded decide the final times.
        const clock = dealClock(space, deal.unit, await load.known())
        await writeDeal(space, deal, extra, clock, undefined)
      } catch (e) {
        summary.errors++
        log(`deal ${space.id}/${deal.id} failed: ${message(e)}`)
      }
    }
  }

  /**
   * Records the month stakes cutover (SPEC §12.3, §12.11) when main read none: the first space with `hasDeals` (in the
   * loop's order) whose deal queries find a deal gives `dealsFromAt(space, earliest createdAt)`, written to
   * public/config in a transaction only while it has none (another run's value wins and is used). A stray flag
   * without deal docs records nothing (null). Dry run: logged, not written.
   */
  const recordDealsFrom = async (spaces: Space[]): Promise<MonthId | null> => {
    for (const space of spaces) {
      const deals = [...(await dealsOpen(space.id)), ...(await dealsRecent(space.id))]
      if (deals.length === 0) continue
      const month = dealsFromAt(space, Math.min(...deals.map((d) => d.createdAt)))
      if (dryRun) {
        log(`[dry run] would record dealsFrom ${month} in public/config (from space ${space.id})`)
        return month
      }
      const ref = db.doc('public/config')
      const used = await db.runTransaction(async (tx) => {
        summary.reads += 1
        const had = storedDealsFrom((await tx.get(ref)).get('dealsFrom'))
        if (had) return had
        tx.set(ref, { dealsFrom: month, dealsFromAt: Timestamp.fromMillis(nowMs) }, { merge: true })
        return month
      })
      log(`dealsFrom ${used}${used === month ? ' recorded' : ' (recorded by another run)'} from space ${space.id}`)
      return used
    }
    return null
  }

  const runSpace = async (space: Space) => {
    const load = makeLoader(space.id)
    const members = space.memberIds
    // A space everyone has left has nobody to read its results or get its pushes. Its last members' scores still
    // get their month finished, for a while after the last one left.
    if (members.length === 0) {
      const lastLeft = Math.max(0, ...Object.values(space.leftAt ?? {}))
      if (nowMs - lastLeft < EMPTIED_SCORES_MS) {
        await ensureScores(space, load, {}).catch((e: unknown) => {
          summary.errors++
          log(`space ${space.id} scores failed: ${message(e)}`)
        })
        // Its deals still end (their people left: lost, or withdrawn while waiting), as the record (SPEC §12.4).
        await ensureDeals(space, load).catch((e: unknown) => {
          summary.errors++
          log(`space ${space.id} deals failed: ${message(e)}`)
        })
      }
      return
    }
    // After a recent change of times, stored timelines decide the windows: read last, this and next week first.
    const stored: Record<WeekId, Week> = {}
    const note = space.scheduleNote
    if (note && nowMs - note.at < PRELOAD_MS) {
      const thisWeek = weekIdFor(nowMs, space.timezone)
      const ids = [addWeeks(thisWeek, -1), thisWeek, addWeeks(thisWeek, 1)]
      const snaps = await readAll(ids.map((id) => db.doc(`spaces/${space.id}/weeks/${id}`)))
      snaps.forEach((snap, i) => {
        load.seed('weeks', ids[i], snap)
        const d = snap.data()
        if (d) stored[ids[i]] = toPeriod(space.id, ids[i], d)
      })
    }

    // A failure here is logged and counted, but doesn't hold up the space's reminders.
    await ensureResults(space, load, stored).catch((e: unknown) => {
      summary.errors++
      log(`space ${space.id} results failed: ${message(e)}`)
    })
    // The same for the scores writer (batch 3), which sends nothing either.
    await ensureScores(space, load, stored).catch((e: unknown) => {
      summary.errors++
      log(`space ${space.id} scores failed: ${message(e)}`)
    })
    // Deal results (SPEC §12.11), night runs included; only with `hasDeals` (else no read at all).
    await ensureDeals(space, load).catch((e: unknown) => {
      summary.errors++
      log(`space ${space.id} deals failed: ${message(e)}`)
    })

    // Nothing is sent between 00:00 and 08:00 local: the windows stay open for a later run.
    if (isMuted(space, nowMs)) return
    const windows = dueWindows(space, nowMs, { weeks: stored })
    const stakesOpen = stakesWindow(space, nowMs) !== null
    // The deal pushes, only in a space with deals, during its 09:00–21:00.
    const dealsOpen = space.hasDeals === true && dealHours(space, nowMs)
    if (windows.length === 0 && !stakesOpen && !dealsOpen) return
    summary.windows += windows.length + (stakesOpen ? 1 : 0) + (dealsOpen ? 1 : 0)

    // The sent log for every key these windows decide; `stakes` keys depend on the stakes docs, deal keys on the deals.
    const recentStakes = stakesOpen ? await load.stakesRecent() : undefined
    const candidates = recentStakes ? stakesCandidates(space, recentStakes, nowMs, cutoverOf(space)) : []
    const deals = dealsOpen ? { open: await load.dealsOpen(), recent: await load.dealsRecent() } : undefined
    const dealPushes = deals ? dealCandidates(space, deals.open, deals.recent, nowMs) : []
    const read = new Set<string>()
    const sent = new Set<string>()
    const readSent = async (keys: string[]) => {
      const fresh = [...new Set(keys)].filter((key) => !read.has(key))
      for (const key of fresh) read.add(key)
      for (const snap of await readAll(fresh.map((key) => logRef(db, key)))) if (snap.exists) sent.add(snap.id)
    }
    const keysOf = (window: DueWindow, uid: UID) => windowKeys(space.id, window, uid)
    await readSent([...windows.flatMap((w) => members.flatMap((uid) => keysOf(w, uid))), ...candidates.map((c) => c.key), ...dealPushes.map((c) => c.key)])

    // Load a window's data only if someone with a device is still waiting for it; for a nudge, only what those
    // people need.
    const reachable = async (uids: UID[]) => {
      const devices = await Promise.all(uids.map(devicesOf))
      return uids.filter((_, i) => devices[i].length > 0)
    }
    const need = new Map<WeekId, WeekLoad>()
    const nudged = new Map<WeekId, Set<UID>>()
    const lists = new Set<MonthId>()
    let verdict: MonthId | null = null
    let named = false
    for (const window of windows) {
      const waiting = await reachable(members.filter((uid) => keysOf(window, uid).some((key) => !sent.has(key))))
      if (waiting.length === 0) continue
      const kind = weekLoad(window.kind)
      for (const id of window.weekIds) {
        const had = need.get(id)
        if (!had || LOAD_RANK[kind] > LOAD_RANK[had]) need.set(id, kind)
        if (kind === 'nudge') nudged.set(id, new Set([...(nudged.get(id) ?? []), ...waiting]))
      }
      for (const monthId of window.monthIds ?? []) lists.add(monthId)
      if (window.kind === 'verdict') verdict = window.period
      if (!isNudge(window.kind)) named = true
    }
    const stakesWaiting = (await reachable([...new Set(candidates.filter((c) => !sent.has(c.key)).map((c) => c.friend))])).length > 0
    const dealsDue = dealPushes.filter((c) => !c.final && !sent.has(c.key))
    const dealsWaiting = (await reachable([...new Set(dealsDue.map((c) => c.to))])).length > 0
    // Finals to log (a friend who agreed, a deal that no longer waits), so later runs don't decide them again.
    const dealFinals = dealPushes.some((c) => c.final && !sent.has(c.key))
    if (need.size === 0 && lists.size === 0 && !named && !stakesWaiting && !dealsWaiting && !dealFinals) return

    const weeks: Record<WeekId, WeekData> = {}
    const loads: Record<WeekId, WeekLoad> = {}
    // Whole weeks first, so a nudge or a pause request on the same week uses them.
    for (const [id, kind] of [...need].sort((a, b) => LOAD_RANK[b[1]] - LOAD_RANK[a[1]])) {
      const [data, got]: [WeekData, WeekLoad] =
        kind === 'full' ? [await load.week(id), 'full'] : kind === 'nudge' ? await load.nudgeWeek(id, [...(nudged.get(id) ?? [])]) : await load.weekDoc(id)
      weeks[id] = data
      loads[id] = got
    }
    const monthly: Record<MonthId, MonthlyData> = {}
    for (const monthId of lists) monthly[monthId] = await load.monthly(monthId)
    const input: SpaceInput = { space, weeks, stored, monthly, loads, dealsFrom: cutoverOf(space) }
    if (deals) input.deals = deals
    if (verdict) {
      const frozen = await load.frozen(verdict)
      if (frozen) input.stakes = { [verdict]: frozen }
      // Written (or found) by ensureResults earlier in this run when it's the month it looked at.
      input.results = { [verdict]: await load.results(verdict) }
      input.memberStakes = await load.stakesAll()
    } else if (stakesWaiting) {
      input.memberStakes = recentStakes
    }

    // Windows that only the loaded docs open (stored times later than computed ones): their keys too.
    const extra = planWindows(input, nowMs).filter((w) => w.kind !== 'stakes' && w.kind !== 'deal' && w.kind !== 'deal-end')
    await readSent(extra.flatMap((w) => members.flatMap((uid) => keysOf(w, uid))))

    // Names for everything but the nudges. Period members too: someone who left after lock is still named as a
    // friend to review.
    if (named || stakesWaiting || dealsWaiting) {
      const periods = [...Object.values(weeks).map((w) => w.week), ...Object.values(monthly).map((m) => m.monthly)]
      // The people of the deals due (their person, their friends: a party who left is still named).
      const dealPeople = dealsDue.flatMap((c) => [c.deal.uid, ...c.deal.friends])
      await loadProfiles([...new Set([...members, ...periods.flatMap((p) => p?.members ?? []), ...dealPeople])])
    }
    const plan = planSpace(input, profiles, sent, nowMs)

    if (!dryRun) {
      for (const key of plan.skipped) {
        if (await claim(db, key, { skipped: true, spaceId: space.id, uid: uidOfKey(key) })) summary.skipped++
      }
    }
    for (const reminder of plan.send) await deliver(reminder)
  }

  /** One goal's `checkin` pushes: the sent log of the members whose window is open now, then the week's check-ins
   *  only if one of those still waiting has a device. */
  const runGoal = async (goal: SharedGoal): Promise<void> => {
    const candidates = checkinCandidates(goal, nowMs)
    if (candidates.length === 0) return
    const sent = new Set<string>()
    for (const s of await readAll(candidates.map((c) => logRef(db, c.key)))) if (s.exists) sent.add(s.id)
    const waiting = candidates.filter((c) => !sent.has(c.key))
    if (waiting.length === 0) return
    const devices = await Promise.all(waiting.map((c) => devicesOf(c.uid)))
    if (!devices.some((d) => d.length > 0)) return
    const week = await readQuery(db.collection(`sharedGoals/${goal.id}/checkins`).where('weekId', '==', candidates[0].weekId))
    const checkins = week.docs.flatMap((d) => decodeCheckin(d.id, d.data(), toMs) ?? [])
    const plan = planShared({ goal, checkins }, sent, nowMs)
    if (!dryRun) {
      for (const key of plan.skipped) {
        if (await claim(db, key, { skipped: true, kind: 'checkin', goalId: goal.id, uid: uidOfKey(key) })) summary.skipped++
      }
    }
    for (const reminder of plan.send) await deliver(reminder)
  }

  /**
   * The `checkin` push (SPEC §11.10): one query for the goals that aren't finished; each goal's windows come from its
   * doc alone, so a goal with no member window open now costs nothing more. Each goal has the spaces' time budget.
   */
  const runGoals = async (): Promise<void> => {
    const snap = await readQuery(db.collection('sharedGoals').where('archivedAt', '==', null))
    for (const doc of snap.docs) {
      if (!isGoalId(doc.id)) {
        log(`goal ${JSON.stringify(doc.id)} skipped: not a goal id`)
        continue
      }
      const goal = decodeSharedGoal(doc.id, doc.data(), toMs)
      if (!goal) {
        log(`goal ${doc.id} skipped: malformed`)
        continue
      }
      summary.goals += 1
      try {
        const outcome = await withTimeout(runGoal(goal).then(() => 'done' as const), spaceBudgetMs, `goal ${goal.id}`).catch((e: unknown) => {
          if (e instanceof Error && e.message.startsWith(`goal ${goal.id} timed out`)) return 'slow' as const
          throw e
        })
        if (outcome === 'slow') log(`goal ${goal.id} skipped: over its ${spaceBudgetMs} ms budget`)
      } catch (e) {
        summary.errors++
        log(`goal ${goal.id} failed: ${message(e)}`)
      }
    }
  }

  const spaces = await readQuery(db.collection('spaces'))
  summary.spaces = spaces.size
  // The month stakes cutover (SPEC §12.3): when main found none recorded, the first deal records it, before any space
  // is planned, so the whole run follows it. Only spaces with `hasDeals` are read for it. With no deal yet (or a failed
  // record, retried next run), each space keeps the cutover the first deal would record now (cutoverOf).
  if (givenDealsFrom === null) {
    const withDeals = spaces.docs.map(toSpace).filter((space) => space.hasDeals === true && IANAZone.isValidZone(space.timezone))
    if (withDeals.length > 0) {
      dealsFrom = await recordDealsFrom(withDeals).catch((e: unknown) => {
        summary.errors++
        log(`recording dealsFrom failed: ${message(e)}`)
        return null
      })
    }
  }
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

  // Batch 3: the shared goals' check-in push, only while some window can be open; a failure costs no space anything.
  if (checkinGateOpen(nowMs)) {
    await runGoals().catch((e: unknown) => {
      summary.errors++
      log(`shared goals failed: ${message(e)}`)
    })
  }
  return summary
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

    // Also the recorded month stakes cutover (SPEC §12.11), from the same read of public/config.
    const vapid = await ensureVapidKeys(db, () => webpush.generateVAPIDKeys())
    // Apple rejects pushes whose VAPID subject isn't a real https: or mailto: contact.
    webpush.setVapidDetails(appUrl, vapid.publicKey, vapid.privateKey)

    const summary = await runReminders({
      db,
      nowMs,
      dryRun,
      dealsFrom: vapid.dealsFrom,
      // web-push's own socket timeout; runReminders also races each send against the same limit.
      send: (sub, payload, options) => webpush.sendNotification(sub, payload, options),
    })
    // The summary includes `reads`: the docs this run read (SPEC §9.11).
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
