// Monthly lists (SPEC §9.5): spaces/{id}/monthly/{monthId}, a week-shaped doc with plans, progress and
// reviews, on the month's timeline (first week's start, second week's lock, last week's review window).
// After the lock a list grows only by appends until its reviews open (SPEC §10.2), for someone who had a
// task on it at its lock. No revenue on monthly tasks.
import {
  arrayRemove,
  arrayUnion,
  doc,
  getDoc,
  getDocFromCache,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  writeBatch,
  type DocumentSnapshot,
} from 'firebase/firestore'
import { isCancelled } from '../domain/cancel.ts'
import { now } from '../domain/clock.ts'
import { isReviewMark } from '../domain/decode.ts'
import { reviewDocId } from '../domain/ids.ts'
import { boundsFor, RETIME_NOTICE_MS, scheduleOf } from '../domain/schedule.ts'
import { judgesOf } from '../domain/scoring.ts'
import { boundsDiffer, monthlyBounds, monthlyWeeks, weekBounds, weekIdsInMonth, type WeekBounds } from '../domain/time.ts'
import type { MonthData, MonthId, MonthlyData, MonthlyList, ReviewMark, Space, Task, UID, Week, WeekData, WeekId } from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import { toMonthly, toPlan, toProgress, toSpace, toWeek } from './convert.ts'
import { CROSSED_OUT_TICK, humanError, MSG } from './errors.ts'
import { requireUser } from './session.ts'
import { requireServer } from './spaces.ts'
import { combine, peek, type Start } from './store.ts'
import { encodeTask } from './tasks.ts'
import {
  appendTask,
  cleanTasks,
  MAX_TASKS,
  NOT_IN_SPACE,
  periodRef,
  rawJudges,
  sameList,
  staleTicks,
  startWeek,
  storedTime,
  taskOf,
  taskToAdd,
  upkeepKey,
  watchPeriod,
  weekKey,
  weekRef,
  type NewTaskInput,
} from './weeks.ts'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** A list can be created from 8 days before its first week starts (the rules' `startAt < request.time + 8d`). */
const CREATE_LEAD_MS = 8 * DAY_MS
/** The upkeep moves a list's bounds only when they are this far off where its weeks put them. */
const RETIME_TOLERANCE_MS = 60_000

export const JUDGING_MONTH = 'You’re judging this month’s lists, so there’s no list to plan.'
const NOT_IN_LIST = 'This month’s list started without you. You’re in from next month.'
const NOT_REVIEW_TIME = 'Monthly lists are reviewed in the month’s last week.'
const ADDS_CLOSED = 'Adding tasks closed when reviews opened.'

/** "October": the month a list is named after in its messages. */
export function monthName(monthId: MonthId): string {
  const [year, month] = monthId.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 15)))
}

function listRef(spaceId: string, monthId: MonthId) {
  return periodRef(spaceId, 'monthly', monthId)
}

function spaceRef(spaceId: string) {
  return doc(getFirebase().db, 'spaces', spaceId)
}

/** Store key of one month's list for one user. */
export function monthlyKey(uid: UID, spaceId: string, monthId: MonthId): string {
  return `${uid}|monthly|${spaceId}|${monthId}`
}

/**
 * Listens to one month's list like watchWeek: the doc, plans, progress and reviews, blind until every
 * member of the list has submitted or its deadline passed, never published revealed with only your own
 * reviews. `boundsMismatch` compares the stored timeline with its weeks' (their stored docs when they
 * exist, else computed on the space's schedule).
 */
export function startMonthly(spaceId: string, monthId: MonthId, uid: UID): Start<MonthlyData> {
  return (emit) => {
    const { lock, last } = monthlyWeeks(monthId)
    const stored = new Map<WeekId, Week | null>()
    return watchPeriod(
      spaceId,
      'monthly',
      monthId,
      uid,
      (parts, boundsMismatch) => ({ spaceId, monthId, monthly: parts.period, plans: parts.plans, progress: parts.progress, reviews: parts.reviews, boundsMismatch }),
      emit,
      {
        mismatch: (space, list) => {
          try {
            return boundsDiffer(list, monthlyBounds(monthId, (w) => boundsFor(space, w, stored.get(w) ?? null)))
          } catch {
            return false
          }
        },
        // The list's lock and review window follow its second and last weeks: watch their docs.
        watch: (space, republish) => {
          const stops = [lock, last].map((weekId) =>
            onSnapshot(
              weekRef(space.id, weekId),
              (snap) => {
                stored.set(weekId, snap.exists() ? toWeek(snap, space.id) : null)
                republish()
              },
              () => {},
            ),
          )
          return () => stops.forEach((stop) => stop())
        },
      },
    )
  }
}

