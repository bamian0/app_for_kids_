// Crossing out a task, and undoing that (batch 2.5, SPEC §10.3, §10.6). Both write one entry of the plan's
// append-only `cancels` log (`${n}:${taskId}`, n = 1…5) with the server time, in a transaction that re-reads the
// task's list and your plan, so a retry after a lost answer never writes twice. They fail at once offline (never
// queued: a cross-out decided on stale data could land after reviews open). The ticks they freeze are refused in
// setTaskDone / setMonthlyTaskDone (CROSSED_OUT_TICK). Pauses and whether anyone else can review you
// (someoneCanReview) are the sheet's to check (§10.5); the rules ignore them too.
import { doc, FieldPath, getDocFromServer, runTransaction, serverTimestamp, type DocumentSnapshot } from 'firebase/firestore'
import { cancelKey, cancelOptions, cleanWhy, isCancelled, whyProblem, whyProblemText } from '../domain/cancel.ts'
import { now } from '../domain/clock.ts'
import { judgesOf } from '../domain/scoring.ts'
import type { Period, Space, UID, Week } from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import { toMonthly, toPlan, toSpace, toWeek } from './convert.ts'
import { CROSSED_OUT_TICK, errorCode, humanError, isDenied, MSG } from './errors.ts'
import { JUDGING_MONTH, monthName } from './monthly.ts'
import { requireUser } from './session.ts'
import { requireServer } from './spaces.ts'
import { TASK_ID } from './tasks.ts'
import { NOT_IN_SPACE, periodRef, type PeriodColl } from './weeks.ts'

export { CROSSED_OUT_TICK }

const JUDGING_WEEK = 'You’re judging this week, so there’s no list to plan.'
const REVIEWS_OPEN = 'Reviews have opened, so this can’t change anymore.'
const NO_UNDOS = 'You’ve used both undos for this task.'
const CROSS_OUT_FAILED = 'Couldn’t cross it out. Try again.'
const UNDO_FAILED = 'Couldn’t undo it. Try again.'
/**
 * After a refusal, a list whose reviews open this soon counts as open: the server's clock decided, and this device's
 * may be a little behind it. Refused that close to the end, trying again wouldn't help.
 */
const REVIEW_SLACK_MS = 60_000

const collOf = (period: Period): PeriodColl => (period.kind === 'week' ? 'weeks' : 'monthly')

function toPeriod(snap: DocumentSnapshot, spaceId: string, period: Period): Week {
  return period.kind === 'week' ? toWeek(snap, spaceId) : toMonthly(snap, spaceId)
}

/** Why the period doesn't let `uid` change their tasks at `nowMs` (its stored bounds, judges and members), or null. */
function periodProblem(list: Week, period: Period, uid: UID, nowMs: number, reviewSlackMs = 0): string | null {
  if (nowMs < list.lockAt) {
    const yours = period.kind === 'week' ? 'Your list' : `Your ${monthName(period.id)} list`
    return `${yours} hasn’t locked yet, so you can still delete the task.`
  }
  if (nowMs + reviewSlackMs >= list.reviewOpenAt) return REVIEWS_OPEN
  if (judgesOf(list).includes(uid)) return period.kind === 'week' ? JUDGING_WEEK : JUDGING_MONTH
  // Not in the list: the task can't be yours.
  if (!list.members.includes(uid)) return MSG.generic
  return null
}

/** The message for a refused write: re-checked once against the server's copy of the space and the list. */
async function refusal(space: Space, period: Period, uid: UID, failed: string): Promise<string> {
  try {
    const spaceSnap = await getDocFromServer(doc(getFirebase().db, 'spaces', space.id))
    if (!spaceSnap.exists() || !toSpace(spaceSnap).memberIds.includes(uid)) return NOT_IN_SPACE
    const snap = await getDocFromServer(periodRef(space.id, collOf(period), period.id))
    if (!snap.exists()) return failed
    const problem = periodProblem(toPeriod(snap, space.id, period), period, uid, now(), REVIEW_SLACK_MS)
    return problem === null || problem === MSG.generic ? failed : problem
  } catch (e) {
    // Reading the space is refused once you're not in it.
    return isDenied(e) ? NOT_IN_SPACE : failed
  }
}

/** Our own messages pass; a Firebase error gets its usual message, or `failed` where that would be the generic one. */
function failure(e: unknown, failed: string): Error {
  if (errorCode(e) === undefined) return e instanceof Error ? e : new Error(String(e))
  const error = humanError(e, failed)
  return error.message === MSG.generic ? new Error(failed, { cause: e }) : error
}

/** One change of the task's log: a cross-out (with its cleaned reason) or an undo. */
async function change(space: Space, period: Period, taskId: string, kind: 'cross-out' | 'undo', why: string): Promise<void> {
  const uid = requireUser().uid
  const failed = kind === 'cross-out' ? CROSS_OUT_FAILED : UNDO_FAILED
  if (!TASK_ID.test(taskId)) throw new Error(MSG.generic)
  if (!space.memberIds.includes(uid)) throw new Error(NOT_IN_SPACE)
  await requireServer(uid)
  const listRef = periodRef(space.id, collOf(period), period.id)
  const planRef = doc(listRef, 'plans', uid)
  try {
    await runTransaction(getFirebase().db, async (tx) => {
      const listSnap = await tx.get(listRef)
      const planSnap = await tx.get(planRef)
      if (!listSnap.exists()) throw new Error(MSG.generic)
      const list = toPeriod(listSnap, space.id, period)
      const at = now()
      const problem = periodProblem(list, period, uid, at)
      if (problem) throw new Error(problem)
      const task = planSnap.exists() ? toPlan(planSnap).tasks.find((t) => t.id === taskId) : undefined
      if (!task) throw new Error(MSG.generic)
      // Already done: an earlier attempt went through though its answer was lost, or another device did it.
      if (isCancelled(task) === (kind === 'cross-out')) return
      const options = cancelOptions(task, list, at)
      // In the window (checked above), only the log can say no: the 2nd undo was used.
      if (options.action !== kind) throw new Error(NO_UNDOS)
      const entry = kind === 'cross-out' ? { at: serverTimestamp(), why } : { at: serverTimestamp() }
      tx.update(planRef, new FieldPath('cancels', cancelKey(taskId, options.next)), entry, 'updatedAt', serverTimestamp())
    })
  } catch (e) {
    if (isDenied(e)) throw new Error(await refusal(space, period, uid, failed), { cause: e })
    throw failure(e, failed)
  }
}

/**
 * Crosses out one of your tasks of a locked week or monthly list (`period`, the task's own list), until its reviews
 * open, with a reason: one line, 1–120 characters after cleanWhy. Already crossed out: resolves without writing.
 * Messages in SPEC §10.6.
 */
export async function crossOutTask(space: Space, period: Period, taskId: string, why: string): Promise<void> {
  const reason = cleanWhy(why)
  const problem = whyProblem(reason)
  if (problem) throw new Error(whyProblemText(problem))
  return change(space, period, taskId, 'cross-out', reason)
}

/**
 * Restores a crossed-out task of yours while undos are left (at most 2 per task) and its reviews haven't opened.
 * Not crossed out: resolves without writing. Messages in SPEC §10.6.
 */
export async function undoCrossOut(space: Space, period: Period, taskId: string): Promise<void> {
  return change(space, period, taskId, 'undo', '')
}
