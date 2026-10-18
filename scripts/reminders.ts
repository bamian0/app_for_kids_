// Hourly reminders job (run by .github/workflows/reminders.yml). See docs/SPEC.md §4 and §9.11.
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
// tasks. Each run first writes the month results (streaks) of months that are complete (ensureResults), and the
// summary it logs counts every doc it read.
import { pathToFileURL } from 'node:url'
import { cert, deleteApp, initializeApp, type App, type ServiceAccount } from 'firebase-admin/app'
import { FieldValue, getFirestore, Timestamp, type DocumentReference, type DocumentSnapshot, type Firestore, type Query } from 'firebase-admin/firestore'
import { IANAZone } from 'luxon'
import webpush from 'web-push'
import { decodeTasks } from '../src/data/tasks.ts'
import { decodeMemberStakes, decodeMonthResults, decodeSpaceExtras, decodeWeekExtras } from '../src/domain/decode.ts'
import { boundsFor } from '../src/domain/schedule.ts'
import { computeMonth, judgesOf, monthEndsAtFor } from '../src/domain/scoring.ts'
import { buildMonthResults, FIRST_RESULTS_MONTH, freezeBinds, monthTerms, type House } from '../src/domain/stakes.ts'
import { addMonths, addWeeks, firstMonthOf, weekIdFor, weekIdsInMonth } from '../src/domain/time.ts'
import type {
  LineInForce,
  MemberStakes,
  MonthId,
  MonthlyData,
  MonthResults,
  Plan,
  Progress,
  Review,
  ReviewMark,
  Space,
  UID,
  Week,
  WeekData,
  WeekId,
} from '../src/domain/types.ts'
import {
  dueWindows,
  isMuted,
  isNudge,
  offsetToStore,
  planSpace,
  planWindows,
  resultsTarget,
  stakesCandidates,
  stakesWindow,
  weekLoad,
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
  /** Month results docs written (in a dry run: that would have been). */
  results: number
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
    spaces: 0, windows: 0, sent: 0, devices: 0, skipped: 0, expiredSubscriptions: 0, failedDeliveries: 0, skippedSpaces: 0, errors: 0, results: 0, reads: 0,
  }
  const deviceCache = new Map<UID, Promise<Device[]>>()
  const profiles: PlanInput['profiles'] = {}
  /** Month results docs this run may still write, across all spaces. */
  let resultsLeft = RESULTS_PER_RUN

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
    for (const snap of snaps) profiles[snap.id] = { name: str(snap.get('name')) }
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
    const record = { kind: reminder.kind, spaceId: reminder.spaceId, uid: reminder.uid, title: reminder.title }
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

  const runSpace = async (space: Space) => {
    const load = makeLoader(space.id)
    const members = space.memberIds
    // A space everyone has left has nobody to read its results or get its pushes.
    if (members.length === 0) return
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

    // Nothing is sent between 00:00 and 08:00 local: the windows stay open for a later run.
    if (isMuted(space, nowMs)) return
    const windows = dueWindows(space, nowMs, { weeks: stored })
    const stakesOpen = stakesWindow(space, nowMs) !== null
    if (windows.length === 0 && !stakesOpen) return
    summary.windows += windows.length + (stakesOpen ? 1 : 0)

    // The sent log for every key these windows decide; `stakes` keys depend on the stakes docs.
    const recentStakes = stakesOpen ? await load.stakesRecent() : undefined
    const candidates = recentStakes ? stakesCandidates(space, recentStakes, nowMs) : []
    const read = new Set<string>()
    const sent = new Set<string>()
    const readSent = async (keys: string[]) => {
      const fresh = [...new Set(keys)].filter((key) => !read.has(key))
      for (const key of fresh) read.add(key)
      for (const snap of await readAll(fresh.map((key) => logRef(db, key)))) if (snap.exists) sent.add(snap.id)
    }
    const keysOf = (window: DueWindow, uid: UID) => windowKeys(space.id, window, uid)
    await readSent([...windows.flatMap((w) => members.flatMap((uid) => keysOf(w, uid))), ...candidates.map((c) => c.key)])

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
    if (need.size === 0 && lists.size === 0 && !named && !stakesWaiting) return

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
    const input: SpaceInput = { space, weeks, stored, monthly, loads }
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
    const extra = planWindows(input, nowMs).filter((w) => w.kind !== 'stakes')
    await readSent(extra.flatMap((w) => members.flatMap((uid) => keysOf(w, uid))))

    // Names for everything but the nudges. Period members too: someone who left after lock is still named as a
    // friend to review.
    if (named || stakesWaiting) {
      const periods = [...Object.values(weeks).map((w) => w.week), ...Object.values(monthly).map((m) => m.monthly)]
      await loadProfiles([...new Set([...members, ...periods.flatMap((p) => p?.members ?? [])])])
    }
    const plan = planSpace(input, profiles, sent, nowMs)

    if (!dryRun) {
      for (const key of plan.skipped) {
        if (await claim(db, key, { skipped: true, spaceId: space.id, uid: uidOfKey(key) })) summary.skipped++
      }
    }
    for (const reminder of plan.send) await deliver(reminder)
  }

  const spaces = await readQuery(db.collection('spaces'))
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
