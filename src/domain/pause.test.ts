import { describe, expect, it } from 'vitest'
import {
  isWeekPaused,
  PAUSE_ASK_LEAD_MS,
  PAUSE_COOLDOWN_MS,
  pauseChoices,
  pauseCompletes,
  pausedWeekOf,
  pauseNeeded,
  pauseNeedsFinalizing,
  pauseView,
  type PauseWeek,
} from './pause.ts'
import { weekBounds } from './time.ts'
import type { PauseRequest, Space, UID } from './types.ts'

const TZ = 'Europe/Berlin'
const H = 3_600_000
const D = 24 * H

const THIS = '2026-10-12'
const NEXT = '2026-10-19'
const thisB = weekBounds(THIS, TZ)
const nextB = weekBounds(NEXT, TZ)
/** Tuesday of this week, after its lock. */
const NOW = thisB.lockAt + 10 * H

function space(extra: Partial<Space> = {}): Space {
  const memberIds = ['lena', 'sam', 'ben', 'ana']
  return {
    id: 's1',
    name: 'Film Club',
    reward: 'Dinner on me',
    penalty: 'Coffee for a week',
    ownerId: 'lena',
    memberIds,
    joinedAt: Object.fromEntries(memberIds.map((uid) => [uid, 0])),
    timezone: TZ,
    utcOffsetMin: 120,
    inviteCode: 'ABCD2345',
    threshold: 90,
    latePenalty: 5,
    createdAt: 0,
    judges: ['ana'],
    ...extra,
  }
}

const ask = (r: Partial<PauseRequest> = {}): PauseRequest => ({ weekId: NEXT, by: 'lena', at: NOW - H, oks: ['lena'], ...r })
const nextWeek = (members: UID[] = ['lena', 'sam', 'ben', 'ana']): PauseWeek => ({ members, reviewOpenAt: nextB.reviewOpenAt, deadlineAt: nextB.deadlineAt })
const choicesWeeks = { thisWeek: { id: THIS, reviewOpenAt: thisB.reviewOpenAt }, nextWeek: { id: NEXT, reviewOpenAt: nextB.reviewOpenAt } }

describe('constants', () => {
  it('12 hours between asks, a day of lead time', () => {
    expect(PAUSE_COOLDOWN_MS).toBe(12 * H)
    expect(PAUSE_ASK_LEAD_MS).toBe(24 * H)
  })
})

describe('isWeekPaused and pausedWeekOf (the month of the week’s Friday)', () => {
  it('a week is paused when its Friday’s month records it', () => {
    const sp = space({ paused: { '2026-10': NEXT } })
    expect(isWeekPaused(sp, NEXT)).toBe(true)
    expect(isWeekPaused(sp, THIS)).toBe(false)
    expect(pausedWeekOf(sp, '2026-10')).toBe(NEXT)
    expect(pausedWeekOf(sp, '2026-11')).toBeNull()
    expect(isWeekPaused(space(), NEXT)).toBe(false)
    expect(pausedWeekOf(space(), '2026-10')).toBeNull()
  })

  it('across month ends: the week of Nov 30 is December’s, the week of Sep 28 October’s', () => {
    expect(isWeekPaused(space({ paused: { '2026-12': '2026-11-30' } }), '2026-11-30')).toBe(true)
    expect(isWeekPaused(space({ paused: { '2026-11': '2026-11-30' } }), '2026-11-30')).toBe(false)
    expect(isWeekPaused(space({ paused: { '2026-10': '2026-09-28' } }), '2026-09-28')).toBe(true)
    expect(isWeekPaused(space({ paused: { '2026-09': '2026-09-28' } }), '2026-09-28')).toBe(false)
    expect(isWeekPaused(space({ paused: { '2026-10': 'nonsense' } }), 'nonsense')).toBe(false)
  })
})

describe('who must say OK', () => {
  it('everyone in the week still in the space: judges too, not leavers, not someone who joined after the lock', () => {
    // Ben left after the week locked (still in it); Kim joined after its lock (not in it); Ana judges.
    const memberIds = ['lena', 'sam', 'ana', 'kim']
    const weekMembers = ['lena', 'sam', 'ben', 'ana']
    expect(pauseNeeded(memberIds, weekMembers)).toEqual(['lena', 'sam', 'ana'])
    expect(pauseCompletes(['lena', 'sam'], memberIds, weekMembers)).toBe(false)
    expect(pauseCompletes(['lena', 'sam', 'ana'], memberIds, weekMembers)).toBe(true)
    expect(pauseCompletes(['ana', 'sam', 'lena', 'kim'], memberIds, weekMembers)).toBe(true)
    // Alone in the week: the asker's own OK completes it.
    expect(pauseCompletes(['lena'], ['lena', 'kim'], ['lena'])).toBe(true)
    expect(pauseNeeded(['lena'], ['lena', 'lena'])).toEqual(['lena'])
  })
})

