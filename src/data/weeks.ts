// Weeks (and, through the same code, monthly lists): participation, live period data (with the blind-review
// reveal) and the week's writes.
import {
  arrayUnion,
  collection,
  deleteField,
  disableNetwork,
  doc,
  enableNetwork,
  getDoc,
  getDocFromCache,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  where,
  writeBatch,
  type DocumentReference,
  type DocumentSnapshot,
  type FieldValue,
  type Transaction,
} from 'firebase/firestore'
import { isCancelled } from '../domain/cancel.ts'
import { now } from '../domain/clock.ts'
import { isReviewMark } from '../domain/decode.ts'
import { MAX_SUBTASKS, newTaskId, reviewDocId } from '../domain/ids.ts'
import { earningId } from '../domain/money.ts'
import { boundsFor, isUsualSchedule, needsRetime, RETIME_NOTICE_MS, sameSchedule, scheduleOf } from '../domain/schedule.ts'
import { isRevealed, isTaskDone, joinedAfterLock, judgesOf } from '../domain/scoring.ts'
import { boundsDiffer, weekBounds, type WeekBounds } from '../domain/time.ts'
import type { Plan, Progress, Review, ReviewMark, Space, Task, UID, Week, WeekData, WeekId, WeekSchedule } from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import { toMonthly, toPlan, toProgress, toReview, toSpace, toWeek } from './convert.ts'
import { CROSSED_OUT_TICK, errorCode, humanError, isDenied, MSG } from './errors.ts'
import { earnedAtChange, earningRef, inBackground, keepsEarned, knownEarning, settleEarning, syncPlanEarnings } from './money.ts'
import { requireUser } from './session.ts'
import { peek, type Emit, type Start } from './store.ts'
import { encodeTask, oneLine, TASK_ID } from './tasks.ts'

export const MAX_TASKS = 25
/** Keys a progress doc may hold (the rules' cap): 25 tasks × 8 steps. */
const MAX_TICKS = 200
/** Rules compare against server time; give the server a moment past deadlineAt before asking for everyone's reviews. */
const REVEAL_GRACE_MS = 1_500
/** After a denied full read (client clock ahead of the server), wait this long before trying again. */
const REVEAL_RETRY_MS = 10_000
const MAX_TIMEOUT_MS = 2_147_483_647
const RESTART_MIN_INTERVAL_MS = 30_000

let restarting: Promise<void> | null = null
let lastRestartAt = 0

function canRestartStreams(): boolean {
  return restarting !== null || Date.now() - lastRestartAt >= RESTART_MIN_INTERVAL_MS
}

/**
 * Reopens Firestore's streams. The emulator evaluates a new listen target with the time its watch
 * stream opened, so on a stream opened before deadlineAt the time-based reveal stays denied; a fresh
 * stream fixes that (and costs nothing where the server already uses the current time).
 */
function restartStreams(): Promise<void> {
  if (!restarting) {
    lastRestartAt = Date.now()
    const { db } = getFirebase()
    restarting = disableNetwork(db)
      .then(() => enableNetwork(db))
      .catch(() => {})
      .finally(() => {
        restarting = null
      })
  }
  return restarting
}

function spaceRef(spaceId: string) {
  return doc(getFirebase().db, 'spaces', spaceId)
}

/** A planning period: a week ('weeks') or a month's list ('monthly', SPEC §9.5). */
export type PeriodColl = 'weeks' | 'monthly'

export function periodRef(spaceId: string, coll: PeriodColl, id: string) {
  return doc(getFirebase().db, 'spaces', spaceId, coll, id)
}

export function weekRef(spaceId: string, weekId: WeekId) {
  return periodRef(spaceId, 'weeks', weekId)
}

/** The stored timeline is more than an hour off the one the space's zone gives on the week's own schedule (see
 *  SPEC §1, §9.2): a retimed week follows its stored `schedule`, so it isn't flagged. */
function mismatched(week: Week, weekId: WeekId, timezone: string): boolean {
  try {
    return boundsDiffer(week, weekBounds(weekId, timezone, scheduleOf(week)))
  } catch {
    return false
  }
}

export function weekKey(uid: UID, spaceId: string, weekId: WeekId): string {
  return `${uid}|week|${spaceId}|${weekId}`
}

export function startWeek(spaceId: string, weekId: WeekId, uid: UID): Start<WeekData> {
  return (emit) => watchWeek(spaceId, weekId, uid, emit)
}

