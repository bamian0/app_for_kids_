import { describe, expect, it } from 'vitest'
import {
  boundsFor,
  firstUnlockedWeek,
  isUsualSchedule,
  joinMoment,
  MIN_REVIEW_MINUTES,
  momentDay,
  momentText,
  needsRetime,
  RETIME_NOTICE_MS,
  sameSchedule,
  scheduleChangeLines,
  scheduleOf,
  scheduleProblem,
  scheduleProblemText,
  scheduleStartsWith,
  splitMoment,
  timeLabel,
  weekScheduleOf,
} from './schedule.ts'
import { DEFAULT_SCHEDULE, WEEK_MINUTES, weekBounds } from './time.ts'
import type { Space, Week, WeekSchedule } from './types.ts'

const TZ = 'Europe/Berlin'
const H = 3_600_000
const at = (iso: string) => Date.parse(iso)

/** Every schedule this spec and its designs quote as an example. */
const EXAMPLES: Record<string, WeekSchedule> = {
  usual: { lock: 1440, reviewOpen: 5760, deadline: 7200 },
  'lists lock Monday at 8:00 PM, reviews due Saturday at noon': { lock: 1200, reviewOpen: 5760, deadline: 7920 },
  'lists lock Tuesday at noon, reviews due Saturday at midnight': { lock: 2160, reviewOpen: 5760, deadline: 8640 },
  'lists lock Monday at 8:00 AM': { lock: 480, reviewOpen: 5760, deadline: 7200 },
  'lists lock Monday at 3:30 PM': { lock: 930, reviewOpen: 5760, deadline: 7200 },
  'lists lock Monday at 9:00 AM': { lock: 540, reviewOpen: 5760, deadline: 7200 },
  'reviews open Saturday at 9:00 AM': { lock: 1440, reviewOpen: 7740, deadline: 8640 },
  'reviews due Saturday at 2:00 AM': { lock: 1440, reviewOpen: 5760, deadline: 7320 },
  'reviews Friday 6:00 PM to 9:00 PM': { lock: 1440, reviewOpen: 6840, deadline: 7020 },
  'reviews due Sunday at midnight': { lock: 1440, reviewOpen: 5760, deadline: 10080 },
  'reviews open Thursday at 6:00 PM': { lock: 1440, reviewOpen: 5400, deadline: 7200 },
  'lists lock Sunday at midnight': { lock: 0, reviewOpen: 5760, deadline: 7200 },
}

function space(extra: Partial<Space> = {}): Space {
  return {
    id: 's1',
    name: 'Film Club',
    reward: 'Dinner on me',
    penalty: 'Coffee for a week',
    ownerId: 'lena',
    memberIds: ['lena', 'sam'],
    joinedAt: { lena: 0, sam: 0 },
    timezone: TZ,
    utcOffsetMin: 120,
    inviteCode: 'ABCD2345',
    threshold: 90,
    latePenalty: 5,
    createdAt: 0,
    ...extra,
  }
}

function week(id: string, schedule?: WeekSchedule, extra: Partial<Week> = {}): Week {
  return { id, spaceId: 's1', ...weekBounds(id, TZ, schedule), members: ['lena', 'sam'], submittedBy: [], ...(schedule ? { schedule } : {}), ...extra }
}

describe('scheduleOf, sameSchedule, isUsualSchedule', () => {
  it('absent means the usual times; equality is by effective values', () => {
    expect(scheduleOf(undefined)).toBe(DEFAULT_SCHEDULE)
    expect(scheduleOf(null)).toBe(DEFAULT_SCHEDULE)
    expect(scheduleOf({})).toBe(DEFAULT_SCHEDULE)
    const s = { lock: 1200, reviewOpen: 5760, deadline: 7920 }
    expect(scheduleOf({ schedule: s })).toBe(s)
    expect(sameSchedule(undefined, null)).toBe(true)
    expect(sameSchedule(undefined, { lock: 1440, reviewOpen: 5760, deadline: 7200 })).toBe(true)
    expect(sameSchedule(s, { ...s })).toBe(true)
    expect(sameSchedule(s, { ...s, deadline: 7930 })).toBe(false)
    expect(sameSchedule(s, undefined)).toBe(false)
    expect(isUsualSchedule(undefined)).toBe(true)
    expect(isUsualSchedule({ lock: 1440, reviewOpen: 5760, deadline: 7200 })).toBe(true)
    expect(isUsualSchedule(s)).toBe(false)
  })
})

