// Review marks in words.
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
