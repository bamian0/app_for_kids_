// Review marks, and the evidence friends judge them by, in words.
import type { Mark, UID } from '../../domain/types.ts'

const MARK_LABEL: Record<string, string> = { '1': 'Done', '0.5': 'Half', '0': 'Not done' }

export function markLabel(mark: Mark): string {
  return MARK_LABEL[String(mark)]
}

/**
 * The marks friends gave one task. Up to two reviewers by name ("Lena: Done · You: Half"); more are
 * summarised so a big space isn't a wall of names: "All 5: Done", or "You: Half · 3 Done · 2 Half".
 */
export function summarizeMarks(marks: [UID, Mark][], me: UID, who: (uid: UID) => string): string {
  if (marks.length <= 2) return marks.map(([reviewer, mark]) => `${who(reviewer)}: ${markLabel(mark)}`).join(' · ')
  const counts = ([1, 0.5, 0] as Mark[]).map((m) => [m, marks.filter(([, x]) => x === m).length] as const).filter(([, n]) => n > 0)
  if (counts.length === 1) return `All ${marks.length}: ${markLabel(counts[0][0])}`
  const parts = counts.map(([m, n]) => `${n} ${markLabel(m)}`)
  const mine = marks.find(([reviewer]) => reviewer === me)
  return [...(mine ? [`You: ${markLabel(mine[1])}`] : []), ...parts].join(' · ')
}

/** The weekday of `ms` on the space's clock: "Wed", or "Wednesday" with `long`. */
export function weekdayIn(ms: number, timezone: string, long = false): string {
  const options: Intl.DateTimeFormatOptions = { weekday: long ? 'long' : 'short' }
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: timezone }).format(ms)
  } catch {
    return new Intl.DateTimeFormat('en-US', options).format(ms)
  }
}

/** The date of `ms` on the space's clock: "Oct 24", or "October 24" with `long`. */
export function monthDayIn(ms: number, timezone: string, long = false): string {
  const options: Intl.DateTimeFormatOptions = { month: long ? 'long' : 'short', day: 'numeric' }
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: timezone }).format(ms)
  } catch {
    return new Intl.DateTimeFormat('en-US', options).format(ms)
  }
}

/** "Added Wed": when a task joined the list after the lock, so friends can judge a late addition. A monthly list
 *  spans weeks, so its badge names the date: "Added Oct 24" (SPEC §10.5). */
export function addedLabel(addedAt: number, timezone: string, kind: 'week' | 'month' = 'week'): string {
  return `Added ${kind === 'month' ? monthDayIn(addedAt, timezone) : weekdayIn(addedAt, timezone)}`
}

/** Steps ticked so far, as the list shows them beside the task: "2/4". */
export function stepCount(steps: { done: boolean }[]): string {
  return `${steps.filter((s) => s.done).length}/${steps.length}`
}