/** What a period listener gathers: the space, the period doc (null: none yet), plans, progress and reviews. */
export interface PeriodParts {
  space: Space
  period: Week | null
  plans: Record<UID, Plan>
  progress: Record<UID, Progress>
  reviews: Review[]
}

/**
 * Listens to one week: the space (its zone), the week doc, plans, progress and
 * reviews. Reviews follow the blind rule: only the user's own until the week is revealed, then
 * everyone's. The switch happens live, both when the last member submits and (by timer) at
 * deadlineAt, and a revealed week is never published with only the user's own reviews.
 */
export function watchWeek(spaceId: string, weekId: WeekId, uid: UID, emit: Emit<WeekData>): () => void {
  return watchPeriod(
    spaceId,
    'weeks',
    weekId,
    uid,
    (parts, boundsMismatch) => ({ spaceId, weekId, week: parts.period, plans: parts.plans, progress: parts.progress, reviews: parts.reviews, boundsMismatch }),
    emit,
    { mismatch: (space, week) => mismatched(week, weekId, space.timezone) },
  )
}

/** How a period watch flags a skewed timeline; `watch` may listen to more (and call `republish` on news). */
export interface MismatchCheck {
  mismatch: (space: Space, period: Week) => boolean
  watch?: (space: Space, republish: () => void) => () => void
}

/**
 * Listens to one period (a week, or a month's list): the space, the period doc, plans, progress and reviews,
 * with the blind rule (own reviews until revealed, then everyone's, switched live at the last submit and by
 * timer at deadlineAt). A revealed period is never published with only the user's own reviews.
 */
export function watchPeriod<T>(
  spaceId: string,
  coll: PeriodColl,
  id: string,
  uid: UID,
  build: (parts: PeriodParts, boundsMismatch: boolean) => T,
  emit: Emit<T>,
  check: MismatchCheck,
): () => void {
  const ref = periodRef(spaceId, coll, id)
  let space: Space | undefined
  let week: Week | null | undefined
  /** The period as the server has it. A reveal seen only through our own pending submit would be denied. */
  let weekConfirmed = false
  let plans: Record<UID, Plan> | undefined
  let progress: Record<UID, Progress> | undefined
  let reviews: Review[] | undefined
  /** Which query the reviews in `reviews` came from. */
  let reviewsScope: 'mine' | 'all' | null = null
  let error: Error | null = null
  let stopped = false
  let published = false

  let reviewMode: 'mine' | 'all' | null = null
  let stopReviews = () => {}
  let stopExtra = () => {}
  let timer: ReturnType<typeof setTimeout> | null = null
  let fullReadAllowedAt = 0

  /** Revealed as scoring and the rules see it: every period member has submitted, or the deadline passed. */
  const revealedHere = () => week != null && space !== undefined && isRevealed(week, now())

  const publish = () => {
    if (stopped) return
    if (week !== undefined && space !== undefined && plans && progress && reviews) {
      // Scoring a revealed period from our own reviews alone gives wrong scores and false "didn't review"
      // points, so hold the last state until everyone's arrive. Only a denied full read (clock skew,
      // retrying) shows what we have.
      if (revealedHere() && reviewsScope !== 'all' && Date.now() >= fullReadAllowedAt) {
        if (!published) emit({ data: undefined, loading: error === null, error })
        return
      }
      const boundsMismatch = week ? check.mismatch(space, week) : false
      published = true
      emit({ data: build({ space, period: week, plans, progress, reviews }, boundsMismatch), loading: false, error })
    } else {
      emit({ data: undefined, loading: error === null, error })
    }
  }

  const fail = (e: unknown) => {
    error = humanError(e, MSG.noAccess)
    publish()
  }

  const isPastDeadline = () => week != null && now() >= week.deadlineAt

  const syncReviews = () => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = null
    const revealed = revealedHere() && (weekConfirmed || isPastDeadline())
    const want = revealed && Date.now() >= fullReadAllowedAt ? 'all' : 'mine'
    // Re-evaluate at the deadline (reveal by time) or when a denied full read may be retried.
    const wakeIn = !revealed && week ? week.deadlineAt - now() + REVEAL_GRACE_MS : revealed && want === 'mine' ? fullReadAllowedAt - Date.now() : null
    if (wakeIn !== null) timer = setTimeout(syncReviews, Math.min(Math.max(wakeIn, 0), MAX_TIMEOUT_MS))
    if (want === reviewMode) return
    reviewMode = want
    stopReviews()
    const col = collection(ref, 'reviews')
    stopReviews = onSnapshot(
      want === 'all' ? col : query(col, where('reviewerId', '==', uid)),
      // A full read answers from the cache first, which may hold only our own reviews (from the own-reviews
      // query): such an answer counts as ours until the server confirms it.
      { includeMetadataChanges: want === 'all' },
      (snap) => {
        reviews = snap.docs.map(toReview)
        const unconfirmed = want === 'all' && snap.metadata.fromCache && reviews.every((r) => r.reviewerId === uid)
        reviewsScope = unconfirmed ? 'mine' : want
        publish()
      },
      (e) => {
        if (!(want === 'all' && isDenied(e))) return fail(e)
        reviewMode = null
        if (isPastDeadline() && canRestartStreams()) {
          void restartStreams().then(syncReviews)
        } else {
          // The server doesn't see the reveal yet: clock skew, or a dev ?now= override.
          fullReadAllowedAt = Date.now() + REVEAL_RETRY_MS
          syncReviews()
          publish()
        }
      },
    )
  }

  let weekJson = ''
  let spaceJson = ''
  const stops = [
    onSnapshot(
      spaceRef(spaceId),
      (snap) => {
        if (!snap.exists()) return fail(new Error(MSG.noAccess))
        const next = toSpace(snap)
        const json = JSON.stringify([next.memberIds, next.leftAt, next.timezone, next.schedule ?? null])
        const changed = space === undefined || json !== spaceJson
        const zoneChanged = space === undefined || space.timezone !== next.timezone || !sameSchedule(space.schedule, next.schedule)
        space = next
        spaceJson = json
        if (!changed) return
        if (zoneChanged && check.watch) {
          stopExtra()
          stopExtra = check.watch(next, publish)
        }
        syncReviews()
        publish()
      },
      fail,
    ),
    onSnapshot(
      ref,
      { includeMetadataChanges: true },
      (snap) => {
        weekConfirmed = !snap.metadata.hasPendingWrites
        const next = snap.exists() ? (coll === 'monthly' ? toMonthly(snap, spaceId) : toWeek(snap, spaceId)) : null
        const json = JSON.stringify(next)
        const changed = week === undefined || json !== weekJson
        week = next
        weekJson = json
        syncReviews()
        if (changed) publish()
      },
      fail,
    ),
    onSnapshot(
      collection(ref, 'plans'),
      (snap) => {
        plans = Object.fromEntries(snap.docs.map((d) => [d.id, toPlan(d)]))
        publish()
      },
      fail,
    ),
    onSnapshot(
      collection(ref, 'progress'),
      (snap) => {
        progress = Object.fromEntries(snap.docs.map((d) => [d.id, toProgress(d)]))
        publish()
      },
      fail,
    ),
  ]
  syncReviews()

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    stopReviews()
    stopExtra()
    stops.forEach((stop) => stop())
  }
}

