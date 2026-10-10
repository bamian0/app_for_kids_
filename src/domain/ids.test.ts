import { describe, expect, it } from 'vitest'
import {
  AVATAR_COLORS,
  INVITE_ALPHABET,
  colorForUid,
  formatInviteCode,
  newInviteCode,
  newTaskId,
  normalizeInviteCode,
  reviewDocId,
  settlementDocId,
} from './ids.ts'

describe('newInviteCode', () => {
  it('is 8 characters from the invite alphabet', () => {
    for (let i = 0; i < 500; i++) {
      const code = newInviteCode()
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/)
      expect(normalizeInviteCode(code)).toBe(code)
    }
  })
  it('uses the whole alphabet and does not repeat', () => {
    const codes = Array.from({ length: 2000 }, newInviteCode)
    expect(new Set(codes).size).toBe(codes.length)
    expect(new Set(codes.join('')).size).toBe(INVITE_ALPHABET.length)
  })
})

describe('normalizeInviteCode', () => {
  it('accepts raw codes with spaces, dashes and any case', () => {
    expect(normalizeInviteCode('ABCD2345')).toBe('ABCD2345')
    expect(normalizeInviteCode('abcd-2345')).toBe('ABCD2345')
    expect(normalizeInviteCode('  AbCd 2345 ')).toBe('ABCD2345')
    expect(normalizeInviteCode('ab cd-23 45')).toBe('ABCD2345')
    expect(normalizeInviteCode('ABCD—2345')).toBe('ABCD2345')
    expect(normalizeInviteCode('ABCD–2345')).toBe('ABCD2345')
  })
  it('extracts the code from invite links', () => {
    expect(normalizeInviteCode('https://someone.github.io/app_for_kids_/?join=ABCD2345')).toBe('ABCD2345')
    expect(normalizeInviteCode('https://someone.github.io/app_for_kids_/?join=abcd-2345')).toBe('ABCD2345')
    expect(normalizeInviteCode('https://someone.github.io/app_for_kids_/?utm=x&join=ABCD2345#top')).toBe('ABCD2345')
    expect(normalizeInviteCode('https://someone.github.io/app_for_kids_/index.html?join=ABCD%2D2345&now=1')).toBe('ABCD2345')
    expect(normalizeInviteCode('Join my space: https://someone.github.io/app_for_kids_/?join=ABCD2345 see you')).toBe('ABCD2345')
    expect(normalizeInviteCode('?join=wxyz7899')).toBe('WXYZ7899')
  })
  it('rejects anything that is not 8 alphabet characters', () => {
    expect(normalizeInviteCode('')).toBeNull()
    expect(normalizeInviteCode('ABCD234')).toBeNull()
    expect(normalizeInviteCode('ABCD23456')).toBeNull()
    // 0, 1, I and O are excluded from the alphabet to avoid mix-ups.
    expect(normalizeInviteCode('ABCD2340')).toBeNull()
    expect(normalizeInviteCode('ABCD2341')).toBeNull()
    expect(normalizeInviteCode('ABCI2345')).toBeNull()
    expect(normalizeInviteCode('ABCO2345')).toBeNull()
    expect(normalizeInviteCode('ABCD 23!5')).toBeNull()
    expect(normalizeInviteCode('https://someone.github.io/app_for_kids_/')).toBeNull()
    expect(normalizeInviteCode('https://someone.github.io/app_for_kids_/?join=')).toBeNull()
    expect(normalizeInviteCode('https://someone.github.io/app_for_kids_/?join=%E0%A4%A')).toBeNull()
    expect(normalizeInviteCode('https://someone.github.io/?rejoin=ABCD2345')).toBeNull()
  })
})

describe('formatInviteCode', () => {
  it('splits into two groups of four', () => {
    expect(formatInviteCode('ABCD2345')).toBe('ABCD-2345')
    expect(normalizeInviteCode(formatInviteCode('WXYZ7899'))).toBe('WXYZ7899')
  })
})

describe('newTaskId', () => {
  it('is short, alphanumeric, starts with a letter and does not repeat', () => {
    const ids = Array.from({ length: 5000 }, newTaskId)
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9]{9}$/)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('doc ids', () => {
  it('joins with underscores', () => {
    expect(reviewDocId('alice', 'bob')).toBe('alice_bob')
    expect(settlementDocId('2026-10', 'alice')).toBe('2026-10_alice')
  })
})

describe('colorForUid', () => {
  it('is deterministic and picks from the palette', () => {
    expect(colorForUid('uid-1')).toBe(colorForUid('uid-1'))
    expect(AVATAR_COLORS).toContain(colorForUid('uid-1'))
    expect(AVATAR_COLORS).toContain(colorForUid(''))
    expect(colorForUid('Xf8s9Kq2LmN0pQr4StUv6WxYz1')).toMatch(/^#[0-9A-F]{6}$/)
  })
  it('spreads uids across the whole palette', () => {
    const counts = new Map<string, number>()
    for (let i = 0; i < 4000; i++) {
      const color = colorForUid(`user${i}`)
      counts.set(color, (counts.get(color) ?? 0) + 1)
    }
    expect(counts.size).toBe(AVATAR_COLORS.length)
    for (const n of counts.values()) expect(n).toBeGreaterThan(300)
  })
  it('keeps the palette muted and readable under white initials', () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (hi + 0.05) / (lo + 0.05)
    }
    expect(new Set(AVATAR_COLORS).size).toBe(AVATAR_COLORS.length)
    for (const color of AVATAR_COLORS) {
      expect(contrast(color, '#FFFFFF')).toBeGreaterThanOrEqual(3.5)
      expect(contrast(color, '#F2F2F7')).toBeGreaterThanOrEqual(3)
      expect(contrast(color, '#1C1C1E')).toBeGreaterThanOrEqual(3)
    }
  })
})
