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

// Spaces, hyphens and the dashes iOS smart punctuation or copy/paste may produce.
const SEPARATORS = /[\s\-_‐-―−]/g

/** `name=value` as a query parameter anywhere in pasted text (a link, or a sentence around one). */
function paramPattern(name: string): RegExp {
  return new RegExp(`(?:^|[?&#\\s])${name}=([^&#\\s]*)`, 'i')
}

const JOIN_PARAM = paramPattern('join')

/** Accepts a raw code or a full invite link (`…?join=XXXXXXXX`). Uppercases, strips spaces and dashes.
 *  Returns the 8-char code, or null if it is not 8 chars from INVITE_ALPHABET. */
export function normalizeInviteCode(input: string): string | null {
  return normalizeCode(input, JOIN_PARAM)
}

/** Batch 3 (SPEC §11.6): like normalizeInviteCode, for a link whose code sits in `?{param}=` (friend links). */
export function normalizeCodeParam(input: string, param: string): string | null {
  return /^[a-z]+$/i.test(param) ? normalizeCode(input, paramPattern(param)) : null
}

/** True when the text carries `{param}=` as a query parameter (e.g. a space invite link: `join=`). */
export function hasCodeParam(input: string, param: string): boolean {
  return /^[a-z]+$/i.test(param) && paramPattern(param).test(input)
}

function normalizeCode(input: string, pattern: RegExp): string | null {
  let raw = input
  const match = pattern.exec(input)
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

/** A Firebase uid as the rules' isUid checks it (SPEC §11.5): 1–128 letters and digits, so `_` joins uids safely. */
export function isUid(v: unknown): v is UID {
  return typeof v === 'string' && /^[A-Za-z0-9]{1,128}$/.test(v)
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
