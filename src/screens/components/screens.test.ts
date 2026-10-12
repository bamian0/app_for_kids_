import { describe, expect, it } from 'vitest'
import { computeMonth, computeWeek } from '../../domain/scoring.ts'
import type { MemberMonthResult, MemberWeekResult, WeekResult } from '../../domain/scoring.ts'
import { monthCompleteAt, weekBounds } from '../../domain/time.ts'
import type { Space, WeekData } from '../../domain/types.ts'
import { formatScore, monthName, wholePercent } from './format.ts'
import { addedLabel, stepCount, summarizeMarks, weekdayIn } from './marks.ts'
import { canSettle, defaultMonth, freshVerdictMonth, settleHint, verdictStatus, verdictText } from './month.ts'
import { personOf } from './people.ts'
import { spaceStatus } from './status.ts'
import type { StatusContext } from './status.ts'
import { deadlineDay, deadlineText, deviceTime } from './zone.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const ROME = 'Europe/Rome'
const name = (uid: string) => ({ a: 'Ann', b: 'Ben', c: 'Cat', d: 'Dan', e: 'Eve' })[uid] ?? 'Someone'

describe('formatScore', () => {
  it('floors to a whole percent and never shows 90 for 89.9', () => {
    expect(formatScore(62.5)).toBe('62%')
    expect(formatScore(89.95)).toBe('89%')
    expect(formatScore(89.99999999999999)).toBe('90%')
    expect(formatScore(100)).toBe('100%')
    expect(wholePercent(83.333)).toBe(83)
  })

  it('names months', () => {
    expect(monthName('2026-10')).toBe('October')
    expect(monthName('2027-01')).toBe('January')
  })
})

describe('deadline wording', () => {
  // Week of Mon Oct 12 2026 in Rome: lock Tue Oct 13 00:00, deadline Sat Oct 17 00:00.
  const b = weekBounds('2026-10-12', ROME)

  it('speaks in midnights on the space clock', () => {
    expect(deadlineText(b.lockAt, ROME, b.startAt + 10 * HOUR, ROME)).toBe('tonight at midnight')
    expect(deadlineText(b.lockAt, ROME, b.startAt - 10 * HOUR, ROME)).toBe('tomorrow at midnight')
    expect(deadlineText(b.deadlineAt, ROME, b.startAt + HOUR, ROME)).toBe('Friday at midnight')
    // From the Monday before, next week's lock is a week away.
    expect(deadlineText(b.lockAt, ROME, b.startAt - 7 * DAY + HOUR, ROME)).toBe('next Monday at midnight')
    expect(deadlineDay(b.lockAt, ROME, ROME)).toBe('Mon')
  })

  it('gives the device-local time on another clock', () => {
    const la = 'America/Los_Angeles'
    // Rome midnight Tue = Mon 15:00 in Los Angeles.
    expect(deadlineText(b.lockAt, ROME, b.startAt, la)).toMatch(/^Mon (3:00 PM|15:00)$/)
    expect(deadlineDay(b.lockAt, ROME, la)).toBe(deviceTime(b.lockAt, la))
    // Berlin keeps Rome's clock all year: no conversion.
    expect(deadlineText(b.lockAt, ROME, b.startAt + HOUR, 'Europe/Berlin')).toBe('tonight at midnight')
  })

  it('falls back to a clock time for a week that does not end at midnight', () => {
    expect(deadlineText(b.lockAt - HOUR, ROME, b.startAt, ROME)).toMatch(/^Mon (11:00 PM|23:00)$/)
  })
})

describe('summarizeMarks', () => {
  it('names up to two reviewers', () => {
    expect(summarizeMarks([['b', 1], ['a', 0.5]], 'a', (u) => (u === 'a' ? 'You' : name(u)))).toBe('Ben: Done · You: Half')
  })
  it('summarises bigger groups, with your own mark first', () => {
    const who = (u: string) => (u === 'a' ? 'You' : name(u))
    expect(summarizeMarks([['b', 1], ['c', 1], ['d', 1], ['e', 1], ['a', 1]], 'a', who)).toBe('All 5: Done')
    expect(summarizeMarks([['b', 1], ['c', 1], ['d', 0.5], ['e', 1], ['a', 0.5]], 'a', who)).toBe('You: Half · 3 Done · 2 Half')
    expect(summarizeMarks([['b', 0], ['c', 1], ['d', 0.5]], 'a', who)).toBe('1 Done · 1 Half · 1 Not done')
  })
})

describe('task badges', () => {
  it('names the day a task was added on the space’s clock', () => {
    // Wednesday 23:30 in Rome is already Thursday in Tokyo.
    const wed = Date.parse('2026-10-14T21:30:00Z')
    expect(addedLabel(wed, ROME)).toBe('Added Wed')
    expect(addedLabel(wed, 'Asia/Tokyo')).toBe('Added Thu')
    expect(weekdayIn(wed, ROME, true)).toBe('Wednesday')
  })
  it('counts ticked steps', () => {
    expect(stepCount([{ done: true }, { done: false }, { done: true }, { done: false }])).toBe('2/4')
    expect(stepCount([{ done: false }])).toBe('0/1')
  })
})