describe('scheduleProblem (null exactly when the rules accept it)', () => {
  it.each(Object.entries(EXAMPLES))('the example "%s" passes', (_name, s) => {
    expect(scheduleProblem(s)).toBeNull()
  })

  it('boundaries: lock 0, a window of exactly 180 minutes, a deadline of exactly 10080', () => {
    expect(MIN_REVIEW_MINUTES).toBe(180)
    expect(scheduleProblem({ lock: 0, reviewOpen: 1, deadline: 181 })).toBeNull()
    expect(scheduleProblem({ lock: -1, reviewOpen: 5760, deadline: 7200 })).toBe('shape')
    expect(scheduleProblem({ lock: 1440, reviewOpen: 5760, deadline: 5940 })).toBeNull()
    expect(scheduleProblem({ lock: 1440, reviewOpen: 5760, deadline: 5939 })).toBe('window')
    expect(scheduleProblem({ lock: 1440, reviewOpen: 9900, deadline: WEEK_MINUTES })).toBeNull()
    expect(scheduleProblem({ lock: 1440, reviewOpen: 5760, deadline: WEEK_MINUTES + 1 })).toBe('range')
    expect(scheduleProblem({ lock: 5760, reviewOpen: 5760, deadline: 7200 })).toBe('order')
    expect(scheduleProblem({ lock: 5761, reviewOpen: 5760, deadline: 7200 })).toBe('order')
    expect(scheduleProblem({ lock: 5759, reviewOpen: 5760, deadline: 7200 })).toBeNull()
  })

  it('shape: not three ints', () => {
    expect(scheduleProblem(null)).toBe('shape')
    expect(scheduleProblem(undefined)).toBe('shape')
    expect(scheduleProblem('1440')).toBe('shape')
    expect(scheduleProblem({ lock: 1440, reviewOpen: 5760 })).toBe('shape')
    expect(scheduleProblem({ lock: 1440.5, reviewOpen: 5760, deadline: 7200 })).toBe('shape')
    expect(scheduleProblem({ lock: '1440', reviewOpen: 5760, deadline: 7200 })).toBe('shape')
    expect(scheduleProblem({ lock: Number.NaN, reviewOpen: 5760, deadline: 7200 })).toBe('shape')
  })
})

describe('scheduleProblemText', () => {
  it('says what’s wrong, with the midnight hint for order and window when a moment is a midnight', () => {
    expect(scheduleProblemText('order', { lock: 5760, reviewOpen: 5760, deadline: 7200 })).toBe(
      'Lists have to lock before reviews open. Midnight is the end of the day you pick.',
    )
    expect(scheduleProblemText('order', { lock: 5000, reviewOpen: 4980, deadline: 7210 })).toBe('Lists have to lock before reviews open.')
    expect(scheduleProblemText('window', { lock: 1200, reviewOpen: 7100, deadline: 7200 })).toBe(
      'Give reviews at least 3 hours. Midnight is the end of the day you pick.',
    )
    expect(scheduleProblemText('window', { lock: 1200, reviewOpen: 6840, deadline: 6900 })).toBe('Give reviews at least 3 hours.')
    expect(scheduleProblemText('window')).toBe('Give reviews at least 3 hours.')
    expect(scheduleProblemText('range', { lock: 1440, reviewOpen: 5760, deadline: 10110 })).toBe('Reviews have to be due by Sunday at midnight.')
    expect(scheduleProblemText('shape')).toBe('Those times don’t work. Pick them again.')
  })
})

