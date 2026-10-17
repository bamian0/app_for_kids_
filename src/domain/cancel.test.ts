import { describe, expect, it } from 'vitest'
import {
  CANCEL_MAX_CHANGES,
  CANCEL_MAX_UNDOS,
  CANCEL_WHY_MAX,
  FAIR,
  cancelKey,
  cancelOptions,
  cleanWhy,
  isCancelled,
  someoneCanReview,
  whyProblem,
  whyProblemText,
} from './cancel.ts'
import type { Task, TaskCancel } from './types.ts'

const LOCK = Date.parse('2026-10-12T22:00:00Z')
const OPEN = Date.parse('2026-10-15T22:00:00Z')
const bounds = { lockAt: LOCK, reviewOpenAt: OPEN }
const MID = LOCK + 36 * 3_600_000

/** A task after `changes` changes of its log (0: never crossed out). */
function task(changes: number): Pick<Task, 'cancel'> {
  if (changes === 0) return {}
  const cancel: TaskCancel = { cancelled: changes % 2 === 1, changes, at: LOCK + changes, why: 'The pool is closed all week' }
  return { cancel }
}

describe('constants and keys', () => {
  it('5 changes, 2 undos, 120 characters, the fair value', () => {
    expect(CANCEL_MAX_CHANGES).toBe(5)
    expect(CANCEL_MAX_UNDOS).toBe(2)
    expect(CANCEL_WHY_MAX).toBe(120)
    expect(FAIR).toBe('fair')
  })

  it('cancelKey: the change number, a colon, the task id', () => {
    expect(cancelKey('t_1-a', 1)).toBe('1:t_1-a')
    expect(cancelKey('abc', 5)).toBe('5:abc')
  })

  it('isCancelled: crossed out now, not after an undo, not without a log', () => {
    expect(isCancelled({})).toBe(false)
    expect(isCancelled(task(1))).toBe(true)
    expect(isCancelled(task(2))).toBe(false)
    expect(isCancelled(task(3))).toBe(true)
    expect(isCancelled(task(4))).toBe(false)
    expect(isCancelled(task(5))).toBe(true)
  })
})

describe('the reason', () => {
  it('cleanWhy: line breaks and the spaces around them become one space, trimmed', () => {
    expect(cleanWhy('  The pool\n is closed  ')).toBe('The pool is closed')
    expect(cleanWhy('Sick\r\n\r\nall week')).toBe('Sick all week')
    expect(cleanWhy('a\u2028b\u2029c')).toBe('a b c')
    // Runs of spaces elsewhere stay as typed.
    expect(cleanWhy('two  spaces')).toBe('two  spaces')
    expect(cleanWhy(' \n\t ')).toBe('')
  })

  it('whyProblem: empty or blank, longer than 120 UTF-16 units, else fine', () => {
    expect(whyProblem('')).toBe('empty')
    expect(whyProblem('   ')).toBe('empty')
    expect(whyProblem('\n\r\n ')).toBe('empty')
    expect(whyProblem('x')).toBeNull()
    expect(whyProblem('x'.repeat(120))).toBeNull()
    expect(whyProblem('x'.repeat(121))).toBe('long')
    // Counted after cleaning: surrounding spaces and line breaks don't count.
    expect(whyProblem(`  ${'x'.repeat(120)}\n`)).toBeNull()
    expect(whyProblem(`${'x'.repeat(60)}\n\n${'x'.repeat(59)}`)).toBeNull()
    expect(whyProblem(`${'x'.repeat(60)}\n\n${'x'.repeat(60)}`)).toBe('long')
    // An emoji is two UTF-16 units, as the field counts it.
    expect(whyProblem('🏊'.repeat(60))).toBeNull()
    expect(whyProblem(`${'🏊'.repeat(60)}x`)).toBe('long')
  })

  it('whyProblemText: the messages, verbatim', () => {
    expect(whyProblemText('empty')).toBe('Say why in a few words.')
    expect(whyProblemText('long')).toBe('Keep the reason to 120 characters.')
  })
})

describe('cancelOptions', () => {
  it('in the window: cross out, undo, cross out, undo, cross out for good', () => {
    expect(cancelOptions(task(0), bounds, MID)).toEqual({ action: 'cross-out', undosLeft: 2, next: 1 })
    expect(cancelOptions(task(1), bounds, MID)).toEqual({ action: 'undo', undosLeft: 2, next: 2 })
    expect(cancelOptions(task(2), bounds, MID)).toEqual({ action: 'cross-out', undosLeft: 1, next: 3 })
    expect(cancelOptions(task(3), bounds, MID)).toEqual({ action: 'undo', undosLeft: 1, next: 4 })
    expect(cancelOptions(task(4), bounds, MID)).toEqual({ action: 'cross-out', undosLeft: 0, next: 5 })
    expect(cancelOptions(task(5), bounds, MID)).toEqual({ action: null, undosLeft: 0, next: 6 })
  })

  it('the window is lockAt ≤ now < reviewOpenAt', () => {
    expect(cancelOptions(task(0), bounds, LOCK).action).toBe('cross-out')
    expect(cancelOptions(task(1), bounds, OPEN - 1).action).toBe('undo')
    for (const changes of [0, 1, 2, 3, 4, 5]) {
      const inside = cancelOptions(task(changes), bounds, MID)
      for (const now of [LOCK - 1, LOCK - 86_400_000, OPEN, OPEN + 1]) {
        // Outside it nothing can change, but undos left and the next change still read the same.
        expect(cancelOptions(task(changes), bounds, now)).toEqual({ ...inside, action: null })
      }
    }
  })

  it('undosLeft both ways: crossed out, the undos remaining; not, what would remain after crossing it out now', () => {
    expect([1, 3, 5].map((c) => cancelOptions(task(c), bounds, MID).undosLeft)).toEqual([2, 1, 0])
    expect([0, 2, 4].map((c) => cancelOptions(task(c), bounds, MID).undosLeft)).toEqual([2, 1, 0])
  })

  it('a malformed change count reads as never crossed out, or as the most there can be', () => {
    const odd = (changes: number): Pick<Task, 'cancel'> => ({ cancel: { cancelled: true, changes, at: LOCK, why: 'x' } })
    expect(cancelOptions(odd(1.5), bounds, MID)).toEqual({ action: 'cross-out', undosLeft: 2, next: 1 })
    expect(cancelOptions(odd(9), bounds, MID)).toEqual({ action: null, undosLeft: 0, next: 6 })
  })
})

describe('someoneCanReview', () => {
  it('another member of the period still in the space, judges included', () => {
    // Alone in the period.
    expect(someoneCanReview({ members: ['lena'] }, ['lena', 'sam'], 'lena')).toBe(false)
    // Another member.
    expect(someoneCanReview({ members: ['lena', 'sam'] }, ['lena', 'sam'], 'lena')).toBe(true)
    // The only other member left the space.
    expect(someoneCanReview({ members: ['lena', 'sam'] }, ['lena'], 'lena')).toBe(false)
    // A judge is a member of the period: they vote too.
    expect(someoneCanReview({ members: ['lena', 'kim'] }, ['lena', 'kim'], 'lena')).toBe(true)
    // Someone in the space but not in the period (joined after the lock) can't review it.
    expect(someoneCanReview({ members: ['lena'] }, ['lena', 'new'], 'lena')).toBe(false)
    expect(someoneCanReview({ members: ['lena', 'sam', 'kim'] }, ['lena', 'kim'], 'lena')).toBe(true)
    expect(someoneCanReview({ members: [] }, ['lena'], 'lena')).toBe(false)
  })
})
