// A space's own times (SPEC §9.2): the owner's change, which also moves the weeks and monthly lists
// that haven't locked onto the new times in the same transaction.
import { doc, getDocFromServer, runTransaction, serverTimestamp, type DocumentSnapshot } from 'firebase/firestore'
import { now } from '../domain/clock.ts'
import { boundsFor, needsRetime, sameSchedule, scheduleOf, scheduleProblem, scheduleProblemText, scheduleStartsWith } from '../domain/schedule.ts'
import { addWeeks, DEFAULT_SCHEDULE, monthIdForWeek, monthlyBounds, monthlyWeeks, weekBounds, weekIdFor, type WeekBounds } from '../domain/time.ts'
import type { MonthId, Space, Week, WeekId, WeekSchedule } from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import { toMonthly, toSpace, toWeek } from './convert.ts'
import { humanError, isDenied, MSG } from './errors.ts'
import { listRetime, listRetimePatch, reviewMovableWithoutDoc } from './monthly.ts'
import { requireUser } from './session.ts'
import { requireServer } from './spaces.ts'
import { boundsData, ensureWeek, periodRef, scheduleField, weekRef } from './weeks.ts'

const ONLY_OWNER = 'Only the owner can change the times.'
const FAILED = 'Couldn’t change the times. Try again.'

function spaceRef(spaceId: string) {
  return doc(getFirebase().db, 'spaces', spaceId)
}

/** The schedule map exactly as the space stores it (the rules compare `before` with it), else the usual one. */
function storedSchedule(snap: DocumentSnapshot): WeekSchedule {
  const s: unknown = snap.get('schedule')
  return s && typeof s === 'object' ? (s as WeekSchedule) : { ...DEFAULT_SCHEDULE }
}

/**
 * The owner sets the space's times (null = back to the usual ones). Validated with scheduleProblem
 * first (its scheduleProblemText is the message). Fails at once offline, never queued. Makes sure this
 * week's and next week's docs exist first (on the old times), then one transaction: the space's
 * `schedule` (deleted for the usual times) and `scheduleNote`, plus each of those week docs whose lists
 * lock at least a day away on both the old and new times (needsRetime), and the monthly lists of this
 * month and next week's month, each part (lock, review window) moved only under the same day's notice.
 * Resolves with the first week on the new times (this week, next week or the week after); an unchanged
 * schedule writes nothing. Non-owner: "Only the owner can change the times."
 */
export async function setSchedule(spaceId: string, schedule: WeekSchedule | null): Promise<{ fromWeek: WeekId }> {
  const next: WeekSchedule = schedule ? { lock: schedule.lock, reviewOpen: schedule.reviewOpen, deadline: schedule.deadline } : { ...DEFAULT_SCHEDULE }
  const problem = scheduleProblem(next)
  if (problem) throw new Error(scheduleProblemText(problem, next))
  const me = requireUser().uid
  await requireServer(me)
  let space: Space
  try {
    const snap = await getDocFromServer(spaceRef(spaceId))
    if (!snap.exists()) throw new Error(MSG.noAccess)
    space = toSpace(snap)
  } catch (e) {
    throw humanError(e, MSG.noAccess)
  }
  if (space.ownerId !== me || !space.memberIds.includes(me)) throw new Error(ONLY_OWNER)
  const thisWeek = weekIdFor(now(), space.timezone)
  const nextWeek = addWeeks(thisWeek, 1)
  if (sameSchedule(space.schedule, next)) return { fromWeek: scheduleStartsWith(space, next, {}, now()) }
  // Both weeks exist on the old times first, so none is ever created on the new times with less than a day's notice.
  await Promise.all([ensureWeek(space, thisWeek), ensureWeek(space, nextWeek)].map((p) => p.catch(() => {})))
  const attempt = () => runTransaction(getFirebase().db, (tx) => retime(tx, spaceId, me, next, thisWeek, nextWeek))
  try {
    return await attempt()
  } catch (e) {
    if (!isDenied(e)) throw humanError(e, FAILED)
  }
  try {
    // A lock may have passed between this device's clock and the server's: decide again.
    return await attempt()
  } catch (e) {
    throw isDenied(e) ? new Error(FAILED, { cause: e }) : humanError(e, FAILED)
  }
}