const filled = new Set<string>()
/** One attempt per week and member list at a time, so several screens opening a space don't race. */
const filling = new Map<string, Promise<void>>()

function hasAll(snap: DocumentSnapshot | null, uids: UID[]): boolean {
  if (!snap?.exists()) return false
  const members: unknown = snap.get('members')
  return Array.isArray(members) && uids.every((uid) => members.includes(uid))
}

/** A doc's `judges` exactly as stored (the rules compare lists as stored), or undefined without a list. */
export function rawJudges(snap: DocumentSnapshot | null | undefined): string[] | undefined {
  const judges: unknown = snap?.exists() ? snap.get('judges') : undefined
  return Array.isArray(judges) && judges.every((j) => typeof j === 'string') ? (judges as string[]) : undefined
}

export function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = a ?? []
  const y = b ?? []
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/** A stored time exactly as stored (the rules compare it exactly), else the ms as a Timestamp. */
export function storedTime(snap: DocumentSnapshot | null | undefined, field: string, fallbackMs: number): Timestamp {
  const value: unknown = snap?.exists() ? snap.get(field) : undefined
  return value instanceof Timestamp && value.toMillis() === fallbackMs ? value : Timestamp.fromMillis(fallbackMs)
}

/** The key part of a space's schedule and judges, for upkeep caches. */
export function upkeepKey(space: Space): string {
  const s = space.schedule
  return `${s ? `${s.lock}/${s.reviewOpen}/${s.deadline}` : ''}|${(space.judges ?? []).join(',')}`
}

