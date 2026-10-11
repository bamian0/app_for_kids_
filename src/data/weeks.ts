// Weeks: participation, live week data (with the blind-review reveal) and the week's writes.
import {
  arrayUnion,
  collection,
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
  type DocumentSnapshot,
} from 'firebase/firestore'
import { now } from '../domain/clock.ts'
import { MAX_SUBTASKS, newTaskId, reviewDocId } from '../domain/ids.ts'
import { earningId } from '../domain/money.ts'
import { isRevealed, isTaskDone, joinedAfterLock } from '../domain/scoring.ts'
import { boundsDiffer, weekBounds, type WeekBounds } from '../domain/time.ts'
import type { Mark, Plan, Progress, Review, Space, Task, UID, Week, WeekData, WeekId } from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import type { Live } from './api.ts'
import { isMark, toPlan, toProgress, toReview, toSpace, toWeek } from './convert.ts'
import { errorCode, humanError, isDenied, MSG } from './errors.ts'
import { earnedAtChange, earningRef, inBackground, knownEarning, settleEarning, syncPlanEarnings } from './money.ts'
import { requireUser } from './session.ts'
import { peek, type Emit, type Start } from './store.ts'
import { encodeTask, oneLine, TASK_ID } from './tasks.ts'

const MAX_TASKS = 25
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

export function weekRef(spaceId: string, weekId: WeekId) {
  return doc(getFirebase().db, 'spaces', spaceId, 'weeks', weekId)
}