describe('pauseView', () => {
  it('none without a request', () => {
    expect(pauseView(space(), 'lena', NOW, nextWeek())).toEqual({ kind: 'none' })
  })

  it('pending: asked, to-answer, said-ok, with whom it waits for', () => {
    const sp = space({ pause: ask() })
    expect(pauseView(sp, 'lena', NOW, nextWeek())).toEqual({ kind: 'pending', request: sp.pause, waitingFor: ['sam', 'ben', 'ana'], me: 'asked' })
    expect(pauseView(sp, 'ana', NOW, nextWeek())).toMatchObject({ kind: 'pending', me: 'to-answer' })
    const okd = space({ pause: ask({ oks: ['lena', 'sam'] }) })
    expect(pauseView(okd, 'sam', NOW, nextWeek())).toEqual({ kind: 'pending', request: okd.pause, waitingFor: ['ben', 'ana'], me: 'said-ok' })
  })

  it('not-asked: someone who isn’t in the week (joined after its lock)', () => {
    const sp = space({ memberIds: ['lena', 'sam', 'ben', 'ana', 'kim'], pause: ask({ weekId: THIS }) })
    const week = { members: ['lena', 'sam', 'ben', 'ana'], reviewOpenAt: thisB.reviewOpenAt, deadlineAt: thisB.deadlineAt }
    expect(pauseView(sp, 'kim', NOW, week)).toMatchObject({ kind: 'pending', me: 'not-asked', waitingFor: ['sam', 'ben', 'ana'] })
  })

  it('a leaver isn’t waited for', () => {
    const sp = space({ memberIds: ['lena', 'sam', 'ana'], pause: ask({ oks: ['lena', 'sam'] }) })
    expect(pauseView(sp, 'lena', NOW, nextWeek())).toMatchObject({ kind: 'pending', waitingFor: ['ana'] })
  })

  it('declined: until that week’s reviews open, then nothing', () => {
    const sp = space({ pause: ask({ declinedBy: 'sam' }) })
    expect(pauseView(sp, 'lena', NOW, nextWeek())).toEqual({ kind: 'declined', request: sp.pause, by: 'sam' })
    expect(pauseView(sp, 'ben', nextB.reviewOpenAt - 1, nextWeek())).toMatchObject({ kind: 'declined', by: 'sam' })
    expect(pauseView(sp, 'lena', nextB.reviewOpenAt, nextWeek())).toEqual({ kind: 'none' })
  })

  it('withdrawn (the asker cancelled): nothing, for everyone', () => {
    const sp = space({ pause: ask({ declinedBy: 'lena', oks: ['lena', 'sam'] }) })
    for (const me of ['lena', 'sam', 'ben', 'ana']) expect(pauseView(sp, me, NOW, nextWeek())).toEqual({ kind: 'none' })
  })

  it('paused: recorded, until that week’s deadline', () => {
    const sp = space({ pause: ask({ oks: ['lena', 'sam', 'ben', 'ana'] }), paused: { '2026-10': NEXT } })
    expect(pauseView(sp, 'sam', NOW, nextWeek())).toEqual({ kind: 'paused', weekId: NEXT })
    expect(pauseView(sp, 'sam', nextB.deadlineAt - 1, nextWeek())).toEqual({ kind: 'paused', weekId: NEXT })
    expect(pauseView(sp, 'sam', nextB.deadlineAt, nextWeek())).toEqual({ kind: 'none' })
  })

  it('lapsed: not recorded when reviews opened, until the deadline, with who never answered', () => {
    const sp = space({ pause: ask({ oks: ['lena', 'sam'] }) })
    expect(pauseView(sp, 'lena', nextB.reviewOpenAt, nextWeek())).toEqual({ kind: 'lapsed', request: sp.pause, waitingFor: ['ben', 'ana'] })
    expect(pauseView(sp, 'lena', nextB.deadlineAt, nextWeek())).toEqual({ kind: 'none' })
  })
})

