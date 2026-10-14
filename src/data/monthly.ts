// Monthly lists (SPEC §9.5): spaces/{id}/monthly/{monthId}, a week-shaped doc with plans, progress and
// reviews, on the month's timeline (first week's start, second week's lock, last week's review window).
// No appends after the lock and no revenue on monthly tasks.
import type { Mark, MonthId, MonthlyData, Space, Task, UID } from '../domain/types.ts'
import type { Start } from './store.ts'

/** Store key of one month's list for one user. */
export function monthlyKey(uid: UID, spaceId: string, monthId: MonthId): string {
  return `${uid}|monthly|${spaceId}|${monthId}`
}

/**
 * Listens to one month's list like watchWeek: the doc, plans, progress and reviews, blind until every
 * member of the list has submitted or its deadline passed, never published revealed with only your own
 * reviews.
 */
export function startMonthly(spaceId: string, monthId: MonthId, uid: UID): Start<MonthlyData> {
  void uid
  // batch2: TODO (until built: no monthly list, which scores exactly as before batch 2)
  return (emit) => {
    emit({ data: { spaceId, monthId, monthly: null, plans: {}, progress: {}, reviews: [] }, loading: false, error: null })
    return () => {}
  }
}

/**
 * Upkeep (ensureSpace): the month's list exists from 8 days before its start until its lock, holds
 * every current member and the space's judges until it locks, and follows a schedule change with a day's
 * notice (its lock = its lock week's, its review window = the last week's). Run by the owner, it also
 * takes out members who left the space while it's unlocked. Best effort, once per key per session.
 */
export function ensureMonthly(space: Space, monthId: MonthId): Promise<void> {
  void space
  void monthId
  // batch2: TODO
  return Promise.resolve()
}

/** Replaces your monthly list, only before its lock. Not for a monthly judge or someone not in the list. */
export async function saveMonthlyPlan(space: Space, monthId: MonthId, tasks: Task[]): Promise<void> {
  void space
  void monthId
  void tasks
  // batch2: TODO
  throw new Error('not implemented: saveMonthlyPlan')
}

/** Ticks a monthly task or step until the list's deadline (no earnings). */
export async function setMonthlyTaskDone(space: Space, monthId: MonthId, id: string, done: boolean): Promise<void> {
  void space
  void monthId
  void id
  void done
  // batch2: TODO
  throw new Error('not implemented: setMonthlyTaskDone')
}

/** Submits your monthly reviews in one batch with the list's submittedBy, inside its review window. */
export async function submitMonthlyReviews(space: Space, monthId: MonthId, reviews: { revieweeId: UID; marks: Record<string, Mark> }[]): Promise<void> {
  void space
  void monthId
  void reviews
  // batch2: TODO
  throw new Error('not implemented: submitMonthlyReviews')
}
