import { describe, expect, it } from 'vitest'
import { cancelOptions } from '../../domain/cancel.ts'
import { computeWeek } from '../../domain/scoring.ts'
import type { MemberWeekResult, TaskResult } from '../../domain/scoring.ts'
import { weekBounds } from '../../domain/time.ts'
import type { Space, Task, TaskCancel, Week, WeekData } from '../../domain/types.ts'
import {
  SKIPPED_PERIOD,
  crossOutConfirm,
  crossOutFooter,
  crossOutGate,
  crossedOutBadge,
  crossedOutFooter,
  crossedOutLine,
  crossedOutResult,
  doneLine,
  draftFits,
  openCount,
  quoted,
  skippedSuffix,
  undoConfirm,
  undoFooter,
  voteNote,
  voteSummary,
} from './cancel.ts'
import { addedLabel, monthDayIn } from './marks.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const ROME = 'Europe/Rome'
/** Week of Mon Oct 12 2026 in Rome: locks Tue Oct 13 00:00, reviews open Fri Oct 16 00:00. */
const WEEK = '2026-10-12'
const B = weekBounds(WEEK, ROME)
/** Wednesday Oct 14, 10:00 in Rome. */
const WED = B.startAt + 2 * DAY + 10 * HOUR

const cancel = (changes: number, why = 'The pool is closed all week'): TaskCancel => ({ cancelled: changes % 2 === 1, changes, at: WED, why })

describe('dates on crossed-out and added tasks', () => {
  it('names the weekday on a week, the date on a monthly list, on the space’s clock', () => {
    expect(crossedOutBadge(WED, ROME, 'week')).toBe('Crossed out Wed')
    expect(crossedOutBadge(WED, ROME, 'month')).toBe('Crossed out Oct 14')
    expect(crossedOutLine(WED, ROME, 'week')).toBe('Crossed out Wednesday')
    expect(crossedOutLine(WED, ROME, 'month')).toBe('Crossed out October 14')
    expect(addedLabel(WED, ROME)).toBe('Added Wed')
    expect(addedLabel(WED, ROME, 'week')).toBe('Added Wed')
    expect(addedLabel(WED, ROME, 'month')).toBe('Added Oct 14')
    // 23:30 on Oct 24 in Rome is already Oct 25 in Tokyo.
    const late = Date.parse('2026-10-24T21:30:00Z')
    expect(monthDayIn(late, ROME)).toBe('Oct 24')
    expect(monthDayIn(late, 'Asia/Tokyo')).toBe('Oct 25')
    expect(monthDayIn(late, ROME, true)).toBe('October 24')
    expect(quoted('Sick')).toBe('“Sick”')
  })
})

