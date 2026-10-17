// Crossed-out tasks in words (SPEC §10.5): the badges and lines, the task sheet's footers and confirms, the vote
// summary and the counts the cards show. Pure, so the copy is unit-tested without a DOM. "Cancel" is a code word
// only: the app says "cross out" (verb), "cross-out" (noun) and "crossed out" (state).
import { someoneCanReview } from '../../domain/cancel.ts'
import { isWeekPaused } from '../../domain/pause.ts'
import { judgesOf } from '../../domain/scoring.ts'
import type { MemberWeekResult, TaskResult } from '../../domain/scoring.ts'
import type { ReviewMark, Space, TaskCancel, UID, Week } from '../../domain/types.ts'
import { monthDayIn, weekdayIn } from './marks.ts'

/** Which kind of list a task is on: a week's (dates as weekdays) or a monthly list's (dates as "Oct 24"). */
export type ListKind = 'week' | 'month'

/** A reason as the lists show it: in curly quotes. */
export function quoted(why: string): string {
  return `“${why}”`
}

/** The badge on a crossed-out task: "Crossed out Wed", or on a monthly list "Crossed out Oct 24". */
export function crossedOutBadge(at: number, timezone: string, kind: ListKind): string {
  return `Crossed out ${kind === 'month' ? monthDayIn(at, timezone) : weekdayIn(at, timezone)}`
}

/** The sheet's and the review sheet's line: "Crossed out Wednesday", or "Crossed out October 24". */
export function crossedOutLine(at: number, timezone: string, kind: ListKind): string {
  return `Crossed out ${kind === 'month' ? monthDayIn(at, timezone, true) : weekdayIn(at, timezone, true)}`
}

const CROSS_OUT_WHY = 'For when something outside your control gets in the way. Friends see your reason and decide on review day if it’s fair to skip it.'

/** The footer under Cross Out Task, with the undos that would be left after crossing it out now (2, 1 or 0). */
export function crossOutFooter(undosLeft: number): string {
  if (undosLeft >= 2) return `${CROSS_OUT_WHY} You can undo it twice.`
  if (undosLeft === 1) return `${CROSS_OUT_WHY} You have 1 undo left.`
  return `${CROSS_OUT_WHY} If you cross it out again, it’s final.`
}

/** The alert before crossing a task out. `undosLeft`: what is left after it (2, 1, 0). */
export function crossOutConfirm(title: string, undosLeft: number): { title: string; message: string } {
  const base = 'Friends see it crossed out with your reason, and on review day they decide if it’s fair to skip it.'
  let tail = ' This one is final: you’ve used both undos.'
  if (undosLeft >= 2) tail = ' You can undo this twice until reviews open.'
  else if (undosLeft === 1) tail = ' You can undo this once more until reviews open.'
  return { title: `Cross out ${quoted(title)}?`, message: base + tail }
}

/** The alert before undoing a cross-out. `undosLeftAfter`: the undos left once this one is used (1 or 0). */
export function undoConfirm(title: string, undosLeftAfter: number): { title: string; message: string } {
  const tail = undosLeftAfter >= 1 ? ' You’ll have 1 undo left.' : ' That’s your last undo: if you cross it out again, it’s final.'
  return { title: 'Undo the cross-out?', message: `${quoted(title)} counts again and you can tick it.${tail}` }
}

/** The footer under a crossed-out task's Undo Cross Out row (`undosLeft` 2 or 1), or once no undo is left (0).
 *  `whenText`: when reviews open, in words. */
export function undoFooter(undosLeft: number, whenText: string): string {
  if (undosLeft >= 2) return `You can undo this twice, until reviews open ${whenText}.`
  if (undosLeft === 1) return `You can undo this once more, until reviews open ${whenText}.`
  return 'This is final. Friends decide on review day if it’s fair to skip it.'
}

/** The footer of a crossed-out task's section in your sheet: the undos left while it can change, else why not. */
export function crossedOutFooter(undosLeft: number, reviewsOpened: boolean, whenText: string): string {
  return reviewsOpened ? 'Reviews have opened, so this can’t change anymore.' : undoFooter(undosLeft, whenText)
}

/** How many reviewers voted fair on a crossed-out task: "2 of 3 said fair". `reviewers`: everyone who reviewed the person. */
export function voteSummary(task: Pick<TaskResult, 'fairBy'>, reviewers: number): string {
  return `${task.fairBy?.length ?? 0} of ${reviewers} said fair`
}

/** Crossed out now. */
export function crossedOut(task: { cancel?: TaskCancel }): boolean {
  return task.cancel?.cancelled === true
}