// ---------- The month's data for scores (useMonthData) ----------

/** The month's list can count only from the computed start of the month's last week, so it is loaded from then on. */
export function monthListCounts(space: Pick<Space, 'timezone' | 'schedule'>, monthId: MonthId, nowMs: number): boolean {
  try {
    const weeks = weekIdsInMonth(monthId)
    return nowMs >= boundsFor(space, weeks[weeks.length - 1]).startAt
  } catch {
    return false
  }
}

/** Store key of useMonthData: `|m` with the month's list, `|w` with its weeks alone. */
export function monthDataKey(uid: UID, spaceId: string, monthId: MonthId, withList: boolean): string {
  return `${uid}|month|${spaceId}|${monthId}|${withList ? 'm' : 'w'}`
}

/**
 * Every week of the month (shared with useWeek) and, when `withList`, its list (shared with useMonthly): data
 * once all of them have loaded, the first error otherwise. Creates nothing.
 */
export function startMonthData(spaceId: string, monthId: MonthId, uid: UID, withList: boolean): Start<MonthData> {
  const weeks = weekIdsInMonth(monthId)
  const children: { key: string; start: Start<unknown> }[] = weeks.map((weekId) => ({
    key: weekKey(uid, spaceId, weekId),
    start: startWeek(spaceId, weekId, uid) as Start<unknown>,
  }))
  if (withList) children.push({ key: monthlyKey(uid, spaceId, monthId), start: startMonthly(spaceId, monthId, uid) as Start<unknown> })
  return combine<unknown, MonthData>(children, (states) => {
    const error = states.find((s) => s.error)?.error ?? null
    if (!states.every((s) => s.data !== undefined)) return { data: undefined, loading: error === null, error }
    const data: MonthData = { monthId, weeks: states.slice(0, weeks.length).map((s) => s.data as WeekData) }
    if (withList) data.monthly = states[weeks.length].data as MonthlyData
    return { data, loading: false, error }
  })
}

// ---------- Upkeep ----------

const filled = new Set<string>()
const filling = new Map<string, Promise<void>>()

/**
 * Upkeep (ensureSpace): the month's list exists from 8 days before its start until its lock, holds
 * every current member and the space's judges until it locks, and follows a schedule change with a day's
 * notice (its lock = its lock week's, its review window = the last week's). Run by the owner, it also
 * takes out members who left the space while it's unlocked (an older app's leave leaves them behind), so the
 * monthly reveal isn't held up until the deadline. Best effort, once per key per session; one retry.
 */
export function ensureMonthly(space: Space, monthId: MonthId): Promise<void> {
  const me = getFirebase().auth.currentUser?.uid
  // The rules anchor a list to utcOffsetMin: a space without it gets no monthly list.
  if (!me || !space.memberIds.includes(me) || typeof space.utcOffsetMin !== 'number') return Promise.resolve()
  const key = `${me}|${space.id}|${monthId}|${[...space.memberIds].sort().join(',')}|${upkeepKey(space)}|${space.ownerId}`
  if (filled.has(key)) return Promise.resolve()
  let pending = filling.get(key)
  if (!pending) {
    pending = fillMonthly(space, monthId)
      .then(() => {
        filled.add(key)
      })
      .finally(() => filling.delete(key))
    filling.set(key, pending)
  }
  return pending
}

/** The parts of a stored list that should move to `expected` now (each under a day's notice), or null. */
export function listRetime(
  list: Pick<MonthlyList, 'lockAt' | 'reviewOpenAt' | 'deadlineAt'>,
  expected: WeekBounds,
  nowMs: number,
  opts: { toleranceMs: number; reviewMovable: boolean },
): { lock: boolean; review: boolean } | null {
  const off = (a: number, b: number) => Math.abs(a - b) > opts.toleranceMs
  const lock = off(list.lockAt, expected.lockAt) && list.lockAt - nowMs >= RETIME_NOTICE_MS && expected.lockAt - nowMs >= RETIME_NOTICE_MS
  const review =
    opts.reviewMovable &&
    (off(list.reviewOpenAt, expected.reviewOpenAt) || off(list.deadlineAt, expected.deadlineAt)) &&
    list.reviewOpenAt - nowMs >= RETIME_NOTICE_MS &&
    expected.reviewOpenAt - nowMs >= RETIME_NOTICE_MS
  return lock || review ? { lock, review } : null
}