describe('splitMoment and joinMoment', () => {
  it('a day (Monday = 0) and a time in (0, 1440]; midnight is the end of the day', () => {
    expect(splitMoment(0)).toEqual({ day: -1, time: 1440 })
    expect(splitMoment(1)).toEqual({ day: 0, time: 1 })
    expect(splitMoment(720)).toEqual({ day: 0, time: 720 })
    expect(splitMoment(1440)).toEqual({ day: 0, time: 1440 })
    expect(splitMoment(1441)).toEqual({ day: 1, time: 1 })
    expect(splitMoment(7200)).toEqual({ day: 4, time: 1440 })
    expect(splitMoment(WEEK_MINUTES)).toEqual({ day: 6, time: 1440 })
  })

  it('round-trips every 30-minute step of the week, m = 0 included', () => {
    for (let m = 0; m <= WEEK_MINUTES; m += 30) {
      const { day, time } = splitMoment(m)
      expect(time).toBeGreaterThan(0)
      expect(time).toBeLessThanOrEqual(1440)
      expect(day).toBeGreaterThanOrEqual(-1)
      expect(day).toBeLessThanOrEqual(6)
      expect(joinMoment(day, time)).toBe(m)
    }
    expect(joinMoment(-1, 1440)).toBe(0)
    expect(joinMoment(5, 720)).toBe(7920)
  })
})

describe('timeLabel and momentText', () => {
  it('Midnight, Noon, and the device’s clock style', () => {
    expect(timeLabel(0)).toBe('Midnight')
    expect(timeLabel(1440)).toBe('Midnight')
    expect(timeLabel(720)).toBe('Noon')
    expect(timeLabel(1080)).toBe('6:00 PM')
    expect(timeLabel(1080, 'h23')).toBe('18:00')
    expect(timeLabel(30)).toBe('12:30 AM')
    expect(timeLabel(30, 'h23')).toBe('00:30')
    expect(timeLabel(750)).toBe('12:30 PM')
    expect(timeLabel(60)).toBe('1:00 AM')
    expect(timeLabel(1410)).toBe('11:30 PM')
    expect(timeLabel(1410, 'h23')).toBe('23:30')
    expect(timeLabel(720, 'h23')).toBe('Noon')
    expect(timeLabel(1440, 'h23')).toBe('Midnight')
  })

  it('a moment of the week in words', () => {
    expect(momentText(1440)).toBe('Monday at midnight')
    expect(momentText(5760)).toBe('Thursday at midnight')
    expect(momentText(7200)).toBe('Friday at midnight')
    expect(momentText(0)).toBe('Sunday at midnight')
    expect(momentText(WEEK_MINUTES)).toBe('Sunday at midnight')
    expect(momentText(1200)).toBe('Monday at 8:00 PM')
    expect(momentText(7920)).toBe('Saturday at noon')
    expect(momentText(6840)).toBe('Friday at 6:00 PM')
    expect(momentText(6840, 'h23')).toBe('Friday at 18:00')
    expect(momentText(2160, 'h23')).toBe('Tuesday at noon')
    expect(momentDay(0)).toBe('Sunday')
    expect(momentDay(1441)).toBe('Tuesday')
  })
})

describe('scheduleChangeLines', () => {
  it('one line per moment that changed', () => {
    expect(scheduleChangeLines(undefined, { lock: 1200, reviewOpen: 5760, deadline: 7920 })).toEqual([
      'Lists now lock Monday at 8:00 PM',
      'Reviews are now due Saturday at noon',
    ])
    expect(scheduleChangeLines({ lock: 1200, reviewOpen: 5760, deadline: 7920 }, null)).toEqual([
      'Lists now lock Monday at midnight',
      'Reviews are now due Friday at midnight',
    ])
    expect(scheduleChangeLines(DEFAULT_SCHEDULE, { lock: 1440, reviewOpen: 5400, deadline: 7200 })).toEqual(['Reviews now open Thursday at 6:00 PM'])
    expect(scheduleChangeLines(DEFAULT_SCHEDULE, { lock: 1440, reviewOpen: 5400, deadline: 7200 }, 'h23')).toEqual(['Reviews now open Thursday at 18:00'])
    expect(scheduleChangeLines(undefined, undefined)).toEqual([])
  })
})