/** The week doc as the cache has it is already what the upkeep would make of it. */
function upToDate(snap: DocumentSnapshot | null, space: Space, nowMs: number): boolean {
  if (!snap?.exists() || !hasAll(snap, space.memberIds)) return false
  const week = toWeek(snap, space.id)
  if (nowMs >= week.lockAt) return true
  return sameList(rawJudges(snap), space.judges) && needsRetime(space, week, nowMs) === null
}

/**
 * Makes sure the week exists and has every current space member while it is before lockAt, so
 * taking part never depends on who opened the app. Weeks nobody opened before lockAt stay inactive
 * (no doc). Batch 2 (SPEC §9.2, §9.4): a week is created on the space's schedule (storing `schedule` unless it
 * is the usual one) with its judges snapshot (unless nobody judges); an existing week that hasn't locked follows
 * a change of times with a day's notice (retimed in its own write) and keeps its members and judges in step
 * with the space. Best effort: callers ignore failures (offline, a lock that just passed).
 */
export function ensureWeek(space: Space, weekId: WeekId): Promise<void> {
  const key = `${space.id}|${weekId}|${[...space.memberIds].sort().join(',')}|${upkeepKey(space)}`
  if (filled.has(key)) return Promise.resolve()
  let pending = filling.get(key)
  if (!pending) {
    pending = fillWeek(space, weekId)
      .then(() => {
        filled.add(key)
      })
      .finally(() => filling.delete(key))
    filling.set(key, pending)
  }
  return pending
}

/** Bounds as stored Timestamps. */
export function boundsData(b: WeekBounds): Record<'lockAt' | 'reviewOpenAt' | 'deadlineAt', Timestamp> {
  return { lockAt: Timestamp.fromMillis(b.lockAt), reviewOpenAt: Timestamp.fromMillis(b.reviewOpenAt), deadlineAt: Timestamp.fromMillis(b.deadlineAt) }
}

/** `schedule` as a week or space stores it: absent for the usual times. */
export function scheduleField(s: WeekSchedule): WeekSchedule | FieldValue {
  return isUsualSchedule(s) ? deleteField() : { lock: s.lock, reviewOpen: s.reviewOpen, deadline: s.deadline }
}

async function fillWeek(space: Space, weekId: WeekId): Promise<void> {
  const ref = weekRef(space.id, weekId)
  const cached = await getDocFromCache(ref).catch(() => null)
  if (upToDate(cached, space, now())) return
  const cachedLock = cached?.exists() ? toWeek(cached, space.id).lockAt : boundsFor(space, weekId).lockAt
  if (now() >= cachedLock) return
  /** One write at most (no rule branch allows a retime and a member sync together); true when it wrote. */
  const attempt = () =>
    runTransaction(getFirebase().db, async (tx) => {
      // The member list as the rules will see it: everyone who is in the space right now.
      const spaceSnap = await tx.get(spaceRef(space.id))
      if (!spaceSnap.exists()) return false
      const fresh = toSpace(spaceSnap)
      const judges = rawJudges(spaceSnap) ?? []
      const snap = await tx.get(ref)
      const at = now()
      if (!snap.exists()) {
        const schedule = scheduleOf(fresh)
        const bounds = weekBounds(weekId, fresh.timezone, schedule)
        if (at >= bounds.lockAt) return false
        // After a change of times no week can lock within a day of it (the rules refuse it).
        if (fresh.scheduleNote && bounds.lockAt < fresh.scheduleNote.at + RETIME_NOTICE_MS) return false
        const data: Record<string, unknown> = {
          startAt: Timestamp.fromMillis(bounds.startAt),
          ...boundsData(bounds),
          members: fresh.memberIds,
          submittedBy: [],
        }
        if (!isUsualSchedule(schedule)) data.schedule = { lock: schedule.lock, reviewOpen: schedule.reviewOpen, deadline: schedule.deadline }
        if (judges.length > 0) data.judges = judges
        tx.set(ref, data)
        return false
      }
      const week = toWeek(snap, space.id)
      if (at >= week.lockAt) return false
      const moved = needsRetime(fresh, week, at)
      if (moved) {
        tx.update(ref, { ...boundsData(moved), schedule: scheduleField(scheduleOf(fresh)) })
        return true
      }
      const missing = fresh.memberIds.filter((m) => !week.members.includes(m))
      const stored = rawJudges(snap)
      // A week without a snapshot in a space without judges stays as it is (older clients' shape).
      const judgesDiffer = !sameList(stored, judges) && !(stored === undefined && judges.length === 0)
      if (judgesDiffer) {
        tx.update(ref, missing.length > 0 ? { members: arrayUnion(...missing), judges } : { judges })
      } else if (missing.length > 0) {
        tx.update(ref, { members: arrayUnion(...missing) })
      }
      return false
    })
  const run = async () => {
    // A retime goes alone; the members and judges follow in a second write.
    if (await attempt()) await attempt()
  }
  try {
    await run()
  } catch {
    // Most likely a friend created the week at the same moment; the doc exists now, so this fills it.
    await run()
  }
}