/** A member's tasks as the cards count them: those not crossed out (`open`), done among them, and crossed out. */
export function openCount(member: Pick<MemberWeekResult, 'tasks'>): { open: number; done: number; crossed: number } {
  const open = member.tasks.filter((t) => !crossedOut(t))
  return { open: open.length, done: open.filter((t) => t.selfDone).length, crossed: member.tasks.length - open.length }
}

/**
 * A card's "how it's going" line before the reveal, without crossed-out tasks (they don't count yet): "2 of 3 done",
 * "2 of 3 done · 1 crossed out, not counted yet", "Crossed out, not counted yet" (the only task), "All 3 crossed out,
 * not counted yet". In a paused week nothing counts at all, so it just says what's crossed out.
 */
export function doneLine(member: Pick<MemberWeekResult, 'tasks'>, paused = false): string {
  const { open, done, crossed } = openCount(member)
  const n = open + crossed
  const note = paused ? '' : ', not counted yet'
  if (crossed === 0) return `${done} of ${n} done`
  if (open === 0) return n === 1 ? `Crossed out${note}` : `All ${n} crossed out${note}`
  return `${done} of ${open} done · ${crossed} crossed out${note}`
}

/** " · 1 skipped" after a revealed card's subtitle when friends excused some of its tasks; "" otherwise. */
export function skippedSuffix(member: Pick<MemberWeekResult, 'excusedCount'>): string {
  const n = member.excusedCount ?? 0
  return n > 0 ? ` · ${n} skipped` : ''
}

/** A whole period friends excused: the card's subtitle instead of the reviewers. */
export const SKIPPED_PERIOD = 'Skipped: friends said fair'

/**
 * A crossed-out task's row once results are in: the reason and the vote ("“The pool is closed” · 2 of 3 said fair")
 * with **Skipped** or **Not done**; with nobody's review, the reason and its check-off as today ("· Checked off").
 */
export function crossedOutResult(task: TaskResult, reviewers: number): { subtitle: string; detail?: 'Skipped' | 'Not done' } {
  const why = task.cancel ? quoted(task.cancel.why) : ''
  const join = (s: string) => (why ? `${why} · ${s}` : s)
  if (task.source === 'self') {
    const steps = task.subtasks
    const ticked = steps.filter((s) => s.done).length
    return { subtitle: join(steps.length > 0 ? `${ticked} of ${steps.length} steps ticked` : task.selfDone ? 'Checked off' : 'Not checked off') }
  }
  return { subtitle: join(voteSummary(task, reviewers)), detail: task.excused ? 'Skipped' : 'Not done' }
}

/** The review sheet's note under the vote: what a fair vote means for `name`. */
export function voteNote(name: string): string {
  return `If most reviewers say it’s fair, it doesn’t count for ${name}. If not, it counts as not done.`
}

/**
 * A draft mark still fits the task as it is now: the vote ('fair' or Not Done, 0) on a crossed-out task, Done, Half
 * or Not done on any other. A draft from before a cross-out or an undo that no longer fits counts as unmarked.
 */
export function draftFits(crossed: boolean, mark: ReviewMark | undefined | null): mark is ReviewMark {
  if (mark === undefined || mark === null) return false
  return crossed ? mark === 'fair' || mark === 0 : mark === 0 || mark === 0.5 || mark === 1
}

export interface CrossOutGate {
  /** The sheet may offer Cross Out Task (when the task's state and window allow it). */
  crossOut: boolean
  /** The sheet may offer Undo Cross Out. */
  undo: boolean
}

/**
 * Who may change a task's cross-out, from the task's own list (SPEC §10.3, §10.5): a player of that period (not
 * its judge) who is still in the space. A week: no Cross Out while it is paused (Undo stays). A monthly list: only
 * its own members and judges decide, never a pause or this week's judges. Cross Out also needs someone else in the
 * period who is still in the space to vote on it (`someoneCanReview`); Undo doesn't. The window and the undos
 * left are `cancelOptions`' to decide.
 */
export function crossOutGate(
  period: Pick<Week, 'id' | 'members' | 'judges'> | null,
  kind: ListKind,
  space: Pick<Space, 'memberIds' | 'paused'>,
  me: UID,
): CrossOutGate {
  if (!period || !period.members.includes(me) || judgesOf(period).includes(me) || !space.memberIds.includes(me)) return { crossOut: false, undo: false }
  const paused = kind === 'week' && isWeekPaused(space, period.id)
  return { crossOut: !paused && someoneCanReview(period, space.memberIds, me), undo: true }
}