/**
 * Whether the review part of a list may move without its last week's doc: the rules then check its anchors,
 * and only while that week could still be created (before its lock, with an hour of slack each way).
 */
export function reviewMovableWithoutDoc(space: Pick<Space, 'timezone' | 'schedule'>, monthId: MonthId, nowMs: number): boolean {
  const { last } = monthlyWeeks(monthId)
  return nowMs < weekBounds(last, space.timezone, scheduleOf(space)).lockAt - 2 * HOUR_MS
}

/** The fields of a list retime: the moving parts, as the weeks' stored Timestamps where they come from one. */
export function listRetimePatch(
  parts: { lock: boolean; review: boolean },
  expected: WeekBounds,
  lockSnap: DocumentSnapshot | null,
  lastSnap: DocumentSnapshot | null,
): Record<string, Timestamp> {
  const patch: Record<string, Timestamp> = {}
  if (parts.lock) patch.lockAt = storedTime(lockSnap, 'lockAt', expected.lockAt)
  if (parts.review) {
    patch.reviewOpenAt = storedTime(lastSnap, 'reviewOpenAt', expected.reviewOpenAt)
    patch.deadlineAt = storedTime(lastSnap, 'deadlineAt', expected.deadlineAt)
  }
  return patch
}

async function fillMonthly(space: Space, monthId: MonthId): Promise<void> {
  // Nothing can exist yet this early.
  const computed = monthlyBounds(monthId, (w) => boundsFor(space, w))
  if (computed.startAt - now() >= CREATE_LEAD_MS) return
  const { db } = getFirebase()
  const me = requireUser().uid
  const { first, lock, last } = monthlyWeeks(monthId)
  const ref = listRef(space.id, monthId)
  // A locked list can only have its review window moved, with a day's notice: nothing to do once that's past.
  const cached = await getDocFromCache(ref).catch(() => null)
  if (cached?.exists()) {
    const list = toMonthly(cached, space.id)
    if (now() >= list.lockAt && list.reviewOpenAt - now() < RETIME_NOTICE_MS) return
  }
  /** One write at most (no rule branch allows two kinds at once); true when another step may follow. */
  const step = () =>
    runTransaction(db, async (tx) => {
      const spaceSnap = await tx.get(spaceRef(space.id))
      if (!spaceSnap.exists()) return false
      const fresh = toSpace(spaceSnap)
      if (!fresh.memberIds.includes(me) || typeof fresh.utcOffsetMin !== 'number') return false
      const [listSnap, firstSnap, lockSnap, lastSnap] = await Promise.all([
        tx.get(ref),
        tx.get(weekRef(space.id, first)),
        tx.get(weekRef(space.id, lock)),
        tx.get(weekRef(space.id, last)),
      ])
      const snaps = new Map<WeekId, DocumentSnapshot>([
        [first, firstSnap],
        [lock, lockSnap],
        [last, lastSnap],
      ])
      const storedWeek = (w: WeekId) => {
        const snap = snaps.get(w)
        return snap?.exists() ? toWeek(snap, space.id) : null
      }
      const expected = monthlyBounds(monthId, (w) => boundsFor(fresh, w, storedWeek(w)))
      const judges = rawJudges(spaceSnap) ?? []
      const at = now()
      if (!listSnap.exists()) {
        if (at >= expected.lockAt || expected.startAt - at >= CREATE_LEAD_MS) return false
        tx.set(ref, {
          startAt: storedTime(firstSnap, 'startAt', expected.startAt),
          ...listRetimePatch({ lock: true, review: true }, expected, lockSnap, lastSnap),
          members: fresh.memberIds,
          judges,
          submittedBy: [],
        })
        return false
      }
      const list = toMonthly(listSnap, space.id)
      const parts = listRetime(list, expected, at, {
        toleranceMs: RETIME_TOLERANCE_MS,
        reviewMovable: lastSnap.exists() || reviewMovableWithoutDoc(fresh, monthId, at),
      })
      if (parts) {
        tx.update(ref, listRetimePatch(parts, expected, lockSnap, lastSnap))
        return true
      }
      if (at >= list.lockAt) return false
      // The owner takes out someone who left the space with an older app (one at a time, as the rules allow).
      if (fresh.ownerId === me) {
        const gone = list.members.find((uid) => !fresh.memberIds.includes(uid))
        if (gone) {
          tx.update(ref, { members: arrayRemove(gone) })
          return true
        }
      }
      const missing = fresh.memberIds.filter((uid) => !list.members.includes(uid))
      if (missing.length > 0) tx.update(ref, { members: arrayUnion(...missing), judges })
      else if (!sameList(rawJudges(listSnap), judges)) tx.update(ref, { judges })
      return false
    })
  const run = async () => {
    for (let i = 0; i < 10 && (await step()); i++) {
      // Each pass writes one thing; the next one picks up from it.
    }
  }
  try {
    await run()
  } catch {
    // Most likely a friend wrote it at the same moment; this run picks up from what they wrote.
    await run()
  }
}