/**
 * Whether the current user takes part in the week, after making sure every current member is in
 * it (while that is still possible).
 */
export async function joinWeek(space: Space, weekId: WeekId): Promise<boolean> {
  const uid = requireUser().uid
  await ensureWeek(space, weekId).catch(() => {})
  const ref = weekRef(space.id, weekId)
  const cached = await getDocFromCache(ref).catch(() => null)
  if (hasAll(cached, [uid])) return true
  return hasAll(await getDoc(ref), [uid])
}

/**
 * The week's timeline as stored in its doc (what the rules judge writes by), else as computed from
 * the space's zone. The open week is normally cached by its listener; otherwise this costs one read.
 */
async function boundsOf(space: Space, weekId: WeekId): Promise<WeekBounds> {
  const ref = weekRef(space.id, weekId)
  const snap = (await getDocFromCache(ref).catch(() => null)) ?? (await getDoc(ref).catch(() => null))
  return snap?.exists() ? toWeek(snap, space.id) : boundsFor(space, weekId)
}

/** The week doc as this device has it (cache, else one read); null when there is none. */
async function storedWeek(space: Space, weekId: WeekId): Promise<Week | null> {
  const ref = weekRef(space.id, weekId)
  const snap = (await getDocFromCache(ref).catch(() => null)) ?? (await getDoc(ref).catch(() => null))
  return snap?.exists() ? toWeek(snap, space.id) : null
}

const JUDGING_WEEK = 'You’re judging this week, so there’s no list to plan.'

/** Judges have no list (SPEC §9.4): the week's snapshot decides, else (no doc yet) the space's judges. */
async function judgesWeek(space: Space, weekId: WeekId, uid: UID): Promise<boolean> {
  const week = await storedWeek(space, weekId)
  return week ? judgesOf(week).includes(uid) : (space.judges ?? []).includes(uid)
}

/** Why someone who is in the space isn't in this week. */
async function notInWeekMessage(space: Space, weekId: WeekId, uid: UID): Promise<string> {
  const fresh = await getDoc(spaceRef(space.id)).then(
    (snap) => (snap.exists() ? toSpace(snap) : space),
    () => space,
  )
  return joinedAfterLock(fresh, uid, (await boundsOf(space, weekId)).lockAt)
    ? "You joined after this week's lists locked. You're in from next week."
    : "This week started without you. You're in from next week."
}

export const MAX_TITLE = 120
const TOO_MANY_STEPS = `A task can have up to ${MAX_SUBTASKS} steps.`
const LONG_TASK = `Keep each task under ${MAX_TITLE} characters.`
const LONG_STEP = `Keep each step under ${MAX_TITLE} characters.`
/** Not a space member any more: no adds, cross-outs or undos (SPEC §10.6). */
export const NOT_IN_SPACE = 'You’re no longer in this space.'

/** Steps are edited in the task sheet, not inline, so they are tidied: one line, trimmed, blank ones dropped. */
function cleanSteps(task: Task): Task {
  const steps = (task.subtasks ?? []).map((step) => ({ id: step.id, title: oneLine(step.title) })).filter((step) => step.title !== '')
  return steps.length > 0 ? { id: task.id, title: task.title, subtasks: steps } : { id: task.id, title: task.title }
}

export function cleanTasks(tasks: Task[], period: 'week' | 'month' = 'week'): Task[] {
  // Blank rows are dropped; titles are otherwise stored as typed so autosave can't fight the cursor.
  // addedAt never comes along: before the lock nothing counts as added.
  const out = tasks.filter((t) => t.title.trim() !== '').map(cleanSteps)
  if (out.length > MAX_TASKS) throw new Error(`You can plan up to ${MAX_TASKS} tasks a ${period}.`)
  if (out.some((t) => t.title.length > MAX_TITLE)) throw new Error(LONG_TASK)
  if (out.some((t) => (t.subtasks?.length ?? 0) > MAX_SUBTASKS)) throw new Error(TOO_MANY_STEPS)
  if (out.some((t) => t.subtasks?.some((step) => step.title.length > MAX_TITLE))) throw new Error(LONG_STEP)
  // Steps are ticked by id like tasks, so every id is unique across the whole list.
  const ids = out.flatMap((t) => [t.id, ...(t.subtasks ?? []).map((step) => step.id)])
  if (new Set(ids).size !== ids.length || !ids.every((id) => TASK_ID.test(id))) throw new Error(MSG.generic)
  return out
}

