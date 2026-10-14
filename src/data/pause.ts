// Pausing a week (SPEC §9.3). Everything lives on the space doc (`pause`, `paused`), so screens learn
// the state from useSpace with no extra reads. Every write is a transaction that fails at once offline.
import type { Space, WeekId } from '../domain/types.ts'

/**
 * Asks to pause `weekId`: this week while its reviews open more than a day from now, or next week. Makes
 * sure the week doc exists first. When nobody else in the week needs to say OK, the week is paused at once
 * ('paused'); else 'asked'. Refused with a plain message (month used, reviews too close or open, a request
 * pending, asked within 12 hours).
 */
export async function askToPause(space: Space, weekId: WeekId): Promise<'asked' | 'paused'> {
  void space
  void weekId
  // batch2: TODO
  throw new Error('not implemented: askToPause')
}

/** OK or Not Now to the pending request. Resolves with what the request became. */
export async function answerPause(space: Space, answer: 'ok' | 'not-now'): Promise<'waiting' | 'paused' | 'declined'> {
  void space
  void answer
  // batch2: TODO
  throw new Error('not implemented: answerPause')
}

/** The asker cancels the request (only while it isn't recorded): it stays with declinedBy = the asker. */
export async function withdrawPause(space: Space): Promise<void> {
  void space
  // batch2: TODO
  throw new Error('not implemented: withdrawPause')
}

/**
 * ensureSpace: records a request that everyone still in the space has OK'd (the last holdout left).
 * Returns at once unless pauseNeedsFinalizing. Best effort.
 */
export async function finalizePause(space: Space): Promise<void> {
  void space
  // batch2: TODO (no-op until built: nothing to finalize before pauses exist)
}