describe('personOf', () => {
  it('only lets a hex color through to CSS', () => {
    const profile = (color: string) => ({ x: { uid: 'x', name: 'X', color, createdAt: 0 } })
    expect(personOf(profile('#A1b2C3'), 'x').color).toBe('#A1b2C3')
    expect(personOf(profile('url(//x.co/a)'), 'x').color).toMatch(/^#[0-9a-f]{6}$/i)
    expect(personOf(profile('url(//x.co/a)'), 'x').color).not.toContain('url')
  })
})

function member(uid: string, over: Partial<MemberWeekResult> = {}): MemberWeekResult {
  return { uid, participating: true, taskCount: 2, tasks: [], provisionalScore: 0, score: null, reviewedBy: [], missedReviewsOf: [], hasSubmitted: false, ...over }
}

function week(phase: WeekResult['phase'], members: MemberWeekResult[], revealed = false): WeekResult {
  return { weekId: '2026-10-12', phase, revealed, members: Object.fromEntries(members.map((m) => [m.uid, m])) }
}

describe('spaceStatus', () => {
  const b = weekBounds('2026-10-12', ROME)
  const ctx: StatusContext = { memberIds: ['a', 'b'], joinedLate: false, nextWeekTasks: null, nextLock: 'Mon' }
  const friday = b.reviewOpenAt + 2 * HOUR

  it('makes a due review urgent only when there is someone to review', () => {
    expect(spaceStatus(week('review', [member('a'), member('b')]), b, 'a', friday, ctx)).toMatchObject({ tone: 'urgent', text: 'Review due in 22h' })
    // Ben planned nothing: no points at stake, a neutral confirm.
    const none = spaceStatus(week('review', [member('a'), member('b', { taskCount: 0 })]), b, 'a', friday, ctx)
    expect(none.tone).toBe('default')
    expect(none.text).toMatch(/confirm/)
    // Alone: nothing to do but wait.
    expect(spaceStatus(week('review', [member('a')]), b, 'a', friday, { ...ctx, memberIds: ['a'] })).toMatchObject({ tone: 'default', text: 'Results in 22h' })
    // Someone who left the space is nobody's review target.
    expect(spaceStatus(week('review', [member('a'), member('b')]), b, 'a', friday, { ...ctx, memberIds: ['a'] }).tone).toBe('default')
  })

  it('only says "in from next week" to someone who joined late', () => {
    const t = b.lockAt + DAY
    const out = week('active', [member('a', { participating: false })])
    expect(spaceStatus(out, b, 'a', t, { ...ctx, joinedLate: true }).text).toBe('You’re in from next week')
    expect(spaceStatus(out, b, 'a', t, ctx).text).toBe('Sitting this week out')
  })

  it('turns the weekend into a nudge to plan next week', () => {
    const t = b.deadlineAt + DAY
    const out = week('closed', [member('a', { participating: false })])
    expect(spaceStatus(out, b, 'a', t, ctx)).toMatchObject({ text: 'Plan next week · locks Mon', tone: 'default' })
    expect(spaceStatus(out, b, 'a', t, { ...ctx, nextWeekTasks: 3 }).text).toBe('Next week: 3 tasks · locks Mon')
    expect(spaceStatus(week('closed', [member('a')], true), b, 'a', t, { ...ctx, nextWeekTasks: 0 }).text).toBe('Results are in · Plan next week')
  })
})

function monthResult(uid: string, over: Partial<MemberMonthResult> = {}): MemberMonthResult {
  return { uid, monthId: '2026-09', former: false, others: [], weeks: [], average: 95, missedReviews: 0, penaltyPoints: 0, finalScore: 95, complete: true, passed: true, ...over }
}

describe('month verdict', () => {
  const stakes = { reward: 'Dinner', penalty: 'Coffee' }

  it('names who owes whom from the month’s players', () => {
    expect(verdictText(monthResult('a', { others: ['b'] }), 'a', name, stakes)).toBe('Ben owes you: Dinner')
    expect(verdictText(monthResult('a', { others: ['b', 'c'], passed: false }), 'a', name, stakes)).toBe('You owe Ben and Cat: Coffee')
    expect(verdictText(monthResult('b', { others: ['a', 'c'] }), 'a', name, stakes)).toBe('You and Cat owe Ben: Dinner')
    expect(verdictText(monthResult('b', { others: ['a'], passed: false }), 'a', name, stakes)).toBe('Ben owes you: Coffee')
  })

  it('owes nothing alone', () => {
    expect(verdictText(monthResult('a'), 'a', name, stakes)).toBe('Just you this month, so nothing’s owed.')
    expect(verdictStatus('2026-09', monthResult('a'), 'a', name)).toBe('September: just you, nothing owed')
  })

  it('writes the home card line', () => {
    expect(verdictStatus('2026-09', monthResult('a', { others: ['b'] }), 'a', name)).toBe('September: Ben owes you')
    expect(verdictStatus('2026-09', monthResult('a', { others: ['b', 'c', 'd', 'e'], passed: false }), 'a', name)).toBe('September: You owe 4 friends')
    expect(verdictStatus('2026-09', monthResult('a', { complete: false, passed: null }), 'a', name)).toBeNull()
  })

  it('lets only the people owed mark it settled', () => {
    const won = monthResult('a', { others: ['b', 'c'] })
    const lost = monthResult('b', { others: ['a', 'c'], passed: false })
    expect(canSettle(won, 'a')).toBe(true)
    expect(canSettle(won, 'b')).toBe(false)
    expect(settleHint(won, 'b', name)).toBe('Only Ann can mark this.')
    expect(canSettle(lost, 'a')).toBe(true)
    expect(canSettle(lost, 'b')).toBe(false)
    expect(settleHint(lost, 'b', name)).toBe('Only the people you owe can mark this.')
    // Someone who didn't play that month is owed nothing.
    expect(canSettle(lost, 'd')).toBe(false)
  })
})

describe('default month', () => {
  const space: Space = {
    id: 's', name: 'S', reward: 'r', penalty: 'p', ownerId: 'a', memberIds: ['a', 'b'],
    joinedAt: { a: Date.UTC(2026, 6, 1), b: Date.UTC(2026, 10, 3) },
    timezone: ROME, inviteCode: 'X', threshold: 90, latePenalty: 5, createdAt: Date.UTC(2026, 6, 1),
  }
  // October's last week is Oct 26–30; its deadline (Sat Oct 31 00:00 Rome) completes the month.
  const done = monthCompleteAt('2026-10', ROME)

  it('opens on a finished month for a week, then moves on', () => {
    expect(defaultMonth(space, 'a', done - HOUR)).toBe('2026-10')
    expect(freshVerdictMonth(space, 'a', done - HOUR)).toBeNull()
    expect(freshVerdictMonth(space, 'a', done + HOUR)).toBe('2026-10')
    // Monday Nov 2: the current month is November, but October's verdict is still fresh.
    expect(defaultMonth(space, 'a', done + 2 * DAY + HOUR)).toBe('2026-10')
    expect(defaultMonth(space, 'a', done + 7 * DAY - HOUR)).toBe('2026-10')
    expect(defaultMonth(space, 'a', done + 7 * DAY + HOUR)).toBe('2026-11')
  })

  it('skips a verdict from before you joined', () => {
    expect(defaultMonth(space, 'b', done + 3 * DAY + HOUR)).toBe('2026-11')
  })
})

describe('month roster', () => {
  it('keeps a former member in the verdict and leaves late joiners out', () => {
    // Sep 2026: weeks of Aug 31, Sep 7, 14, 21. a, b and c play; c leaves on Oct 2; d joins in October.
    const space: Space = {
      id: 's', name: 'S', reward: 'r', penalty: 'p', ownerId: 'a', memberIds: ['a', 'b', 'd'],
      joinedAt: { a: 0, b: 0, d: Date.UTC(2026, 9, 3) }, leftAt: { c: Date.UTC(2026, 9, 2) },
      timezone: ROME, inviteCode: 'X', threshold: 90, latePenalty: 5, createdAt: 0,
    }
    const weeks: WeekData[] = ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'].map((weekId) => ({
      spaceId: 's', weekId, week: { id: weekId, spaceId: 's', ...weekBounds(weekId, ROME), members: ['a', 'b', 'c'], submittedBy: [] },
      plans: { a: { uid: 'a', tasks: [{ id: 't', title: 'T' }], updatedAt: 0 }, c: { uid: 'c', tasks: [{ id: 't', title: 'T' }], updatedAt: 0 } },
      progress: { a: { uid: 'a', done: { t: true }, updatedAt: 0 } }, reviews: [],
    }))
    const now = Date.UTC(2026, 9, 11)
    const results = computeMonth(space, '2026-09', weeks, now)
    expect(results.c.former).toBe(true)
    expect(verdictText(results.c, 'a', name, { reward: 'r', penalty: 'p' })).toMatch(/^Cat owes you and Ben: p$/)
    expect(results.a.others).not.toContain('d')
    expect(computeWeek(weeks[0], space, now).members.c.participating).toBe(true)
  })
})

describe('open target', () => {
  it('reads the space and month a notification points at', async () => {
    const { parseOpenTarget } = await import('./openTarget.ts')
    expect(parseOpenTarget('?space=abc123&month=2026-10')).toEqual({ spaceId: 'abc123', monthId: '2026-10' })
    expect(parseOpenTarget('?space=abc123&month=2026-13')).toEqual({ spaceId: 'abc123', monthId: null })
    expect(parseOpenTarget('?space=../x')).toBeNull()
    expect(parseOpenTarget('?join=ABCD')).toBeNull()
  })
})