describe('the task sheet’s cross-out copy (SPEC §10.5)', () => {
  const base = 'For when something outside your control gets in the way. Friends see your reason and decide on review day if it’s fair to skip it.'

  it('says how many undos are left before crossing out', () => {
    expect(crossOutFooter(2)).toBe(`${base} You can undo it twice.`)
    expect(crossOutFooter(1)).toBe(`${base} You have 1 undo left.`)
    expect(crossOutFooter(0)).toBe(`${base} If you cross it out again, it’s final.`)
    // The footer follows cancelOptions: never crossed out, restored once, restored twice.
    const window = { lockAt: B.lockAt, reviewOpenAt: B.reviewOpenAt }
    expect([undefined, cancel(2), cancel(4)].map((c) => crossOutFooter(cancelOptions({ cancel: c }, window, WED).undosLeft))).toEqual([
      `${base} You can undo it twice.`,
      `${base} You have 1 undo left.`,
      `${base} If you cross it out again, it’s final.`,
    ])
  })

  it('asks before crossing out', () => {
    const message = 'Friends see it crossed out with your reason, and on review day they decide if it’s fair to skip it.'
    expect(crossOutConfirm('Swim 3 times', 2)).toEqual({ title: 'Cross out “Swim 3 times”?', message: `${message} You can undo this twice until reviews open.` })
    expect(crossOutConfirm('Swim 3 times', 1).message).toBe(`${message} You can undo this once more until reviews open.`)
    expect(crossOutConfirm('Swim 3 times', 0).message).toBe(`${message} This one is final: you’ve used both undos.`)
  })

  it('asks before undoing, with the undos left after it', () => {
    expect(undoConfirm('Swim 3 times', 1)).toEqual({ title: 'Undo the cross-out?', message: '“Swim 3 times” counts again and you can tick it. You’ll have 1 undo left.' })
    expect(undoConfirm('Swim 3 times', 0).message).toBe('“Swim 3 times” counts again and you can tick it. That’s your last undo: if you cross it out again, it’s final.')
  })

  it('words a crossed-out task’s footer', () => {
    expect(undoFooter(2, 'Friday at midnight')).toBe('You can undo this twice, until reviews open Friday at midnight.')
    expect(undoFooter(1, 'Friday at midnight')).toBe('You can undo this once more, until reviews open Friday at midnight.')
    expect(undoFooter(0, 'Friday at midnight')).toBe('This is final. Friends decide on review day if it’s fair to skip it.')
    expect(crossedOutFooter(1, false, 'Friday at midnight')).toBe('You can undo this once more, until reviews open Friday at midnight.')
    expect(crossedOutFooter(1, true, 'Friday at midnight')).toBe('Reviews have opened, so this can’t change anymore.')
  })
})

describe('who may cross out (crossOutGate)', () => {
  const MEMBERS = ['a', 'b', 'c']
  const space = (over: Partial<Space> = {}): Pick<Space, 'memberIds' | 'paused'> => ({ memberIds: MEMBERS, ...over })
  const week = (over: Partial<Week> = {}): Week => ({ id: WEEK, spaceId: 's', ...B, members: MEMBERS, submittedBy: [], ...over })
  /** October's list: its own members and judges. */
  const list = (over: Partial<Week> = {}): Week => ({ id: '2026-10', spaceId: 's', ...B, members: MEMBERS, judges: [], submittedBy: [], ...over })

  it('offers both to a player still in the space', () => {
    expect(crossOutGate(week(), 'week', space(), 'a')).toEqual({ crossOut: true, undo: true })
    expect(crossOutGate(list(), 'month', space(), 'a')).toEqual({ crossOut: true, undo: true })
  })

  it('hides Cross Out in a paused week, but keeps Undo', () => {
    expect(crossOutGate(week(), 'week', space({ paused: { '2026-10': WEEK } }), 'a')).toEqual({ crossOut: false, undo: true })
  })

  it('never lets a pause hide a monthly list’s Cross Out', () => {
    // October's last week is paused: the list still counts and is reviewed.
    expect(crossOutGate(list(), 'month', space({ paused: { '2026-10': '2026-10-26' } }), 'a')).toEqual({ crossOut: true, undo: true })
  })

  it('follows the list’s own judges, not this week’s', () => {
    // This week's judge plays October's list: offered there.
    expect(crossOutGate(list(), 'month', space(), 'a')).toEqual({ crossOut: true, undo: true })
    expect(crossOutGate(week({ judges: ['a'] }), 'week', space(), 'a')).toEqual({ crossOut: false, undo: false })
    // The monthly list's judge: nothing.
    expect(crossOutGate(list({ judges: ['a'] }), 'month', space(), 'a')).toEqual({ crossOut: false, undo: false })
  })

  it('hides Cross Out when nobody else in the period can vote, but keeps Undo', () => {
    expect(crossOutGate(week({ members: ['a'] }), 'week', space({ memberIds: ['a'] }), 'a')).toEqual({ crossOut: false, undo: true })
    // The only other member left the space.
    expect(crossOutGate(week({ members: ['a', 'b'] }), 'week', space({ memberIds: ['a', 'c'] }), 'a')).toEqual({ crossOut: false, undo: true })
    // A judge counts: they vote too.
    expect(crossOutGate(week({ members: ['a', 'b'], judges: ['b'] }), 'week', space(), 'a')).toEqual({ crossOut: true, undo: true })
  })

  it('offers nothing outside the period, after leaving, or without a period', () => {
    expect(crossOutGate(week({ members: ['b', 'c'] }), 'week', space(), 'a')).toEqual({ crossOut: false, undo: false })
    expect(crossOutGate(week(), 'week', space({ memberIds: ['b', 'c'] }), 'a')).toEqual({ crossOut: false, undo: false })
    expect(crossOutGate(null, 'week', space(), 'a')).toEqual({ crossOut: false, undo: false })
  })
})