describe('boundsFor and weekScheduleOf', () => {
  const custom = { lock: 1200, reviewOpen: 5760, deadline: 7920 }
  it('the stored bounds when the doc is given, else computed on the space’s schedule', () => {
    const stored = week('2026-10-12', undefined, { lockAt: 123, deadlineAt: 456 })
    expect(boundsFor(space({ schedule: custom }), '2026-10-12', stored)).toEqual({ startAt: stored.startAt, lockAt: 123, reviewOpenAt: stored.reviewOpenAt, deadlineAt: 456 })
    expect(boundsFor(space({ schedule: custom }), '2026-10-12')).toEqual(weekBounds('2026-10-12', TZ, custom))
    expect(boundsFor(space(), '2026-10-12', null)).toEqual(weekBounds('2026-10-12', TZ))
  })

  it('a doc’s own schedule (absent: the usual one), else the space’s', () => {
    expect(weekScheduleOf(space({ schedule: custom }), week('2026-10-12'))).toBe(DEFAULT_SCHEDULE)
    expect(weekScheduleOf(space(), week('2026-10-12', custom))).toEqual(custom)
    expect(weekScheduleOf(space({ schedule: custom }), null)).toBe(custom)
    expect(weekScheduleOf(space(), undefined)).toBe(DEFAULT_SCHEDULE)
  })
})

describe('scheduleStartsWith (a day’s notice on the old and the new times)', () => {
  const mondayEight = { lock: 480, reviewOpen: 5760, deadline: 7200 }

  it('Sunday 23:00, lists to lock Monday 08:00: next week’s new lock is 9h away, so the week after next', () => {
    const now = at('2026-10-18T21:00:00Z') // Sunday 23:00 in Berlin
    expect(scheduleStartsWith(space(), mondayEight, { thisWeek: week('2026-10-12'), nextWeek: week('2026-10-19') }, now)).toBe('2026-10-26')
    expect(scheduleStartsWith(space(), mondayEight, {}, now)).toBe('2026-10-26')
  })

  it('a change 23h before this week’s lock gives next week', () => {
    const now = at('2026-10-11T23:00:00Z') // Monday 01:00 in Berlin; this week locks in 23h
    expect(scheduleStartsWith(space(), { lock: 1440, reviewOpen: 5760, deadline: 7920 }, { thisWeek: week('2026-10-12') }, now)).toBe('2026-10-19')
    // 24h exactly qualifies (as in the rules: request.time + 1 day ≤ lockAt).
    expect(scheduleStartsWith(space(), { lock: 1440, reviewOpen: 5760, deadline: 7920 }, { thisWeek: week('2026-10-12') }, now - H)).toBe('2026-10-12')
  })

  it('this week when both of its locks are a day away', () => {
    const tuesdayNoon = { lock: 2160, reviewOpen: 5760, deadline: 7200 }
    const wednesdayNoon = { lock: 3600, reviewOpen: 5760, deadline: 7200 }
    const now = at('2026-10-12T07:00:00Z') // Monday 09:00; this week locks Tuesday noon (27h)
    expect(scheduleStartsWith(space({ schedule: tuesdayNoon }), wednesdayNoon, { thisWeek: week('2026-10-12', tuesdayNoon) }, now)).toBe('2026-10-12')
    // Moving the lock earlier, to Monday 20:00 (11h away): next week.
    expect(scheduleStartsWith(space({ schedule: tuesdayNoon }), { lock: 1200, reviewOpen: 5760, deadline: 7200 }, { thisWeek: week('2026-10-12', tuesdayNoon) }, now)).toBe('2026-10-19')
  })

  it('a stored lock wins over the computed one; a doc of another week is ignored', () => {
    const now = at('2026-10-12T07:00:00Z')
    const tuesdayNoon = { lock: 2160, reviewOpen: 5760, deadline: 7200 }
    // The space is on Tuesday noon, but this week's doc still has the usual lock (Tuesday 00:00, 15h away).
    expect(scheduleStartsWith(space({ schedule: tuesdayNoon }), { lock: 3600, reviewOpen: 5760, deadline: 7200 }, { thisWeek: week('2026-10-12') }, now)).toBe('2026-10-19')
    // Without the doc (or with another week's), computed on the space's schedule: 27h away.
    expect(scheduleStartsWith(space({ schedule: tuesdayNoon }), { lock: 3600, reviewOpen: 5760, deadline: 7200 }, { thisWeek: week('2026-10-05') }, now)).toBe('2026-10-12')
  })

  it('this week already locked, or locked with no doc: next week', () => {
    const now = at('2026-10-14T10:00:00Z')
    expect(scheduleStartsWith(space(), { lock: 1200, reviewOpen: 5760, deadline: 7200 }, { thisWeek: week('2026-10-12'), nextWeek: week('2026-10-19') }, now)).toBe('2026-10-19')
    expect(scheduleStartsWith(space(), { lock: 1200, reviewOpen: 5760, deadline: 7200 }, {}, now)).toBe('2026-10-19')
  })
})

