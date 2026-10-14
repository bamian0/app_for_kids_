// Id helpers: invite codes, task ids, Firestore doc ids, avatar colors.
import type { MonthId, UID } from './types.ts'

export const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const INVITE_CODE_LENGTH = 8
/** Steps per task. 25 tasks × 8 steps stays within a progress doc's 200 check-off keys. */
export const MAX_SUBTASKS = 8

const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const LOWER_ALNUM = `${LOWER}0123456789`

/** Uniform random string; rejection sampling keeps every symbol equally likely for any alphabet size. */
function randomString(alphabet: string, length: number): string {
  const limit = 256 - (256 % alphabet.length)
  let out = ''
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit) out += alphabet[byte % alphabet.length]
      if (out.length === length) break
    }
  }
  return out
}

/** 8 chars from INVITE_ALPHABET. */
export function newInviteCode(): string {
  return randomString(INVITE_ALPHABET, INVITE_CODE_LENGTH)
}

const JOIN_PARAM = /(?:^|[?&#\s])join=([^&#\s]*)/i
// Spaces, hyphens and the dashes iOS smart punctuation or copy/paste may produce.
const SEPARATORS = /[\s\-_‐-―−]/g

/** Accepts a raw code or a full invite link (`…?join=XXXXXXXX`). Uppercases, strips spaces and dashes.
 *  Returns the 8-char code, or null if it is not 8 chars from INVITE_ALPHABET. */
export function normalizeInviteCode(input: string): string | null {
  let raw = input
  const match = JOIN_PARAM.exec(input)
  if (match) {
    try {
      raw = decodeURIComponent(match[1].replace(/\+/g, ' '))
    } catch {
      return null
    }
  }
  const code = raw.replace(SEPARATORS, '').toUpperCase()
  if (code.length !== INVITE_CODE_LENGTH) return null
  return [...code].every((c) => INVITE_ALPHABET.includes(c)) ? code : null
}

/** 'ABCD2345' → 'ABCD-2345' */
export function formatInviteCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/** Short random id for tasks. Starts with a letter and stays alphanumeric, so it is safe as a Firestore map key and field path. */
export function newTaskId(): string {
  return randomString(LOWER, 1) + randomString(LOWER_ALNUM, 9)
}

export function reviewDocId(reviewerId: UID, revieweeId: UID): string {
  return `${reviewerId}_${revieweeId}`
}

/**
 * A settlement's doc id (SPEC §9.7): `${monthId}_${uid}` (per member, from before batch 2), `${monthId}_${uid}_${other}`
 * (one pair), `${monthId}_${uid}_${other}_s${tier}` (a streak reward of `tier` months that `other` owes `uid`).
 * Uids have no `_`, so the shapes never collide. A tier needs `other`.
 */
export function settlementDocId(monthId: MonthId, uid: UID, other?: UID, tier?: number): string {
  if (other === undefined) return `${monthId}_${uid}`
  return tier === undefined ? `${monthId}_${uid}_${other}` : `${monthId}_${uid}_${other}_s${tier}`
}

/**
 * Muted mid-tones spaced around the hue wheel. Each holds about 4:1 contrast with white initials
 * and at least 3.4:1 against both iOS grouped backgrounds, so avatars read in light and dark mode.
 */
export const AVATAR_COLORS = [
  '#6B7F9E', // slate blue
  '#5D8889', // teal
  '#74876F', // sage
  '#8F7C52', // ochre
  '#A5735F', // clay
  '#A57583', // dusty rose
  '#8C7699', // mauve
  '#77749F', // lavender
] as const

/** Stable avatar color from a uid, picked from a muted iOS-like palette. */
export function colorForUid(uid: UID): string {
  // FNV-1a: tiny, deterministic, and spreads similar uids across the palette.
  let hash = 0x811c9dc5
  for (let i = 0; i < uid.length; i++) {
    hash ^= uid.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return AVATAR_COLORS[(hash >>> 0) % AVATAR_COLORS.length]
}