describe('cards and results with crossed-out tasks', () => {
  const task = (id: string, selfDone: boolean, c?: TaskCancel): TaskResult => ({
    taskId: id,
    title: id,
    mark: 0,
    source: 'reviews',
    reviewerMarks: {},
    selfDone,
    subtasks: [],
    selfFraction: selfDone ? 1 : 0,
    ...(c ? { cancel: c } : {}),
  })
  const member = (tasks: TaskResult[], over: Partial<MemberWeekResult> = {}): MemberWeekResult => ({
    uid: 'a',
    participating: true,
    taskCount: tasks.length,
    tasks,
    provisionalScore: null,
    score: null,
    reviewedBy: [],
    missedReviewsOf: [],
    hasSubmitted: false,
    ...over,
  })

  it('counts only tasks that aren’t crossed out', () => {
    const m = member([task('t1', true), task('t2', true), task('t3', false), task('t4', true, cancel(1))])
    expect(openCount(m)).toEqual({ open: 3, done: 2, crossed: 1 })
    // A restored task counts again.
    expect(openCount(member([task('t1', true, cancel(2))]))).toEqual({ open: 1, done: 1, crossed: 0 })
  })

  it('labels the provisional count before the reveal', () => {
    expect(doneLine(member([task('t1', true), task('t2', false)]))).toBe('1 of 2 done')
    expect(doneLine(member([task('t1', true), task('t2', true), task('t3', false), task('t4', false, cancel(1))]))).toBe('2 of 3 done · 1 crossed out, not counted yet')
    expect(doneLine(member([task('t1', true), task('t2', false, cancel(1)), task('t3', false, cancel(3))]))).toBe('1 of 1 done · 2 crossed out, not counted yet')
    expect(doneLine(member([task('t1', false, cancel(1))]))).toBe('Crossed out, not counted yet')
    expect(doneLine(member([task('t1', false, cancel(1)), task('t2', true, cancel(1)), task('t3', false, cancel(5))]))).toBe('All 3 crossed out, not counted yet')
    // In a paused week nothing counts anyway.
    expect(doneLine(member([task('t1', true), task('t2', false, cancel(1))]), true)).toBe('1 of 1 done · 1 crossed out')
  })

  it('adds the excused count, and names a skipped period', () => {
    expect(skippedSuffix({ excusedCount: 0 })).toBe('')
    expect(skippedSuffix({})).toBe('')
    expect(skippedSuffix({ excusedCount: 1 })).toBe(' · 1 skipped')
    expect(SKIPPED_PERIOD).toBe('Skipped: friends said fair')
  })

  it('shows the vote on a crossed-out task once results are in', () => {
    const excused = { ...task('t1', false, cancel(1, 'Pool closed')), fairBy: ['b', 'c'], excused: true }
    expect(voteSummary(excused, 3)).toBe('2 of 3 said fair')
    expect(crossedOutResult(excused, 3)).toEqual({ subtitle: '“Pool closed” · 2 of 3 said fair', detail: 'Skipped' })
    const counted = { ...task('t1', false, cancel(1, 'Pool closed')), fairBy: ['b'], excused: false }
    expect(crossedOutResult(counted, 2)).toEqual({ subtitle: '“Pool closed” · 1 of 2 said fair', detail: 'Not done' })
    // Nobody reviewed: the check-off counts, as today.
    expect(crossedOutResult({ ...task('t1', true, cancel(1, 'Pool closed')), source: 'self' }, 0)).toEqual({ subtitle: '“Pool closed” · Checked off' })
    expect(crossedOutResult({ ...task('t1', false, cancel(1, 'Pool closed')), source: 'self' }, 0).subtitle).toBe('“Pool closed” · Not checked off')
    const steps = { ...task('t1', false, cancel(1, 'Pool closed')), source: 'self' as const, subtasks: [
      { id: 's1', title: 'A', done: true },
      { id: 's2', title: 'B', done: true },
      { id: 's3', title: 'C', done: false },
      { id: 's4', title: 'D', done: false },
    ] }
    expect(crossedOutResult(steps, 0).subtitle).toBe('“Pool closed” · 2 of 4 steps ticked')
  })

  it('reads the domain’s results the same way', () => {
    // Lena crossed out one of two tasks; Sam and Kim (a judge) both said fair: excused, and her score leaves it out.
    const space: Space = {
      id: 's', name: 'Film Club', reward: 'Dinner', penalty: 'Coffee', ownerId: 'a', memberIds: ['a', 'b', 'c'],
      joinedAt: { a: 0, b: 0, c: 0 }, timezone: ROME, utcOffsetMin: 120, inviteCode: 'ABCDEFGH', threshold: 90, latePenalty: 5, createdAt: 0,
    }
    const tasks: Task[] = [{ id: 't1', title: 'Swim 3 times', cancel: cancel(1) }, { id: 't2', title: 'Edit the reel' }]
    const data: WeekData = {
      spaceId: 's',
      weekId: WEEK,
      week: { id: WEEK, spaceId: 's', ...B, members: ['a', 'b', 'c'], judges: ['c'], submittedBy: ['a', 'b', 'c'] },
      plans: { a: { uid: 'a', tasks, updatedAt: 0 }, b: { uid: 'b', tasks: [{ id: 'u1', title: 'Run' }], updatedAt: 0 } },
      progress: {},
      reviews: [
        { id: 'b_a', reviewerId: 'b', revieweeId: 'a', marks: { t1: 'fair', t2: 1 }, submittedAt: B.reviewOpenAt + HOUR },
        { id: 'c_a', reviewerId: 'c', revieweeId: 'a', marks: { t1: 'fair', t2: 0.5 }, submittedAt: B.reviewOpenAt + HOUR },
        { id: 'a_b', reviewerId: 'a', revieweeId: 'b', marks: { u1: 1 }, submittedAt: B.reviewOpenAt + HOUR },
        { id: 'c_b', reviewerId: 'c', revieweeId: 'b', marks: { u1: 1 }, submittedAt: B.reviewOpenAt + HOUR },
      ],
    }
    const lena = computeWeek(data, space, B.reviewOpenAt + 2 * HOUR).members.a
    expect(lena.score).toBe(75)
    expect(crossedOutResult(lena.tasks[0], lena.reviewedBy.length)).toEqual({ subtitle: '“The pool is closed all week” · 2 of 2 said fair', detail: 'Skipped' })
    expect(skippedSuffix(lena)).toBe(' · 1 skipped')
  })
})

describe('the review sheet’s vote', () => {
  it('says what a fair vote does', () => {
    expect(voteNote('Lena')).toBe('If most reviewers say it’s fair, it doesn’t count for Lena. If not, it counts as not done.')
  })

  it('drops a draft that no longer fits the task', () => {
    expect(draftFits(true, 'fair')).toBe(true)
    expect(draftFits(true, 0)).toBe(true)
    expect(draftFits(true, 1)).toBe(false)
    expect(draftFits(true, 0.5)).toBe(false)
    expect(draftFits(false, 'fair')).toBe(false)
    expect(draftFits(false, 0.5)).toBe(true)
    expect(draftFits(false, undefined)).toBe(false)
    expect(draftFits(true, null)).toBe(false)
  })
})