type Tx = Parameters<Parameters<typeof runTransaction>[1]>[0]

async function retime(tx: Tx, spaceId: string, me: string, next: WeekSchedule, thisWeek: WeekId, nextWeek: WeekId): Promise<{ fromWeek: WeekId }> {
  const spaceSnap = await tx.get(spaceRef(spaceId))
  if (!spaceSnap.exists()) throw new Error(MSG.noAccess)
  const fresh = toSpace(spaceSnap)
  if (fresh.ownerId !== me || !fresh.memberIds.includes(me)) throw new Error(ONLY_OWNER)
  const at = now()
  // Reads first (a transaction writes after all its reads): both weeks, then each list with the weeks it follows.
  const weekSnaps = new Map<WeekId, DocumentSnapshot>()
  const readWeek = async (weekId: WeekId) => {
    if (!weekSnaps.has(weekId)) weekSnaps.set(weekId, await tx.get(weekRef(spaceId, weekId)))
    return weekSnaps.get(weekId) as DocumentSnapshot
  }
  const stored = (snap: DocumentSnapshot): Week | null => (snap.exists() ? toWeek(snap, spaceId) : null)
  const weeks = { thisWeek: stored(await readWeek(thisWeek)), nextWeek: stored(await readWeek(nextWeek)) }
  for (const [weekId, week] of [
    [thisWeek, weeks.thisWeek],
    [nextWeek, weeks.nextWeek],
  ] as const) {
    // Still missing while its lists can change: it would be created on the new times without a day's notice.
    if (!week && at < boundsFor(fresh, weekId).lockAt) throw new Error(MSG.generic)
  }
  const months = [...new Set([monthIdForWeek(thisWeek), monthIdForWeek(nextWeek)])]
  const lists = new Map<MonthId, DocumentSnapshot>()
  for (const monthId of months) {
    const listSnap = await tx.get(periodRef(spaceId, 'monthly', monthId))
    if (!listSnap.exists()) continue
    lists.set(monthId, listSnap)
    const { first, lock, last } = monthlyWeeks(monthId)
    for (const weekId of [first, lock, last]) await readWeek(weekId)
  }

  const after: Space = { ...fresh, schedule: next }
  const fromWeek = scheduleStartsWith(fresh, next, weeks, at)
  tx.update(spaceRef(spaceId), {
    schedule: scheduleField(next),
    scheduleNote: { by: me, at: serverTimestamp(), fromWeek, before: storedSchedule(spaceSnap) },
  })
  /** Each week's bounds once this transaction is written: retimed, stored, or computed on the new times. */
  const moved = new Map<WeekId, WeekBounds>()
  for (const [weekId, week] of [
    [thisWeek, weeks.thisWeek],
    [nextWeek, weeks.nextWeek],
  ] as const) {
    const bounds = week ? needsRetime(after, week, at) : null
    if (!week || !bounds) continue
    moved.set(weekId, bounds)
    tx.update(weekRef(spaceId, weekId), { ...boundsData(bounds), schedule: scheduleField(next) })
  }
  const boundsAfter = (weekId: WeekId): WeekBounds => {
    const retimed = moved.get(weekId)
    if (retimed) return retimed
    const snap = weekSnaps.get(weekId)
    return snap?.exists() ? toWeek(snap, spaceId) : weekBounds(weekId, after.timezone, scheduleOf(after))
  }
  for (const [monthId, listSnap] of lists) {
    const list = toMonthly(listSnap, spaceId)
    const expected = monthlyBounds(monthId, boundsAfter)
    const { lock, last } = monthlyWeeks(monthId)
    const lastKnown = moved.has(last) || weekSnaps.get(last)?.exists() === true
    const parts = listRetime(list, expected, at, { toleranceMs: 0, reviewMovable: lastKnown || reviewMovableWithoutDoc(after, monthId, at) })
    if (!parts) continue
    // A retimed week's new bounds are new Timestamps; a stored week's are its own.
    const lockSnap = moved.has(lock) ? null : (weekSnaps.get(lock) ?? null)
    const lastSnap = moved.has(last) ? null : (weekSnaps.get(last) ?? null)
    tx.update(periodRef(spaceId, 'monthly', monthId), listRetimePatch(parts, expected, lockSnap, lastSnap))
  }
  return { fromWeek }
}
