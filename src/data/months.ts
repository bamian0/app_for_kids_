// Each month's house stakes, frozen once the month is complete (SPEC §9.7), and the upkeep that runs
// whenever a member opens the app (ensureSpace).
import { doc, getDoc, onSnapshot, runTransaction, serverTimestamp, type DocumentSnapshot } from 'firebase/firestore'
import { now } from '../domain/clock.ts'
import { boundsFor } from '../domain/schedule.ts'
import { monthEndsAtFor } from '../domain/scoring.ts'
import { houseFreezeAt, houseFreezeMonths, needsHouseFreeze } from '../domain/stakes.ts'
import { addWeeks, monthIdForWeek, weekIdFor, weekIdsInMonth } from '../domain/time.ts'
import type { MonthId, MonthStakes, Space, WeekId } from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import { toMonthly, toMonthStakes, toSpace, toWeek } from './convert.ts'
import { humanError, MSG } from './errors.ts'
import { ensureMonthly } from './monthly.ts'
import { finalizePause } from './pause.ts'
import { claimOwnership } from './spaces.ts'
import type { Start } from './store.ts'
import { ensureWeek, periodRef, weekRef } from './weeks.ts'

const HOUR_MS = 3_600_000

function monthRef(spaceId: string, monthId: MonthId) {
  return doc(getFirebase().db, 'spaces', spaceId, 'months', monthId)
}

/** The frozen stakes of a month (with when they were frozen), or null while it isn't frozen. */
export function startMonthStakes(spaceId: string, monthId: MonthId): Start<MonthStakes | null> {
  return (emit) =>
    onSnapshot(
      monthRef(spaceId, monthId),
      (snap) => emit({ data: snap.exists() ? toMonthStakes(snap) : null, loading: false, error: null }),
      (error) => emit({ data: undefined, loading: false, error: humanError(error, MSG.noAccess) }),
    )
}

/** What decides a month's freeze: its last week's doc, its list and its freeze, as read (null when missing). */
function freezeState(space: Space, monthId: MonthId, last: DocumentSnapshot | null, list: DocumentSnapshot | null, frozen: DocumentSnapshot | null, nowMs: number) {
  const lastWeek = last?.exists() ? toWeek(last, space.id) : null
  const monthly = list?.exists() ? toMonthly(list, space.id) : null
  const freezeAt = houseFreezeAt(space, monthId, lastWeek, monthly)
  const completeAt = monthEndsAtFor(space, monthId, lastWeek, monthly)
  const stakes = frozen?.exists() ? toMonthStakes(frozen) : null
  return { freezeAt, needed: needsHouseFreeze(monthId, stakes, freezeAt, completeAt, nowMs) }
}

/** Months whose house stakes hold a binding freeze, by space (once there, nothing changes them). */
const settled = new Set<string>()
const freezing = new Map<string, Promise<void>>()

/**
 * Freezes the house stakes of each month the rules check on an owner's edit (houseFreezeMonths: this UTC month
 * and the one before) once the month is complete by its stored last week and list (houseFreezeAt; computed
 * bounds for a missing doc) and holds no binding freeze: a create, or the re-freeze of the previous app's early
 * freeze from FIRST_RESULTS_MONTH on. Until then an owner's edit counts at once for the month in progress.
 * Best effort: failures are ignored and retried on the next open; a month found frozen is remembered for the
 * session.
 */
export function ensureMonthStakes(space: Space): Promise<void> {
  let months: MonthId[]
  try {
    months = houseFreezeMonths(space, now())
  } catch {
    return Promise.resolve()
  }
  return Promise.all(months.map((monthId) => freezeMonth(space, monthId).catch(() => {}))).then(() => {})
}

function freezeMonth(space: Space, monthId: MonthId): Promise<void> {
  const key = `${space.id}|${monthId}`
  if (settled.has(key)) return Promise.resolve()
  const weeks = weekIdsInMonth(monthId)
  const lastId = weeks[weeks.length - 1] as WeekId
  // A month can't be complete before its last week starts (no reads until then).
  if (now() < boundsFor(space, lastId).startAt - HOUR_MS) return Promise.resolve()
  let pending = freezing.get(key)
  if (!pending) {
    pending = freeze(space, monthId, lastId).finally(() => freezing.delete(key))
    freezing.set(key, pending)
  }
  return pending
}

async function freeze(space: Space, monthId: MonthId, lastId: WeekId): Promise<void> {
  const key = `${space.id}|${monthId}`
  const [last, list] = await Promise.all([getDoc(weekRef(space.id, lastId)).catch(() => null), getDoc(periodRef(space.id, 'monthly', monthId)).catch(() => null)])
  // Not complete yet: nothing to read or write.
  if (now() < freezeState(space, monthId, last, list, null, now()).freezeAt) return
  const frozen = await getDoc(monthRef(space.id, monthId))
  if (!freezeState(space, monthId, last, list, frozen, now()).needed) {
    settled.add(key)
    return
  }
  const { db } = getFirebase()
  await runTransaction(db, async (tx) => {
    // The stakes as the rules will see them (the space before this write), not as this screen last saw them.
    const spaceSnap = await tx.get(doc(db, 'spaces', space.id))
    if (!spaceSnap.exists()) return
    const fresh = toSpace(spaceSnap)
    const [f, l, li] = await Promise.all([tx.get(monthRef(space.id, monthId)), tx.get(weekRef(space.id, lastId)), tx.get(periodRef(space.id, 'monthly', monthId))])
    if (!freezeState(fresh, monthId, l, li, f, now()).needed) return
    tx.set(monthRef(space.id, monthId), { reward: fresh.reward, penalty: fresh.penalty, createdAt: serverTimestamp() })
  })
  settled.add(key)
}

/**
 * Upkeep when a member opens the app or a space: this week (until it locks) and next week exist with every
 * current member, the space's judges and its times (a change of times moves them with a day's notice); this
 * month's and next week's month's lists likewise (the owner also takes out members who left); each recently
 * completed month's house stakes are frozen; a pause everyone still in its week has OK'd is recorded; and an
 * ownerless space gets an owner. Cheap to call often: each part runs once per session (per member list,
 * schedule and judges), and failures are ignored (the next open retries).
 */
export function ensureSpace(space: Space): Promise<void> {
  const uid = getFirebase().auth.currentUser?.uid
  if (!uid || !space.memberIds.includes(uid)) return Promise.resolve()
  let thisWeek: WeekId
  try {
    thisWeek = weekIdFor(now(), space.timezone)
  } catch {
    return Promise.resolve()
  }
  const nextWeek = addWeeks(thisWeek, 1)
  const months = [...new Set([monthIdForWeek(thisWeek), monthIdForWeek(nextWeek)])]
  const quietly = (job: Promise<void>) => job.catch(() => {})
  // The lists take their bounds from the weeks' docs, so they follow the weeks.
  const weeksThenLists = Promise.all([ensureWeek(space, thisWeek), ensureWeek(space, nextWeek)].map(quietly)).then(() =>
    Promise.all(months.map((monthId) => quietly(ensureMonthly(space, monthId)))),
  )
  const jobs = [weeksThenLists, ensureMonthStakes(space), finalizePause(space), claimOwnership(space)]
  return Promise.all(jobs.map((job) => quietly(job.then(() => {})))).then(() => {})
}