function planRef(spaceId: string, weekId: WeekId, uid: UID) {
  return doc(weekRef(spaceId, weekId), 'plans', uid)
}

function progressRef(spaceId: string, weekId: WeekId, uid: UID) {
  return doc(weekRef(spaceId, weekId), 'progress', uid)
}

/** The user's plan and check-offs as this device has them (cache, else the open week); each undefined when it can't tell. */
async function localWeek(space: Space, weekId: WeekId, uid: UID): Promise<{ tasks?: Task[]; done?: Record<string, boolean> }> {
  const fromCache = (ref: ReturnType<typeof planRef>) => getDocFromCache(ref).catch(() => null)
  const [plan, progress] = await Promise.all([fromCache(planRef(space.id, weekId, uid)), fromCache(progressRef(space.id, weekId, uid))])
  // A doc the open week's listeners never saw doesn't exist; the cache can't tell that apart from "not loaded".
  const live = peek<WeekData>(weekKey(uid, space.id, weekId)).data
  return {
    tasks: plan ? (plan.exists() ? toPlan(plan).tasks : []) : live && (live.plans[uid]?.tasks ?? []),
    done: progress ? (progress.exists() ? toProgress(progress).done : {}) : live && (live.progress[uid]?.done ?? {}),
  }
}

/**
 * Ticks left by tasks and steps deleted before the lock (and the own key of a task that has steps
 * now), cleared only when a new tick would go over the cap: a full list of steps needs every key.
 */
export function staleTicks(local: { tasks?: Task[]; done?: Record<string, boolean> }, id: string): Record<string, FieldValue> {
  const { tasks, done } = local
  if (!tasks || !done || Object.hasOwn(done, id) || Object.keys(done).length < MAX_TICKS) return {}
  const live = new Set(tasks.flatMap((t) => (t.subtasks?.length ? t.subtasks.map((step) => step.id) : [t.id])))
  return Object.fromEntries(Object.keys(done).filter((key) => !live.has(key)).map((key) => [key, deleteField()]))
}

/** The task a check-off id belongs to: the task itself or the task holding that step. */
export function taskOf(tasks: Task[], id: string): Task | undefined {
  return tasks.find((t) => t.id === id) ?? tasks.find((t) => t.subtasks?.some((step) => step.id === id))
}

/** Replaces the current user's task list (only before lockAt). */
export async function savePlan(space: Space, weekId: WeekId, tasks: Task[]): Promise<void> {
  const clean = cleanTasks(tasks)
  const uid = requireUser().uid
  const ref = planRef(space.id, weekId, uid)
  let before: Task[] | undefined
  try {
    if (now() >= (await boundsOf(space, weekId)).lockAt) throw new Error(MSG.closed)
    if (!(await joinWeek(space, weekId))) throw new Error(MSG.closed)
    if (await judgesWeek(space, weekId, uid)) throw new Error(JUDGING_WEEK)
    before = (await localWeek(space, weekId, uid)).tasks
    await setDoc(ref, { tasks: clean.map(encodeTask), updatedAt: serverTimestamp() })
  } catch (e) {
    throw humanError(e)
  }
  // Earnings follow renamed and deleted tasks. After the save and in the background: it never holds
  // up or fails the save, and a lost sync only leaves an earning to be fixed by the next one.
  const ids = new Set(clean.map((t) => t.id))
  const removed = before ? new Set(before.map((t) => t.id).filter((id) => !ids.has(id))) : null
  const titles = new Map(before?.map((t) => [t.id, t.title.trim()]))
  const renamed = clean.some((t) => titles.has(t.id) && titles.get(t.id) !== t.title.trim())
  if (removed === null || removed.size > 0 || renamed) void syncPlanEarnings(uid, space.id, weekId, clean, removed)
}

export interface NewTaskInput {
  /** The new task's id, made once per add so trying again after an error can't add it twice. */
  id?: string
  title: string
  /** Step titles in order; blank ones are dropped. */
  subtasks?: string[]
}