describe('pauseChoices', () => {
  it('ok for both weeks when nothing stands in the way', () => {
    expect(pauseChoices(space(), 'lena', NOW, choicesWeeks)).toEqual({ thisWeek: 'ok', nextWeek: 'ok' })
  })

  it("'too-late' when reviews open in 24 hours or less (the rules still allow it)", () => {
    expect(pauseChoices(space(), 'lena', thisB.reviewOpenAt - PAUSE_ASK_LEAD_MS, choicesWeeks).thisWeek).toBe('too-late')
    expect(pauseChoices(space(), 'lena', thisB.reviewOpenAt - PAUSE_ASK_LEAD_MS - 1, choicesWeeks).thisWeek).toBe('ok')
    expect(pauseChoices(space(), 'lena', thisB.reviewOpenAt - 1, choicesWeeks)).toEqual({ thisWeek: 'too-late', nextWeek: 'ok' })
  })

  it("'reviews-open' once that week’s reviews opened", () => {
    expect(pauseChoices(space(), 'lena', thisB.reviewOpenAt, choicesWeeks)).toEqual({ thisWeek: 'reviews-open', nextWeek: 'ok' })
  })

  it("'month-used' for a week whose Friday’s month has its pause; a week in another month is still ok", () => {
    const sp = space({ paused: { '2026-10': '2026-10-05' } })
    expect(pauseChoices(sp, 'lena', NOW, choicesWeeks)).toEqual({ thisWeek: 'month-used', nextWeek: 'month-used' })
    // The last week of November and the first of December (week of Nov 30, Friday Dec 4).
    const end = { thisWeek: { id: '2026-11-23', reviewOpenAt: weekBounds('2026-11-23', TZ).reviewOpenAt }, nextWeek: { id: '2026-11-30', reviewOpenAt: weekBounds('2026-11-30', TZ).reviewOpenAt } }
    const nov = space({ paused: { '2026-11': '2026-11-02' } })
    expect(pauseChoices(nov, 'lena', weekBounds('2026-11-23', TZ).lockAt, end)).toEqual({ thisWeek: 'month-used', nextWeek: 'ok' })
  })

  it("'request-pending' while a request is live; over once declined, withdrawn, recorded or lapsed", () => {
    expect(pauseChoices(space({ pause: ask() }), 'sam', NOW, choicesWeeks)).toEqual({ thisWeek: 'request-pending', nextWeek: 'request-pending' })
    expect(pauseChoices(space({ pause: ask({ declinedBy: 'sam' }) }), 'sam', NOW, choicesWeeks)).toEqual({ thisWeek: 'ok', nextWeek: 'ok' })
    expect(pauseChoices(space({ pause: ask({ declinedBy: 'lena' }) }), 'sam', NOW, choicesWeeks)).toEqual({ thisWeek: 'ok', nextWeek: 'ok' })
    // Recorded for next week (October): both weeks are October's, so the month is used.
    expect(pauseChoices(space({ pause: ask(), paused: { '2026-10': NEXT } }), 'sam', NOW, choicesWeeks)).toEqual({ thisWeek: 'month-used', nextWeek: 'month-used' })
    // A request for this week whose reviews opened has lapsed.
    const lapsed = space({ pause: ask({ weekId: THIS, at: thisB.reviewOpenAt - 2 * D }) })
    expect(pauseChoices(lapsed, 'sam', thisB.reviewOpenAt + H, choicesWeeks)).toEqual({ thisWeek: 'reviews-open', nextWeek: 'ok' })
    // A request for an earlier week is over, whatever its fields say.
    expect(pauseChoices(space({ pause: ask({ weekId: '2026-10-05', at: NOW - 3 * D }) }), 'sam', NOW, choicesWeeks)).toEqual({ thisWeek: 'ok', nextWeek: 'ok' })
  })

  it("'cooldown': the asker can ask again 12 hours after their last request, cancelled ones included", () => {
    const withdrawn = space({ pause: ask({ declinedBy: 'lena', at: NOW - 11 * H }) })
    expect(pauseChoices(withdrawn, 'lena', NOW, choicesWeeks)).toEqual({ thisWeek: 'cooldown', nextWeek: 'cooldown' })
    expect(pauseChoices(withdrawn, 'sam', NOW, choicesWeeks)).toEqual({ thisWeek: 'ok', nextWeek: 'ok' })
    const declined = space({ pause: ask({ declinedBy: 'sam', at: NOW - PAUSE_COOLDOWN_MS }) })
    expect(pauseChoices(declined, 'lena', NOW, choicesWeeks)).toEqual({ thisWeek: 'ok', nextWeek: 'ok' })
    expect(pauseChoices(declined, 'lena', NOW - 1, choicesWeeks)).toEqual({ thisWeek: 'cooldown', nextWeek: 'cooldown' })
  })
})

describe('pauseNeedsFinalizing (the last holdout left)', () => {
  it('every OK still needed is in, nobody recorded it, and reviews haven’t opened', () => {
    const sp = space({ memberIds: ['lena', 'sam', 'ana'], pause: ask({ oks: ['lena', 'sam', 'ana'] }) })
    expect(pauseNeedsFinalizing(sp, NOW, nextWeek())).toBe(true)
    expect(pauseNeedsFinalizing(sp, nextB.reviewOpenAt, nextWeek())).toBe(false)
    expect(pauseNeedsFinalizing({ ...sp, paused: { '2026-10': NEXT } }, NOW, nextWeek())).toBe(false)
    expect(pauseNeedsFinalizing({ ...sp, paused: { '2026-10': '2026-10-05' } }, NOW, nextWeek())).toBe(false)
    expect(pauseNeedsFinalizing({ ...sp, pause: ask({ oks: ['lena', 'sam', 'ana'], declinedBy: 'lena' }) }, NOW, nextWeek())).toBe(false)
    // Ben is still in the space and hasn't said OK.
    expect(pauseNeedsFinalizing(space({ pause: ask({ oks: ['lena', 'sam', 'ana'] }) }), NOW, nextWeek())).toBe(false)
    expect(pauseNeedsFinalizing(space(), NOW, nextWeek())).toBe(false)
  })
})
