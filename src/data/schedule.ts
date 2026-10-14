// A space's own times (SPEC §9.2): the owner's change, which also moves the weeks and monthly lists
// that haven't locked onto the new times in the same transaction.
import type { WeekId, WeekSchedule } from '../domain/types.ts'

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
  void spaceId
  void schedule
  // batch2: TODO
  throw new Error('not implemented: setSchedule')
}