/** The task an add after the lock appends (a week's or a monthly list's), checked with the planner's messages. */
export function taskToAdd(input: NewTaskInput): Task {
  const title = input.title.trim()
  if (!title) throw new Error('Give the task a title.')
  if (title.length > MAX_TITLE) throw new Error(LONG_TASK)
  const steps = (input.subtasks ?? []).map(oneLine).filter((step) => step !== '')
  if (steps.length > MAX_SUBTASKS) throw new Error(TOO_MANY_STEPS)
  if (steps.some((step) => step.length > MAX_TITLE)) throw new Error(LONG_STEP)
  if (input.id !== undefined && !TASK_ID.test(input.id)) throw new Error(MSG.generic)
  const task: Task = { id: input.id ?? newTaskId(), title }
  if (steps.length > 0) task.subtasks = steps.map((step) => ({ id: newTaskId(), title: step }))
  return task
}

/**
 * The append itself, inside a transaction that has read the plan (`snap`): everything already stored goes back
 * exactly as it is (the rules compare it item by item) with the task at the end and its `added` time. An existing
 * plan is updated, never set, so its cross-out log (`cancels`) stays as stored (SPEC §10.2, §10.3); a set would
 * drop it, and the rules refuse that once there is one. false when the task is already there: an earlier attempt
 * went through though its answer was lost (the SDK retries the transaction, or the user tries again).
 */
export function appendTask(tx: Transaction, ref: DocumentReference, snap: DocumentSnapshot, task: Task, cap: string): boolean {
  const stored: unknown = snap.get('tasks')
  const existing = Array.isArray(stored) ? stored : []
  if (existing.some((t) => (t as { id?: unknown } | null)?.id === task.id)) return false
  if (existing.length >= MAX_TASKS) throw new Error(cap)
  const added: unknown = snap.get('added')
  const data = {
    tasks: [...existing, encodeTask(task)],
    added: { ...(added && typeof added === 'object' ? added : {}), [task.id]: serverTimestamp() },
    updatedAt: serverTimestamp(),
  }
  if (snap.exists()) tx.update(ref, data)
  else tx.set(ref, data)
  return true
}

/**
 * Appends one task (with its steps) to the current user's list after the lock, until the review window
 * opens (SPEC §6.2). Final: it can't be edited or removed. Resolves with the task as stored; its
 * addedAt is the device's estimate until the plan's snapshot brings the server time. Keeps the plan's
 * cross-outs (an update of an existing plan, SPEC §10.3); without a plan it starts one.
 */
export async function addTaskAfterLock(space: Space, weekId: WeekId, input: NewTaskInput): Promise<Task> {
  const uid = requireUser().uid
  const task = taskToAdd(input)
  const ref = planRef(space.id, weekId, uid)
  try {
    const bounds = await boundsOf(space, weekId)
    if (now() < bounds.lockAt) throw new Error('Your list hasn’t locked yet. Add the task to it instead.')
    if (now() >= bounds.reviewOpenAt) throw new Error('Adding tasks closed when reviews opened.')
    if (!space.memberIds.includes(uid)) throw new Error(NOT_IN_SPACE)
    if (!(await joinWeek(space, weekId))) throw new Error(await notInWeekMessage(space, weekId, uid))
    if (await judgesWeek(space, weekId, uid)) throw new Error(JUDGING_WEEK)
    await runTransaction(getFirebase().db, async (tx) => {
      appendTask(tx, ref, await tx.get(ref), task, `You can plan up to ${MAX_TASKS} tasks a week.`)
    })
  } catch (e) {
    throw humanError(e)
  }
  return { ...task, addedAt: Date.now() }
}

/** Check-offs in progress, by user and week (see setTaskDone). */
const ticking = new Map<string, Promise<void>>()

/**
 * Self check-off (until deadlineAt). `id` is a task id or a step id. The task's earning, if it has one,
 * follows: earned when the task becomes done (its last step, or the task itself), not when it isn't.
 * A task crossed out on this device's copy of the plan, or a step of one, isn't ticked (SPEC §10.3).
 */