// ---------- Writes ----------

/** The month's list as this device has it (cache, else one read); null when there is none. */
async function storedList(space: Space, monthId: MonthId): Promise<MonthlyList | null> {
  const ref = listRef(space.id, monthId)
  const snap = (await getDocFromCache(ref).catch(() => null)) ?? (await getDoc(ref).catch(() => null))
  return snap?.exists() ? toMonthly(snap, space.id) : null
}

/** The list after making sure it holds every current member (while it can); the server's copy when the cached one lacks `uid`. */
async function joinMonthly(space: Space, monthId: MonthId, uid: UID): Promise<MonthlyList | null> {
  await ensureMonthly(space, monthId).catch(() => {})
  const cached = await storedList(space, monthId)
  if (cached?.members.includes(uid)) return cached
  const snap = await getDoc(listRef(space.id, monthId))
  return snap.exists() ? toMonthly(snap, space.id) : null
}

function planRef(spaceId: string, monthId: MonthId, uid: UID) {
  return doc(listRef(spaceId, monthId), 'plans', uid)
}

function progressRef(spaceId: string, monthId: MonthId, uid: UID) {
  return doc(listRef(spaceId, monthId), 'progress', uid)
}

/** Replaces your monthly list, only before its lock. Not for a monthly judge or someone not in the list. */
export async function saveMonthlyPlan(space: Space, monthId: MonthId, tasks: Task[]): Promise<void> {
  const clean = cleanTasks(tasks, 'month')
  const uid = requireUser().uid
  try {
    const list = await joinMonthly(space, monthId, uid)
    const lockAt = list?.lockAt ?? monthlyBounds(monthId, (w) => boundsFor(space, w)).lockAt
    if (now() >= lockAt) throw new Error(MSG.closed)
    if (!list) throw new Error(MSG.generic)
    if (!list.members.includes(uid)) throw new Error(NOT_IN_LIST)
    if (judgesOf(list).includes(uid)) throw new Error(JUDGING_MONTH)
    await setDoc(planRef(space.id, monthId, uid), { tasks: clean.map(encodeTask), updatedAt: serverTimestamp() })
  } catch (e) {
    throw humanError(e)
  }
}

/**
 * Appends one task (with its steps) to your monthly list after its lock, until its reviews open (SPEC §10.2), like
 * addTaskAfterLock for a week: final, at most 25 tasks, `added[id]` the server time, the plan updated (never set) so
 * its cross-outs stay. Only a list that had a task at its lock grows. An id already on the list resolves without
 * writing. Resolves with the task (`addedAt` the device's estimate until the snapshot). Fails at once offline.
 */