describe('firstUnlockedWeek', () => {
  it('this week while its lists haven’t locked (stored, else computed), else next week', () => {
    const lock = weekBounds('2026-10-12', TZ).lockAt
    expect(firstUnlockedWeek(space(), week('2026-10-12'), lock - 1)).toBe('2026-10-12')
    expect(firstUnlockedWeek(space(), week('2026-10-12'), lock)).toBe('2026-10-19')
    expect(firstUnlockedWeek(space(), null, lock - 1)).toBe('2026-10-12')
    expect(firstUnlockedWeek(space(), undefined, lock)).toBe('2026-10-19')
    // A stored lock later than the computed one (the week kept its old times).
    expect(firstUnlockedWeek(space(), week('2026-10-12', undefined, { lockAt: lock + 5 * H }), lock + H)).toBe('2026-10-12')
    // On the space's own times.
    const custom = space({ schedule: { lock: 1200, reviewOpen: 5760, deadline: 7200 } })
    expect(firstUnlockedWeek(custom, null, lock - 3 * H)).toBe('2026-10-19')
  })
})

describe('needsRetime (mirrors the rules’ retimesWeek)', () => {
  const W = '2026-10-19'
  const mondayEight = { lock: 1200, reviewOpen: 5760, deadline: 7920 }
  const tuesdayNoon = { lock: 2160, reviewOpen: 5760, deadline: 7200 }

  it('nothing when the week already follows the space’s schedule', () => {
    expect(needsRetime(space(), week(W), 0)).toBeNull()
    expect(needsRetime(space(), week(W, { lock: 1440, reviewOpen: 5760, deadline: 7200 }), 0)).toBeNull()
    expect(needsRetime(space({ schedule: mondayEight }), week(W, mondayEight), 0)).toBeNull()
  })

  it('moves an earlier lock only with a day’s notice on the new lock (24h boundary both sides)', () => {
    const newLock = weekBounds(W, TZ, mondayEight).lockAt
    const moved = needsRetime(space({ schedule: mondayEight }), week(W), newLock - RETIME_NOTICE_MS)
    expect(moved).toEqual({ ...weekBounds(W, TZ, mondayEight), startAt: week(W).startAt })
    expect(needsRetime(space({ schedule: mondayEight }), week(W), newLock - RETIME_NOTICE_MS + 1)).toBeNull()
  })

  it('moves a later lock only with a day’s notice on the stored lock (24h boundary both sides)', () => {
    const oldLock = week(W).lockAt
    expect(needsRetime(space({ schedule: tuesdayNoon }), week(W), oldLock - RETIME_NOTICE_MS)?.lockAt).toBe(weekBounds(W, TZ, tuesdayNoon).lockAt)
    expect(needsRetime(space({ schedule: tuesdayNoon }), week(W), oldLock - RETIME_NOTICE_MS + 1)).toBeNull()
  })

  it('back to the usual times; startAt never changes', () => {
    const doc = week(W, mondayEight, { startAt: weekBounds(W, TZ).startAt + 60_000 })
    const moved = needsRetime(space(), doc, at('2026-10-10T00:00:00Z'))
    expect(moved).toEqual({ ...weekBounds(W, TZ), startAt: doc.startAt })
  })
})

describe('RETIME_NOTICE_MS', () => {
  it('is a day', () => {
    expect(RETIME_NOTICE_MS).toBe(24 * H)
  })
})
