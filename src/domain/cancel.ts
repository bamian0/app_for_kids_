// Crossing out a task, and undoing it (batch 2.5, SPEC §10.3). Pure: shared by the screens, the data layer and the
// reminders job. "Cancel" is only a code word: the app says "cross out" (verb), "cross-out" (noun), "crossed out".
//
// A plan's `cancels` map is an append-only log, one entry per change: `${n}:${taskId}` → { at, why } for odd n
// (crossed out, with a reason) or { at } for even n (restored), n = 1…5. So a task can be undone at most twice:
// 1 crossed out, 2 restored, 3 crossed out, 4 restored, 5 crossed out for good. decodeCancels (decode.ts) reads it
// into Task.cancel. Changes are only possible while lockAt ≤ now < reviewOpenAt of the task's own list.
import type { FairMark, Task, UID } from './types.ts'

/** A task changes at most 5 times (cross out, undo, cross out, undo, cross out). */
export const CANCEL_MAX_CHANGES = 5
/** At most 2 undos per task; after the second one a new cross-out is final. */
export const CANCEL_MAX_UNDOS = 2
/** A reason is 1–120 characters (UTF-16 units, as the UI counts them), one line. */
export const CANCEL_WHY_MAX = 120
/** The "Fair, Skip It" vote on a crossed-out task, stored in a review's `marks` like a mark (§10.4). */
export const FAIR: FairMark = 'fair'

/** Crossed out now (an odd number of changes). A restored task (2 or 4 changes) is not. */
export function isCancelled(task: Pick<Task, 'cancel'>): boolean {
  return task.cancel?.cancelled === true
}

/** The `cancels` key of a task's change number `change` (1–5). Task ids never contain ':'. */
export function cancelKey(taskId: string, change: number): string {
  return `${change}:${taskId}`
}

/** A reason on one line: line breaks, and runs of spaces around them, become one space; trimmed. */
export function cleanWhy(text: string): string {
  return text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ').trim()
}

export type WhyProblem = 'empty' | 'long'

/** What's wrong with a reason once cleaned (cleanWhy): nothing left, or more than 120 UTF-16 units. */
export function whyProblem(text: string): WhyProblem | null {
  const why = cleanWhy(text)
  if (why === '') return 'empty'
  if (why.length > CANCEL_WHY_MAX) return 'long'
  return null
}

/** The message for a reason's problem: the data layer throws it, the sheet shows it under the field. */
export function whyProblemText(problem: WhyProblem): string {
  return problem === 'empty' ? 'Say why in a few words.' : `Keep the reason to ${CANCEL_WHY_MAX} characters.`
}

export interface CancelOptions {
  /** What the owner can do now: cross it out, undo the cross-out, or nothing (outside the window, or no undo left). */
  action: 'cross-out' | 'undo' | null
  /**
   * Undos left: crossed out now, how many undos remain (2, 1, 0); not crossed out, how many would remain after
   * crossing it out now (2, 1, 0). The sheet shows it in every state and the confirms say it.
   */
  undosLeft: number
  /** The change number the next write uses (cancelKey(task.id, next)): the number of changes so far + 1. */
  next: number
}

/**
 * The owner's options for a task of a list with these stored bounds (the task's own list: a week, or a monthly
 * list). Only the window and the log decide here; paused weeks, judges, membership and someoneCanReview are the
 * caller's to check (§10.5).
 */
export function cancelOptions(task: Pick<Task, 'cancel'>, bounds: { lockAt: number; reviewOpenAt: number }, nowMs: number): CancelOptions {
  const raw = task.cancel?.changes ?? 0
  const changes = Number.isInteger(raw) ? Math.min(Math.max(raw, 0), CANCEL_MAX_CHANGES) : 0
  const crossed = changes % 2 === 1
  const next = changes + 1
  const undosLeft = crossed ? (CANCEL_MAX_CHANGES - changes) / 2 : Math.max(0, (CANCEL_MAX_CHANGES - 1 - changes) / 2)
  const open = bounds.lockAt <= nowMs && nowMs < bounds.reviewOpenAt
  let action: CancelOptions['action'] = null
  if (open && next <= CANCEL_MAX_CHANGES) action = crossed ? (undosLeft > 0 ? 'undo' : null) : 'cross-out'
  return { action, undosLeft, next }
}

/**
 * Someone can vote on `uid`'s cross-out: some member of the period (a week, or a monthly list: its own members,
 * judges included) other than `uid` is still in the space (`memberIds`, the space's current members). False → the
 * sheet hides Cross Out (not Undo): nobody could excuse it, so it could only cost its owner.
 */
export function someoneCanReview(period: { members: UID[] }, memberIds: readonly UID[], uid: UID): boolean {
  return period.members.some((m) => m !== uid && memberIds.includes(m))
}
