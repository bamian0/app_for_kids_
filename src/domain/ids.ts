// Id helpers. STUB: the domain agent implements the bodies (crypto.getRandomValues for randomness).
import type { MonthId, UID } from './types.ts'

export const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** 8 chars from INVITE_ALPHABET. */
export function newInviteCode(): string {
  throw new Error('not implemented')
}

/** Accepts a raw code or a full invite link (`…?join=XXXXXXXX`). Uppercases, strips spaces and dashes.
 *  Returns the 8-char code, or null if it is not 8 chars from INVITE_ALPHABET. */
export function normalizeInviteCode(input: string): string | null {
  throw new Error(`not implemented ${input}`)
}

/** 'ABCD2345' → 'ABCD-2345' */
export function formatInviteCode(code: string): string {
  throw new Error(`not implemented ${code}`)
}

/** Short random id for tasks. */
export function newTaskId(): string {
  throw new Error('not implemented')
}

export function reviewDocId(reviewerId: UID, revieweeId: UID): string {
  return `${reviewerId}_${revieweeId}`
}

export function settlementDocId(monthId: MonthId, uid: UID): string {
  return `${monthId}_${uid}`
}

/** Stable avatar color from a uid, picked from a muted iOS-like palette. */
export function colorForUid(uid: UID): string {
  throw new Error(`not implemented ${uid}`)
}
