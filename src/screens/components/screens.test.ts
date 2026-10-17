import { describe, expect, it } from 'vitest'
import { computeMonth, computeWeek } from '../../domain/scoring.ts'
import type { MemberMonthResult, MemberWeekResult, WeekResult } from '../../domain/scoring.ts'
import { monthCompleteAt, weekBounds } from '../../domain/time.ts'
import type { Space, WeekData } from '../../domain/types.ts'
import { formatScore, monthName, wholePercent } from './format.ts'
import { addedLabel, stepCount, summarizeMarks, weekdayIn } from './marks.ts'
import { canSettle, defaultMonth, freshVerdictMonth, judgeOnly, monthSummary, monthlyDetail, playsMonth, settleHint, skippedCount, verdictStatus, verdictText, weekDetail } from './month.ts'
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

  it('names other times on the same clock (SPEC §9.2)', () => {
    const at = (h: number) => b.startAt + h * HOUR
    // Monday 18:00 seen Monday morning: after 5 PM it is "tonight".
    expect(deadlineText(at(18), ROME, at(9), ROME, 'h12')).toBe('tonight at 6:00 PM')
    expect(deadlineText(at(16), ROME, at(9), ROME, 'h12')).toBe('today at 4:00 PM')
    expect(deadlineText(at(20), ROME, at(9), ROME, 'h23')).toBe('tonight at 20:00')
    expect(deadlineText(at(24 + 9), ROME, at(9), ROME, 'h12')).toBe('tomorrow at 9:00 AM')
    expect(deadlineText(at(4 * 24 + 18), ROME, at(9), ROME, 'h12')).toBe('Friday at 6:00 PM')
    expect(deadlineText(at(5 * 24 + 12), ROME, at(9), ROME, 'h12')).toBe('Saturday at noon')
    expect(deadlineText(at(7 * 24 + 1), ROME, at(9), ROME, 'h12')).toBe('next Monday at 1:00 AM')
    expect(deadlineText(b.lockAt - HOUR, ROME, b.startAt, ROME, 'h12')).toBe('tonight at 11:00 PM')
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

  it('leads with a due review, then a pause to answer, then an urgent plan', () => {
    const ask = { ...ctx, pauseAsk: 'Lena asks to pause next week' }
    expect(spaceStatus(week('review', [member('a'), member('b')]), b, 'a', friday, ask).text).toBe('Review due in 22h')
    const monday = b.lockAt - 5 * HOUR
    expect(spaceStatus(week('planning', [member('a', { taskCount: 0 })]), b, 'a', monday, ask)).toEqual({ text: 'Lena asks to pause next week', icon: 'pause', tone: 'urgent' })
    expect(spaceStatus(week('planning', [member('a', { taskCount: 0 })]), b, 'a', monday, ctx)).toMatchObject({ text: 'Plan your week · locks in 5h', tone: 'urgent' })
  })

  it('never shows a paused week’s plan, lock, empty list or 0% lines', () => {
    const paused = (phase: WeekResult['phase'], m: MemberWeekResult) => ({ ...week(phase, [m, member('b')]), paused: true })
    const monday = b.lockAt - 5 * HOUR
    expect(spaceStatus(paused('planning', member('a', { taskCount: 0 })), b, 'a', monday, ctx)).toEqual({ text: 'Paused this week', icon: 'pause', tone: 'default' })
    expect(spaceStatus(paused('active', member('a', { taskCount: 0 })), b, 'a', b.lockAt + DAY, ctx).text).toBe('Paused this week')
    expect(spaceStatus(paused('review', member('a')), b, 'a', friday, ctx).text).toBe('Paused this week')
    // In a paused last week the monthly lists are still reviewed.
    expect(spaceStatus(paused('review', member('a')), b, 'a', friday, { ...ctx, monthlyDue: true })).toMatchObject({ text: 'Review due in 22h', tone: 'urgent' })
    // The verdict and the notice wait behind it.
    expect(spaceStatus(paused('active', member('a')), b, 'a', b.lockAt + DAY, { ...ctx, notice: 'New times from next week' }).text).toBe('Paused this week')
  })

  it('counts only tasks that aren’t crossed out (SPEC §10.5)', () => {
    const t = (id: string, selfDone: boolean, cancelled = false) => ({
      taskId: id, title: id, mark: 0, source: 'self' as const, reviewerMarks: {}, selfDone, subtasks: [], selfFraction: selfDone ? 1 : 0,
      ...(cancelled ? { cancel: { cancelled: true, changes: 1, at: 0, why: 'Sick' } } : {}),
    })
    const active = b.lockAt + DAY
    const mine = (tasks: ReturnType<typeof t>[]) => week('active', [member('a', { taskCount: tasks.length, tasks }), member('b')])
    expect(spaceStatus(mine([t('1', true), t('2', false), t('3', false, true)]), b, 'a', active, ctx)).toEqual({ text: '1 of 2 done', icon: 'listBullet', tone: 'default' })
    expect(spaceStatus(mine([t('1', true), t('3', false, true)]), b, 'a', active, ctx)).toEqual({ text: '1 of 1 done', icon: 'checkmark', tone: 'done' })
    expect(spaceStatus(mine([t('1', true, true), t('2', false, true)]), b, 'a', active, ctx)).toEqual({ text: 'Tasks crossed out', icon: 'xmark', tone: 'default' })
  })

  it('reviews a friend who left after the lock', () => {
    const left = { ...ctx, memberIds: ['a'], counted: ['a', 'b'] }
    expect(spaceStatus(week('review', [member('a'), member('b')]), b, 'a', friday, left)).toMatchObject({ text: 'Review due in 22h', tone: 'urgent' })
  })

  it('shows a judge’s week', () => {
    const judge = member('a', { taskCount: 0, provisionalScore: null, judge: true })
    expect(spaceStatus(week('planning', [judge, member('b')]), b, 'a', b.lockAt - 5 * HOUR, ctx)).toEqual({ text: 'Judging this week · locks in 5h', icon: 'person2', tone: 'default' })
    expect(spaceStatus(week('active', [judge, member('b')]), b, 'a', b.lockAt + DAY, ctx)).toEqual({ text: 'Judging this week', icon: 'person2', tone: 'default' })
    expect(spaceStatus(week('review', [judge, member('b')]), b, 'a', friday, ctx)).toMatchObject({ text: 'Review due in 22h', tone: 'urgent' })
  })

  it('puts the verdict or the schedule notice over the usual line, not over urgent ones', () => {
    const verdict = { text: 'September: Ben owes you', icon: 'trophy' as const, tone: 'done' as const }
    const active = week('active', [member('a'), member('b')])
    expect(spaceStatus(active, b, 'a', b.lockAt + DAY, { ...ctx, verdict })).toEqual(verdict)
    expect(spaceStatus(active, b, 'a', b.lockAt + DAY, { ...ctx, notice: 'New times from next week' })).toEqual({ text: 'New times from next week', icon: 'clock', tone: 'default' })
    const empty = week('active', [member('a', { taskCount: 0 }), member('b')])
    expect(spaceStatus(empty, b, 'a', b.lockAt + DAY, { ...ctx, verdict }).text).toBe('Nothing planned this week')
  })

  it('looks ahead to a paused or judged next week on the weekend', () => {
    const t = b.deadlineAt + DAY
    const closed = week('closed', [member('a')], true)
    expect(spaceStatus(closed, b, 'a', t, { ...ctx, nextWeekTasks: 0, nextPaused: true }).text).toBe('Results are in')
    const out = week('closed', [member('a', { participating: false })])
    expect(spaceStatus(out, b, 'a', t, { ...ctx, nextPaused: true })).toEqual({ text: 'Next week is paused', icon: 'pause', tone: 'default' })
    expect(spaceStatus(out, b, 'a', t, { ...ctx, judgingNext: true }).text).toBe('Judging next week')
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

describe('skipped periods in the month (SPEC §10.4)', () => {
  const closed = () => true
  it('lists a skipped week and list, never as scored', () => {
    const skippedWeek = monthResult('a', {
      monthId: '2026-10',
      weeks: [
        { weekId: '2026-09-28', score: 90, closed: true },
        { weekId: '2026-10-05', score: 100, closed: true },
        { weekId: '2026-10-12', score: null, closed: true, skipped: true },
        { weekId: '2026-10-19', score: 80, closed: true },
      ],
      monthly: { score: null, closed: true, taskCount: 2, skipped: true },
    })
    expect(skippedCount(skippedWeek)).toBe(2)
    expect(monthSummary(skippedWeek, closed)).toBe('3 weeks scored · 2 skipped')
    const bounds = weekBounds('2026-10-12', ROME)
    expect(weekDetail(skippedWeek, '2026-10-12', bounds, bounds.deadlineAt + DAY)).toBe('Skipped')
    expect(monthlyDetail(skippedWeek)).toBe('Skipped')
    expect(monthSummary(monthResult('a', { weeks: [{ weekId: '2026-09-28', score: null, closed: true, skipped: true }], finalScore: null, average: null }), closed)).toBe(
      'No scored weeks yet · 1 skipped',
    )
  })

  it('doesn’t make a member whose only week was skipped a player', () => {
    const onlySkipped = monthResult('a', { weeks: [{ weekId: '2026-09-28', score: null, closed: true, skipped: true }], judged: ['2026-10-05'], finalScore: null, average: null })
    expect(playsMonth(onlySkipped)).toBe(false)
    expect(judgeOnly(onlySkipped)).toBe(true)
    expect(playsMonth(monthResult('a', { weeks: [{ weekId: '2026-09-28', score: 80, closed: true }] }))).toBe(true)
    expect(playsMonth(monthResult('a', { weeks: [], monthly: { score: null, closed: true, taskCount: 1, skipped: true } }))).toBe(false)
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