export async function addMonthlyTaskAfterLock(space: Space, monthId: MonthId, input: NewTaskInput): Promise<Task> {
  const uid = requireUser().uid
  const task = taskToAdd(input)
  const month = monthName(monthId)
  const noList = `You had no ${month} list when it locked, so there’s nothing to add to.`
  const ref = planRef(space.id, monthId, uid)
  try {
    let list = await storedList(space, monthId)
    const bounds = list ?? monthlyBounds(monthId, (w) => boundsFor(space, w))
    if (now() < bounds.lockAt) throw new Error(`Your ${month} list hasn’t locked yet. Add the task to it instead.`)
    if (now() >= bounds.reviewOpenAt) throw new Error(ADDS_CLOSED)
    if (!space.memberIds.includes(uid)) throw new Error(NOT_IN_SPACE)
    // Nobody opened the app while the list could be made: nobody had one at its lock.
    if (!list) throw new Error(noList)
    if (!list.members.includes(uid)) {
      // The cached copy may be older than the server's.
      const snap = await getDoc(listRef(space.id, monthId))
      list = snap.exists() ? toMonthly(snap, space.id) : list
      if (!list.members.includes(uid)) throw new Error(NOT_IN_LIST)
    }
    if (judgesOf(list).includes(uid)) throw new Error(JUDGING_MONTH)
    await requireServer(uid)
    await runTransaction(getFirebase().db, async (tx) => {
      const snap = await tx.get(ref)
      const stored: unknown = snap.get('tasks')
      const ids = Array.isArray(stored) ? stored.map((t) => (t as { id?: unknown } | null)?.id) : []
      if (ids.includes(task.id)) return
      // A list grows only for someone who had a task on it at its lock (the rules' minBefore 1).
      if (ids.length === 0) throw new Error(noList)
      appendTask(tx, ref, snap, task, `Your ${month} list can have up to ${MAX_TASKS} tasks.`)
    })
  } catch (e) {
    throw humanError(e)
  }
  return { ...task, addedAt: Date.now() }
}

/** Your monthly plan and check-offs as this device has them (cache, else the open list); undefined when it can't tell. */
async function localList(space: Space, monthId: MonthId, uid: UID): Promise<{ tasks?: Task[]; done?: Record<string, boolean> }> {
  const fromCache = (ref: ReturnType<typeof planRef>) => getDocFromCache(ref).catch(() => null)
  const [plan, progress] = await Promise.all([fromCache(planRef(space.id, monthId, uid)), fromCache(progressRef(space.id, monthId, uid))])
  const live = peek<MonthlyData>(monthlyKey(uid, space.id, monthId)).data
  return {
    tasks: plan ? (plan.exists() ? toPlan(plan).tasks : []) : live && (live.plans[uid]?.tasks ?? []),
    done: progress ? (progress.exists() ? toProgress(progress).done : {}) : live && (live.progress[uid]?.done ?? {}),
  }
}

/** Check-offs in progress, by user and list (see setMonthlyTaskDone). */
const ticking = new Map<string, Promise<void>>()

/**
 * Ticks a monthly task or step until the list's deadline (no earnings). One check-off of a list at a time on
 * this device until its write is issued, like setTaskDone; a full list of steps makes room by clearing ticks
 * of deleted tasks. A task crossed out on this device's copy of the plan, or a step of one, isn't ticked.
 */
export async function setMonthlyTaskDone(space: Space, monthId: MonthId, id: string, done: boolean): Promise<void> {
  const uid = requireUser().uid
  const key = `${uid}|${space.id}|m:${monthId}`
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
    const list = await storedList(space, monthId)
    if (!list || now() >= list.deadlineAt) throw new Error(MSG.closed)
    if (!list.members.includes(uid)) throw new Error(NOT_IN_LIST)
    const local = await localList(space, monthId, uid)
    const task = local.tasks && taskOf(local.tasks, id)
    if (task && isCancelled(task)) throw new Error(CROSSED_OUT_TICK)
    const write = setDoc(progressRef(space.id, monthId, uid), { done: { ...staleTicks(local, id), [id]: done }, updatedAt: serverTimestamp() }, { merge: true })
    release()
    await write
  } catch (e) {
    throw humanError(e)
  } finally {
    release()
  }
}

/** Submits your monthly reviews in one batch with the list's submittedBy, inside its review window. A crossed-out
 *  task's mark is 'fair' (Fair, Skip It) or 0 (Not Done), SPEC §10.4. */
export async function submitMonthlyReviews(space: Space, monthId: MonthId, reviews: { revieweeId: UID; marks: Record<string, ReviewMark> }[]): Promise<void> {
  const uid = requireUser().uid
  if (reviews.some((r) => r.revieweeId === uid || !Object.values(r.marks).every(isReviewMark))) throw new Error(MSG.generic)
  const list = await storedList(space, monthId)
  if (!list) throw new Error(NOT_REVIEW_TIME)
  if (now() < list.reviewOpenAt) throw new Error(NOT_REVIEW_TIME)
  if (now() >= list.deadlineAt) throw new Error(MSG.closed)
  const ref = listRef(space.id, monthId)
  const batch = writeBatch(getFirebase().db)
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