export async function setTaskDone(space: Space, weekId: WeekId, id: string, done: boolean): Promise<void> {
  const uid = requireUser().uid
  // One check-off of a week at a time, until its write is issued: each decides from what the one
  // before wrote, so ticking the last two steps quickly still earns the task. Issued, not confirmed:
  // a write the server hasn't answered (offline) never holds up the next tick.
  const key = `${uid}|${space.id}|${weekId}`
  const previous = ticking.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const mine = previous.then(() => gate)
  ticking.set(key, mine)
  void mine.then(() => {
    if (ticking.get(key) === mine) ticking.delete(key)
  })
  await previous
  try {
    if (now() >= (await boundsOf(space, weekId)).deadlineAt) throw new Error(MSG.closed)
    if (!(await joinWeek(space, weekId))) throw new Error(await notInWeekMessage(space, weekId, uid))
    const ref = progressRef(space.id, weekId, uid)
    // Ticking reads only what this device has, so it stays instant and works offline.
    const local = await localWeek(space, weekId, uid)
    const task = local.tasks && taskOf(local.tasks, id)
    // The rules don't check this (it would read the plan on every tick, SPEC §10.12): the app does.
    if (task && isCancelled(task)) throw new Error(CROSSED_OUT_TICK)
    const progress = { done: { ...staleTicks(local, id), [id]: done }, updatedAt: serverTimestamp() }
    const taskDone = task && local.done ? isTaskDone(task, { ...local.done, [id]: done }) : undefined
    const earning = task ? earningId(space.id, weekId, task.id) : null
    const known = earning ? await knownEarning(uid, earning) : null
    // Money earned before the balance was set stays earned, or ticking again would count it twice.
    const keep = !!known?.earned && taskDone === false && (await keepsEarned(uid, known.earnedAt))
    const change = known && taskDone !== undefined ? earnedAtChange(known.earned, taskDone, keep) : undefined
    if (change && earning) {
      const batch = writeBatch(getFirebase().db)
      batch.set(ref, progress, { merge: true })
      batch.update(earningRef(uid, earning), change)
      // The write is in this device's cache once issued, so the next check-off can go.
      const commit = batch.commit()
      release()
      try {
        await commit
        return
      } catch (e) {
        // The earning may be gone (switched off on another device): the check-off still counts.
        if (!isDenied(e) && errorCode(e) !== 'not-found') throw e
      }
    }
    const write = setDoc(ref, progress, { merge: true })
    release()
    await write
    // Whatever this device couldn't tell is settled from the server afterwards.
    if (earning && taskDone !== undefined && known === undefined) settleLater(space.id, weekId, uid, id, { earning, done: taskDone })
    else if (!local.tasks || (task && known !== null && taskDone === undefined)) settleLater(space.id, weekId, uid, id)
  } catch (e) {
    throw humanError(e)
  } finally {
    // A check-off refused before writing (closed week, not in it) mustn't hold up the next.
    release()
  }
}

/**
 * Puts the task's earning in step from the server, in the background: only the earning when the
 * device knew the task and whether it is done, else the plan and check-offs too.
 */
function settleLater(spaceId: string, weekId: WeekId, uid: UID, id: string, known?: { earning: string; done: boolean }): void {
  void inBackground(`${uid}|earning|${spaceId}|${weekId}`, async () => {
    if (known) return settleEarning(uid, known.earning, known.done)
    const [plan, progress] = await Promise.all([getDoc(planRef(spaceId, weekId, uid)), getDoc(progressRef(spaceId, weekId, uid))])
    const task = plan.exists() ? taskOf(toPlan(plan).tasks, id) : undefined
    if (!task) return
    await settleEarning(uid, earningId(spaceId, weekId, task.id), isTaskDone(task, progress.exists() ? toProgress(progress).done : {}))
  })
}

/** Writes all of the current user's reviews and marks them submitted, in one batch. Final. A crossed-out task's
 *  mark is 'fair' (Fair, Skip It) or 0 (Not Done), SPEC §10.4. */
export async function submitReviews(space: Space, weekId: WeekId, reviews: { revieweeId: UID; marks: Record<string, ReviewMark> }[]): Promise<void> {
  const uid = requireUser().uid
  if (reviews.some((r) => r.revieweeId === uid || !Object.values(r.marks).every(isReviewMark))) throw new Error(MSG.generic)
  const bounds = await boundsOf(space, weekId)
  if (now() < bounds.reviewOpenAt) throw new Error('Reviews haven’t opened yet.')
  if (now() >= bounds.deadlineAt) throw new Error(MSG.closed)
  const { db } = getFirebase()
  const ref = weekRef(space.id, weekId)
  const batch = writeBatch(db)
  for (const { revieweeId, marks } of reviews) {
    batch.set(doc(ref, 'reviews', reviewDocId(uid, revieweeId)), { reviewerId: uid, revieweeId, marks, submittedAt: serverTimestamp() })
  }
  batch.update(ref, { submittedBy: arrayUnion(uid) })
  try {
    await batch.commit()
  } catch (e) {
    throw humanError(e)
  }
}
