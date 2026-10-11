// Each month's stakes, frozen once the month's first task lists lock, and the upkeep that runs
// whenever a member opens the app (ensureSpace).
import { doc, getDocFromCache, onSnapshot, runTransaction, serverTimestamp } from 'firebase/firestore'
import { now } from '../domain/clock.ts'
import { addWeeks, monthIdForWeek, weekBounds, weekIdFor, weekIdsInMonth } from '../domain/time.ts'
import type { MonthId, MonthStakes, Space } from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import { toMonthStakes, toSpace } from './convert.ts'
import { humanError, MSG } from './errors.ts'
import { claimOwnership } from './spaces.ts'
import type { Start } from './store.ts'
import { ensureWeek } from './weeks.ts'

function monthRef(spaceId: string, monthId: MonthId) {
  return doc(getFirebase().db, 'spaces', spaceId, 'months', monthId)
}

/** The frozen stakes of a month, or null while it isn't frozen. */
export function startMonthStakes(spaceId: string, monthId: MonthId): Start<MonthStakes | null> {
  return (emit) =>
    onSnapshot(
      monthRef(spaceId, monthId),
      (snap) => emit({ data: snap.exists() ? toMonthStakes(snap) : null, loading: false, error: null }),
      (error) => emit({ data: undefined, loading: false, error: humanError(error, MSG.noAccess) }),
    )
}

/** The month the app shows by default: the month of this week's Friday. */
function currentMonth(space: Space, at: number): MonthId {
  return monthIdForWeek(weekIdFor(at, space.timezone))
}

const frozen = new Set<string>()
const freezing = new Map<string, Promise<void>>()

/**
 * Freezes the space's current stakes for the current month once its first task lists have locked:
 * from then on everyone has committed under them, so a later edit only changes months not frozen yet.
 * Before that, edits (a typo right after creating the space) still apply to this month.
 */
export function ensureMonthStakes(space: Space): Promise<void> {
  const at = now()
  let monthId: MonthId
  try {
    monthId = currentMonth(space, at)
    if (at < weekBounds(weekIdsInMonth(monthId)[0], space.timezone).lockAt) return Promise.resolve()
  } catch {
    return Promise.resolve()
  }
  const key = `${space.id}|${monthId}`
  if (frozen.has(key)) return Promise.resolve()
  let pending = freezing.get(key)
  if (!pending) {
    pending = freeze(space.id, monthId)
      .then(() => {
        frozen.add(key)
      })
      .finally(() => freezing.delete(key))
    freezing.set(key, pending)
  }
  return pending
}

async function freeze(spaceId: string, monthId: MonthId): Promise<void> {
  const ref = monthRef(spaceId, monthId)
  if ((await getDocFromCache(ref).catch(() => null))?.exists()) return
  const { db } = getFirebase()
  await runTransaction(db, async (tx) => {
    // The stakes as the rules will see them, not as this screen last saw them.
    const space = await tx.get(doc(db, 'spaces', spaceId))
    if (!space.exists()) return
    if ((await tx.get(ref)).exists()) return
    const { reward, penalty } = toSpace(space)
    tx.set(ref, { reward, penalty, createdAt: serverTimestamp() })
  })
}

/**
 * Upkeep when a member opens the app or a space: this week (until it locks) and next week exist with
 * every current member, the current month's stakes are frozen, and an ownerless space gets an owner.
 * Cheap to call often: each part runs once per session (per member list), and failures are ignored
 * (the next open retries).
 */
export function ensureSpace(space: Space): Promise<void> {
  const uid = getFirebase().auth.currentUser?.uid
  if (!uid || !space.memberIds.includes(uid)) return Promise.resolve()
  let thisWeek: string
  try {
    thisWeek = weekIdFor(now(), space.timezone)
  } catch {
    return Promise.resolve()
  }
  const jobs = [ensureWeek(space, thisWeek), ensureWeek(space, addWeeks(thisWeek, 1)), ensureMonthStakes(space), claimOwnership(space)]
  return Promise.all(jobs.map((job) => job.catch(() => {}))).then(() => {})
}