/** The stored timeline is more than an hour off the one the space's zone gives (see SPEC §1). */
function mismatched(week: Week, weekId: WeekId, timezone: string): boolean {
  try {
    return boundsDiffer(week, weekBounds(weekId, timezone))
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

/**
 * Listens to one week: the space (its zone), the week doc, plans, progress and
 * reviews. Reviews follow the blind rule: only the user's own until the week is revealed, then
 * everyone's. The switch happens live, both when the last member submits and (by timer) at
 * deadlineAt, and a revealed week is never published with only the user's own reviews.
 */
export function watchWeek(spaceId: string, weekId: WeekId, uid: UID, emit: Emit<WeekData>): () => void {
  const ref = weekRef(spaceId, weekId)
  let space: Space | undefined
  let week: Week | null | undefined
  /** The week as the server has it. A reveal seen only through our own pending submit would be denied. */
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
  let timer: ReturnType<typeof setTimeout> | null = null
  let fullReadAllowedAt = 0

  /** Revealed as scoring and the rules see it: every week member has submitted, or the deadline passed. */
  const revealedHere = () => week != null && space !== undefined && isRevealed(week, now())

  const publish = () => {
    if (stopped) return
    if (week !== undefined && space !== undefined && plans && progress && reviews) {
      // Scoring a revealed week from our own reviews alone gives wrong scores and false "didn't review"
      // points, so hold the last state until everyone's arrive. Only a denied full read (clock skew,
      // retrying) shows what we have.
      if (revealedHere() && reviewsScope !== 'all' && Date.now() >= fullReadAllowedAt) {
        if (!published) emit({ data: undefined, loading: error === null, error })
        return
      }
      const boundsMismatch = week ? mismatched(week, weekId, space.timezone) : false
      published = true
      emit({ data: { spaceId, weekId, week, plans, progress, reviews, boundsMismatch }, loading: false, error })
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
      (snap) => {
        reviews = snap.docs.map(toReview)
        reviewsScope = want
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
        const json = JSON.stringify([next.memberIds, next.leftAt, next.timezone])
        const changed = space === undefined || json !== spaceJson
        space = next
        spaceJson = json
        if (!changed) return
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
        const next = snap.exists() ? toWeek(snap, spaceId) : null
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
    stops.forEach((stop) => stop())
  }
}

/** Merges per-week states for useMonth: data once every week has loaded, the first error otherwise. */
export function mergeWeeks(states: Live<WeekData>[]): Live<WeekData[]> {
  const error = states.find((s) => s.error)?.error ?? null
  if (states.every((s) => s.data)) return { data: states.map((s) => s.data as WeekData), loading: false, error }
  return { data: undefined, loading: error === null, error }
}

const filled = new Set<string>()
/** One attempt per week and member list at a time, so several screens opening a space don't race. */
const filling = new Map<string, Promise<void>>()

function hasAll(snap: DocumentSnapshot | null, uids: UID[]): boolean {
  if (!snap?.exists()) return false
  const members: unknown = snap.get('members')
  return Array.isArray(members) && uids.every((uid) => members.includes(uid))
}

/**
 * Makes sure the week exists and has every current space member while it is before lockAt, so
 * taking part never depends on who opened the app. Weeks nobody opened before lockAt stay inactive
 * (no doc). Best effort: callers ignore failures (offline, a lock that just passed).
 */
export function ensureWeek(space: Space, weekId: WeekId): Promise<void> {
  const key = `${space.id}|${weekId}|${[...space.memberIds].sort().join(',')}`
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

async function fillWeek(space: Space, weekId: WeekId): Promise<void> {
  const ref = weekRef(space.id, weekId)
  const cached = await getDocFromCache(ref).catch(() => null)
  if (hasAll(cached, space.memberIds)) return
  const cachedLock = cached?.exists() ? toWeek(cached, space.id).lockAt : weekBounds(weekId, space.timezone).lockAt
  if (now() >= cachedLock) return
  const attempt = () =>
    runTransaction(getFirebase().db, async (tx) => {
      // The member list as the rules will see it: everyone who is in the space right now.
      const spaceSnap = await tx.get(spaceRef(space.id))
      if (!spaceSnap.exists()) return
      const fresh = toSpace(spaceSnap)
      const snap = await tx.get(ref)
      if (!snap.exists()) {
        const bounds = weekBounds(weekId, fresh.timezone)
        if (now() >= bounds.lockAt) return
        tx.set(ref, {
          startAt: Timestamp.fromMillis(bounds.startAt),
          lockAt: Timestamp.fromMillis(bounds.lockAt),
          reviewOpenAt: Timestamp.fromMillis(bounds.reviewOpenAt),
          deadlineAt: Timestamp.fromMillis(bounds.deadlineAt),
          members: fresh.memberIds,
          submittedBy: [],
        })
        return
      }
      const week = toWeek(snap, space.id)
      if (now() >= week.lockAt) return
      const missing = fresh.memberIds.filter((m) => !week.members.includes(m))
      if (missing.length > 0) tx.update(ref, { members: arrayUnion(...missing) })
    })
  try {
    await attempt()
  } catch {
    // Most likely a friend created the week at the same moment; the doc exists now, so this fills it.
    await attempt()
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
  return snap?.exists() ? toWeek(snap, space.id) : weekBounds(weekId, space.timezone)
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

const MAX_TITLE = 120
const TOO_MANY_STEPS = `A task can have up to ${MAX_SUBTASKS} steps.`
const LONG_TASK = `Keep each task under ${MAX_TITLE} characters.`
const LONG_STEP = `Keep each step under ${MAX_TITLE} characters.`

/** Steps are edited in the task sheet, not inline, so they are tidied: one line, trimmed, blank ones dropped. */
function cleanSteps(task: Task): Task {
  const steps = (task.subtasks ?? []).map((step) => ({ id: step.id, title: oneLine(step.title) })).filter((step) => step.title !== '')
  return steps.length > 0 ? { id: task.id, title: task.title, subtasks: steps } : { id: task.id, title: task.title }
}

function cleanTasks(tasks: Task[]): Task[] {
  // Blank rows are dropped; titles are otherwise stored as typed so autosave can't fight the cursor.
  // addedAt never comes along: before the lock nothing counts as added.
  const out = tasks.filter((t) => t.title.trim() !== '').map(cleanSteps)
  if (out.length > MAX_TASKS) throw new Error(`You can plan up to ${MAX_TASKS} tasks a week.`)
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

/** The task a check-off id belongs to: the task itself or the task holding that step. */
function taskOf(tasks: Task[], id: string): Task | undefined {
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
  title: string
  /** Step titles in order; blank ones are dropped. */
  subtasks?: string[]
}

/**
 * Appends one task (with its steps) to the current user's list after the lock, until the review window
 * opens (SPEC §6.2). Final: it can't be edited or removed. Resolves with the task as stored; its
 * addedAt is the device's estimate until the plan's snapshot brings the server time.
 */
export async function addTaskAfterLock(space: Space, weekId: WeekId, input: NewTaskInput): Promise<Task> {
  const uid = requireUser().uid
  const title = input.title.trim()
  if (!title) throw new Error('Give the task a title.')
  if (title.length > MAX_TITLE) throw new Error(LONG_TASK)
  const steps = (input.subtasks ?? []).map(oneLine).filter((step) => step !== '')
  if (steps.length > MAX_SUBTASKS) throw new Error(TOO_MANY_STEPS)
  if (steps.some((step) => step.length > MAX_TITLE)) throw new Error(LONG_STEP)
  const task: Task = { id: newTaskId(), title }
  if (steps.length > 0) task.subtasks = steps.map((step) => ({ id: newTaskId(), title: step }))
  const ref = planRef(space.id, weekId, uid)
  try {
    const bounds = await boundsOf(space, weekId)
    if (now() < bounds.lockAt) throw new Error('Your list hasn’t locked yet. Add the task to it instead.')
    if (now() >= bounds.reviewOpenAt) throw new Error('Adding tasks closes when reviews open on Friday.')
    if (!space.memberIds.includes(uid)) throw new Error('You’re no longer in this space.')
    if (!(await joinWeek(space, weekId))) throw new Error(await notInWeekMessage(space, weekId, uid))
    await runTransaction(getFirebase().db, async (tx) => {
      const snap = await tx.get(ref)
      // Everything already stored goes back exactly as it is: the rules compare it item by item.
      const stored: unknown = snap.get('tasks')
      const existing = Array.isArray(stored) ? stored : []
      if (existing.length >= MAX_TASKS) throw new Error(`You can plan up to ${MAX_TASKS} tasks a week.`)
      const added: unknown = snap.get('added')
      tx.set(ref, {
        tasks: [...existing, encodeTask(task)],
        added: { ...(added && typeof added === 'object' ? added : {}), [task.id]: serverTimestamp() },
        updatedAt: serverTimestamp(),
      })
    })
  } catch (e) {
    throw humanError(e)
  }
  return { ...task, addedAt: Date.now() }
}

/**
 * Self check-off (until deadlineAt). `id` is a task id or a step id. The task's earning, if it has one,
 * follows: earned when the task becomes done (its last step, or the task itself), not when it isn't.
 */
export async function setTaskDone(space: Space, weekId: WeekId, id: string, done: boolean): Promise<void> {
  const uid = requireUser().uid
  try {
    if (now() >= (await boundsOf(space, weekId)).deadlineAt) throw new Error(MSG.closed)
    if (!(await joinWeek(space, weekId))) throw new Error(await notInWeekMessage(space, weekId, uid))
    const ref = progressRef(space.id, weekId, uid)
    const progress = { done: { [id]: done }, updatedAt: serverTimestamp() }
    // Ticking reads only what this device has, so it stays instant and works offline.
    const local = await localWeek(space, weekId, uid)
    const task = local.tasks && taskOf(local.tasks, id)
    const taskDone = task && local.done ? isTaskDone(task, { ...local.done, [id]: done }) : undefined
    const earning = task ? earningId(space.id, weekId, task.id) : null
    const known = earning ? await knownEarning(uid, earning) : null
    const change = known && taskDone !== undefined ? earnedAtChange(known.earned, taskDone) : undefined
    if (change && earning) {
      const batch = writeBatch(getFirebase().db)
      batch.set(ref, progress, { merge: true })
      batch.update(earningRef(uid, earning), change)
      try {
        await batch.commit()
        return
      } catch (e) {
        // The earning may be gone (switched off on another device): the check-off still counts.
        if (!isDenied(e) && errorCode(e) !== 'not-found') throw e
      }
    }
    await setDoc(ref, progress, { merge: true })
    // Whatever this device couldn't tell is settled from the server afterwards.
    if (earning && taskDone !== undefined && known === undefined) settleLater(space.id, weekId, uid, id, { earning, done: taskDone })
    else if (!local.tasks || (task && known !== null && taskDone === undefined)) settleLater(space.id, weekId, uid, id)
  } catch (e) {
    throw humanError(e)
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

/** Writes all of the current user's reviews and marks them submitted, in one batch. Final. */
export async function submitReviews(space: Space, weekId: WeekId, reviews: { revieweeId: UID; marks: Record<string, Mark> }[]): Promise<void> {
  const uid = requireUser().uid
  if (reviews.some((r) => r.revieweeId === uid || !Object.values(r.marks).every(isMark))) throw new Error(MSG.generic)
  const bounds = await boundsOf(space, weekId)
  if (now() < bounds.reviewOpenAt) throw new Error('Reviews open on Friday.')
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
