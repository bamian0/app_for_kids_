import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import {
  agreeBy,
  cleanDeal,
  DEAL_COUNTS,
  DEAL_DEFAULT,
  DEAL_LATE_MS,
  DEAL_MAX_COUNT,
  DEAL_NOTICE_MS,
  DEALS_FROM_MONTH,
  dealClock,
  dealDebtLines,
  dealFriends,
  dealId,
  dealLengthText,
  dealLineSettled,
  dealPairTerms,
  dealPeriodKey,
  dealPeriodsToLoad,
  dealProblem,
  dealProblemText,
  dealState,
  firstPeriodAfter,
  isPeriodId,
  lastPlayedDeal,
  monthDealPeriod,
  nextPeriod,
  parseDealId,
  periodLabel,
  positionText,
  sameAgain,
  startPhrase,
  weekDealPeriod,
  type DealProblem,
} from './deals.ts'
import { RETIME_NOTICE_MS } from './schedule.ts'
import { computeMonth } from './scoring.ts'
import { DEALS_FROM_MONTH as STAKES_DEALS_FROM } from './stakes.ts'
import { monthlyBounds, weekBounds, weekIdsInMonth } from './time.ts'
import type { Deal, DealInput, DealPeriod, MonthlyData, Review, ReviewMark, Space, Task, UID, Week, WeekData, WeekId, WeekSchedule } from './types.ts'

const TZ = 'Europe/Berlin'
const H = 3_600_000
const D = 24 * H
const M = 60_000
/** A wall-clock time in a zone. */
const at = (iso: string, tz = TZ) => DateTime.fromISO(iso, { zone: tz }).toMillis()

const T0 = at('2026-10-01T10:00')
const CREATED = at('2026-11-06T10:00')
const SAM_AGREE = at('2026-11-07T10:00')
const KIM_AGREE = at('2026-11-08T22:00')

function space(x: Partial<Space> = {}): Space {
  const memberIds = x.memberIds ?? ['lena', 'sam', 'kim']
  return {
    id: 's1',
    name: 'Film Club',
    reward: 'Dinner, on us',
    penalty: 'Coffee for a week',
    ownerId: 'lena',
    memberIds,
    joinedAt: Object.fromEntries(['lena', 'sam', 'kim', 'ana'].map((u) => [u, T0])),
    timezone: TZ,
    utcOffsetMin: 60,
    inviteCode: 'ABCD2345',
    threshold: 90,
    latePenalty: 5,
    createdAt: T0,
    ...x,
  }
}
const SP = space()

function deal(x: Partial<Deal> = {}): Deal {
  return {
    id: 'lena_1',
    spaceId: 's1',
    uid: 'lena',
    seq: 1,
    unit: 'week',
    count: 2,
    rewardMode: 'group',
    penaltyMode: 'group',
    reward: 'Dinner, on us',
    penalty: 'Coffee for a week',
    per: {},
    friends: ['sam', 'kim'],
    agreed: {},
    off: {},
    settled: {},
    createdAt: CREATED,
    ended: null,
    ...x,
  }
}
/** Everyone agreed by Sunday Nov 8 22:00: it starts with the week of Nov 9. */
const AGREED = { sam: SAM_AGREE, kim: KIM_AGREE }
const agreedDeal = (x: Partial<Deal> = {}) => deal({ agreed: AGREED, ...x })
/** The job's stamps for AGREED. */
const STAMPED = { agreedAt: KIM_AGREE, start: '2026-11-09' }

const W1 = '2026-11-09'
const W2 = '2026-11-16'
const W3 = '2026-11-23'
const W4 = '2026-11-30'
const W5 = '2026-12-07'
const B = (w: WeekId, tz = TZ, s?: WeekSchedule) => weekBounds(w, tz, s)
const lock = (w: WeekId) => B(w).lockAt
const dl = (w: WeekId) => B(w).deadlineAt
const WEEKS = dealClock(SP, 'week')

// ---------- Week fixtures: Lena's week with friends' reviews ----------

interface WeekSpec {
  /** Lena's task count (default 10). */
  tasks?: number
  /** How many of them the reviewers mark Done (default all). */
  done?: number
  /** Friends Lena didn't review. */
  missed?: UID[]
  members?: UID[]
  judges?: UID[]
  noDoc?: boolean
  /** Every task of Lena's crossed out, and every reviewer says fair. */
  excused?: boolean
}

const WHY = 'The pool was closed'

function weekData(weekId: WeekId, spec: WeekSpec = {}, sp: Space = SP): WeekData {
  // Who was in at its lock: the three of them (and anyone else in the space now), whoever left since.
  const members = spec.members ?? [...new Set(['lena', 'sam', 'kim', ...sp.memberIds])]
  const n = spec.tasks ?? 10
  const done = spec.done ?? n
  const bounds = B(weekId)
  const tasksOf = (uid: UID, k: number): Task[] =>
    Array.from({ length: k }, (_, i) => {
      const t: Task = { id: `${uid}${i + 1}`, title: `Task ${i + 1}` }
      if (uid === 'lena' && spec.excused) t.cancel = { cancelled: true, changes: 1, at: bounds.lockAt + H, why: WHY }
      return t
    })
  const others = members.filter((u) => u !== 'lena')
  const plans = Object.fromEntries([['lena', { uid: 'lena', tasks: tasksOf('lena', n), updatedAt: 0 }], ...others.map((u) => [u, { uid: u, tasks: tasksOf(u, 1), updatedAt: 0 }])])
  const reviews: Review[] = []
  for (const r of others) {
    const marks: Record<string, ReviewMark> = {}
    for (let i = 0; i < n; i++) marks[`lena${i + 1}`] = spec.excused ? 'fair' : i < done ? 1 : 0
    reviews.push({ id: `${r}_lena`, reviewerId: r, revieweeId: 'lena', marks, submittedAt: 0 })
  }
  for (const f of others) if (!spec.missed?.includes(f)) reviews.push({ id: `lena_${f}`, reviewerId: 'lena', revieweeId: f, marks: { [`${f}1`]: 1 }, submittedAt: 0 })
  const week: Week = { id: weekId, spaceId: 's1', ...bounds, members, submittedBy: members }
  if (spec.judges) week.judges = spec.judges
  return { spaceId: 's1', weekId, week: spec.noDoc ? null : week, plans, progress: {}, reviews }
}

/** Lena's result for a week, read just after its deadline. */
function wk(weekId: WeekId, spec: WeekSpec = {}, sp: Space = SP): DealPeriod {
  const p = weekDealPeriod(sp, 'lena', weekData(weekId, spec, sp), dl(weekId) + M)
  if (!p) throw new Error(`no result for ${weekId}`)
  return p
}
const PASS = (w: WeekId) => wk(w)

// ---------- Ids and words ----------

describe('ids and words', () => {
  it('constants', () => {
    expect(DEALS_FROM_MONTH).toBe('2026-11')
    expect(DEALS_FROM_MONTH).toBe(STAKES_DEALS_FROM)
    expect(DEAL_MAX_COUNT).toBe(12)
    expect(DEAL_COUNTS.week).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(DEAL_COUNTS.month).toEqual(DEAL_COUNTS.week)
    expect(DEAL_NOTICE_MS).toBe(24 * H)
    expect(DEAL_NOTICE_MS).toBe(RETIME_NOTICE_MS)
    expect(DEAL_LATE_MS).toBe(24 * H)
    expect(DEAL_DEFAULT).toEqual({ unit: 'week', count: 4 })
  })

  it('dealId and parseDealId round trip; bad ids are null', () => {
    expect(dealId('lena', 3)).toBe('lena_3')
    expect(parseDealId('lena_3')).toEqual({ uid: 'lena', seq: 3 })
    expect(parseDealId(dealId('Ab9xYz', 9999))).toEqual({ uid: 'Ab9xYz', seq: 9999 })
    for (const bad of ['a_b_1', 'a_0', 'a_x', 'a_01', 'a_10000', '_1', 'a_', 'a-1', 'a_1.5', 'a_ 1', '']) expect(parseDealId(bad), bad).toBeNull()
  })

  it('dealPeriodKey has no underscore', () => {
    expect(dealPeriodKey({ uid: 'a', seq: 3 })).toBe('a@3')
  })

  it('nextPeriod and isPeriodId', () => {
    expect(nextPeriod('week', W1)).toBe(W2)
    expect(nextPeriod('week', W1, 3)).toBe(W4)
    expect(nextPeriod('month', '2026-12')).toBe('2027-01')
    expect(nextPeriod('month', '2026-11', 2)).toBe('2027-01')
    expect(isPeriodId('week', '2026-11-09')).toBe(true)
    expect(isPeriodId('week', '2026-11-10')).toBe(false) // a Tuesday
    expect(isPeriodId('week', '2026-02-30')).toBe(false)
    expect(isPeriodId('week', '2026-11')).toBe(false)
    expect(isPeriodId('month', '2026-11')).toBe(true)
    expect(isPeriodId('month', '2026-13')).toBe(false)
    expect(isPeriodId('month', '2026-11-09')).toBe(false)
    for (const v of [null, undefined, 5, {}, []]) expect(isPeriodId('week', v) || isPeriodId('month', v)).toBe(false)
  })

  it('dealLengthText, periodLabel, positionText', () => {
    expect(dealLengthText('week', 1)).toBe('1 week')
    expect(dealLengthText('week', 4)).toBe('4 weeks')
    expect(dealLengthText('month', 1)).toBe('1 month')
    expect(dealLengthText('month', 3)).toBe('3 months')
    expect(periodLabel('week', '2026-11-16')).toBe('the week of Nov 16')
    expect(periodLabel('week', '2026-09-28')).toBe('the week of Sep 28')
    expect(periodLabel('month', '2026-11')).toBe('November')
    expect(periodLabel('month', '2027-01')).toBe('January')
    expect(positionText('week', 2, 4)).toBe('Week 2 of 4')
    expect(positionText('month', 1, 3)).toBe('Month 1 of 3')
  })

  it('startPhrase: this week, next week, the week of, in December', () => {
    const now = at('2026-11-09T10:00')
    expect(startPhrase('week', W1, now, TZ)).toBe('this week')
    expect(startPhrase('week', W2, now, TZ)).toBe('next week')
    expect(startPhrase('week', W3, now, TZ)).toBe('the week of Nov 23')
    // Sunday night is still the week before.
    expect(startPhrase('week', W1, at('2026-11-08T23:00'), TZ)).toBe('next week')
    expect(startPhrase('month', '2026-12', now, TZ)).toBe('in December')
    expect(startPhrase('month', '2026-11', now, TZ)).toBe('in November')
  })
})

// ---------- Friends and terms ----------

describe('friends and terms', () => {
  it('dealFriends: current members but the person and judges (stale judge entries ignored), in member order', () => {
    const sp = space({ memberIds: ['sam', 'lena', 'kim', 'ana'], judges: ['kim', 'gone', 'kim'] })
    expect(dealFriends(sp, 'lena')).toEqual(['sam', 'ana'])
    expect(dealFriends(sp, 'kim')).toEqual(['sam', 'lena', 'ana'])
    expect(dealFriends(space({ memberIds: ['lena'] }), 'lena')).toEqual([])
    expect(dealFriends(space({ memberIds: ['lena', 'sam'], judges: ['sam'] }), 'lena')).toEqual([])
  })

  it('dealPairTerms for each mode combination, and a missing entry', () => {
    const per = { sam: { reward: 'Lunch', penalty: 'A coffee' } }
    expect(dealPairTerms(deal(), 'sam')).toEqual({ reward: 'Dinner, on us', penalty: 'Coffee for a week', rewardTogether: true, penaltyTogether: true })
    expect(dealPairTerms(deal(), 'nobody')).toEqual({ reward: 'Dinner, on us', penalty: 'Coffee for a week', rewardTogether: true, penaltyTogether: true })
    expect(dealPairTerms(deal({ rewardMode: 'each', per }), 'sam')).toEqual({ reward: 'Lunch', penalty: 'Coffee for a week', rewardTogether: false, penaltyTogether: true })
    expect(dealPairTerms(deal({ penaltyMode: 'each', per }), 'sam')).toEqual({ reward: 'Dinner, on us', penalty: 'A coffee', rewardTogether: true, penaltyTogether: false })
    expect(dealPairTerms(deal({ rewardMode: 'each', penaltyMode: 'each', per }), 'sam')).toEqual({ reward: 'Lunch', penalty: 'A coffee', rewardTogether: false, penaltyTogether: false })
    expect(dealPairTerms(deal({ rewardMode: 'each', per }), 'kim')).toBeNull()
    expect(dealPairTerms(deal({ penaltyMode: 'each', per }), 'kim')).toBeNull()
  })

  const input = (x: Partial<DealInput> = {}): DealInput => ({ unit: 'week', count: 4, rewardMode: 'group', penaltyMode: 'group', reward: 'Dinner', penalty: 'Coffee', per: {}, ...x })

  it('cleanDeal: trims, keeps per only for friends, blanks a line that isn’t per friend, {} without a per-friend line', () => {
    expect(cleanDeal(input({ reward: '  Dinner ', penalty: '\tCoffee\n', per: { sam: { reward: 'x', penalty: 'y' } } }), ['sam'])).toEqual(input())
    const each = cleanDeal(
      input({ rewardMode: 'each', per: { sam: { reward: ' Lunch ', penalty: 'kept?' }, kim: { reward: 'Tea', penalty: '' }, lena: { reward: 'me', penalty: '' }, ana: { reward: 'gone', penalty: '' } } }),
      ['kim', 'sam'],
    )
    expect(each.per).toEqual({ kim: { reward: 'Tea', penalty: '' }, sam: { reward: 'Lunch', penalty: '' } })
    expect(Object.keys(each.per)).toEqual(['kim', 'sam'])
    expect(cleanDeal(input({ penaltyMode: 'each', per: { sam: { reward: 'r', penalty: ' A beer ' } } }), ['sam', 'kim']).per).toEqual({ sam: { reward: '', penalty: 'A beer' } })
    // Unknown unit and modes read as the defaults.
    const odd = cleanDeal({ ...input(), unit: 'day' as never, rewardMode: 'x' as never }, ['sam'])
    expect([odd.unit, odd.rewardMode]).toEqual(['week', 'group'])
  })

  it('dealProblem: each problem, and dealProblemText’s exact words', () => {
    const friends = ['sam', 'kim']
    const long = 'x'.repeat(121)
    const cases: [DealInput, UID[], DealProblem | null][] = [
      [input(), friends, null],
      [input(), [], 'no-friends'],
      [input({ count: 0 }), friends, 'count'],
      [input({ count: 13 }), friends, 'count'],
      [input({ count: 2.5 }), friends, 'count'],
      [input({ count: 12, unit: 'month' }), friends, null],
      [input({ reward: long }), friends, 'long'],
      [input({ reward: ` ${'x'.repeat(120)} ` }), friends, null],
      [input({ rewardMode: 'each', reward: long, per: { sam: { reward: 'a', penalty: '' }, kim: { reward: 'b', penalty: '' } } }), friends, 'long'],
      [input({ penaltyMode: 'each', per: { sam: { reward: '', penalty: long }, kim: { reward: '', penalty: 'b' } } }), friends, 'long'],
      [input({ reward: '   ' }), friends, 'fill-group'],
      [input({ penalty: '' }), friends, 'fill-group'],
      [input({ rewardMode: 'each', reward: '', per: { sam: { reward: 'a', penalty: '' }, kim: { reward: 'b', penalty: '' } } }), friends, null],
      [input({ rewardMode: 'each', per: { sam: { reward: 'a', penalty: '' } } }), friends, 'fill-reward-each'],
      [input({ rewardMode: 'each', per: { sam: { reward: 'a', penalty: '' }, kim: { reward: ' ', penalty: '' } } }), friends, 'fill-reward-each'],
      [input({ penaltyMode: 'each', per: { sam: { reward: '', penalty: 'a' }, kim: { reward: '', penalty: '' } } }), friends, 'fill-penalty-each'],
      [input({ rewardMode: 'each', penaltyMode: 'each', per: { sam: { reward: 'a', penalty: 'b' }, kim: { reward: 'c', penalty: 'd' } } }), friends, null],
    ]
    for (const [i, friendsOf, problem] of cases) expect(dealProblem(i, friendsOf), JSON.stringify(i)).toBe(problem)
    expect(dealProblemText('count')).toBe('Pick how long: 1 to 12 weeks or months.')
    expect(dealProblemText('fill-group')).toBe('Fill in what they owe you and what you owe them.')
    expect(dealProblemText('fill-reward-each')).toBe('Fill in what each friend owes you, or make it the same for everyone.')
    expect(dealProblemText('fill-penalty-each')).toBe('Fill in what you owe each friend, or make it the same for everyone.')
    expect(dealProblemText('long')).toBe('Keep each one under 120 characters.')
    expect(dealProblemText('no-friends')).toBe('Deals need a friend who plays. Invite one first.')
  })
})

// ---------- Start: the first period that locks at least a day after everyone agreed ----------

describe('start (firstPeriodAfter, a day’s notice)', () => {
  const first = (iso: string, sp: Space = SP, unit: 'week' | 'month' = 'week', known?: Parameters<typeof dealClock>[2]) =>
    firstPeriodAfter(sp, unit, at(iso, sp.timezone), dealClock(sp, unit, known))

  it('weeks, usual times: by Monday 00:00 this week (exactly a day counts), later next week', () => {
    expect(first('2026-11-08T23:59')).toBe(W1)
    expect(first('2026-11-09T00:00')).toBe(W1)
    expect(first('2026-11-09T00:01')).toBe(W2)
    expect(first('2026-11-09T23:59')).toBe(W2)
    expect(first('2026-11-11T12:00')).toBe(W2)
    expect(first('2026-11-15T23:59')).toBe(W2)
  })

  it('own times: lists lock Monday 8 PM, or at Monday 00:00 (then late on a Sunday skips a week)', () => {
    const eight = space({ schedule: { lock: 1200, reviewOpen: 5760, deadline: 7200 } })
    expect(first('2026-11-08T20:00', eight)).toBe(W1)
    expect(first('2026-11-08T20:01', eight)).toBe(W2)
    const zero = space({ schedule: { lock: 0, reviewOpen: 5760, deadline: 7200 } })
    expect(first('2026-11-07T23:59', zero)).toBe(W1)
    expect(first('2026-11-08T00:00', zero)).toBe(W1)
    expect(first('2026-11-08T00:01', zero)).toBe(W2)
    expect(first('2026-11-08T23:59', zero)).toBe(W2)
  })

  it('a stored lock an hour off the computed one rules', () => {
    const stored: Week = { id: W1, spaceId: 's1', ...B(W1), lockAt: B(W1).lockAt + H, members: [], submittedBy: [] }
    expect(first('2026-11-09T00:30')).toBe(W2)
    expect(first('2026-11-09T00:30', SP, 'week', { weeks: { [W1]: stored } })).toBe(W1)
    expect(first('2026-11-09T01:00', SP, 'week', { weeks: { [W1]: stored } })).toBe(W1)
    expect(first('2026-11-09T01:01', SP, 'week', { weeks: { [W1]: stored } })).toBe(W2)
    // A doc filed under another id is ignored.
    expect(first('2026-11-09T00:30', SP, 'week', { weeks: { [W1]: { ...stored, id: W2 } } })).toBe(W2)
  })

  it('DST weeks in Berlin, Los Angeles, Kiritimati and Kolkata: exactly 24 hours before the lock still starts it', () => {
    const cases: [string, WeekId, WeekSchedule | undefined][] = [
      ['Europe/Berlin', '2027-03-29', undefined], // the week after spring forward
      ['Europe/Berlin', '2027-03-22', { lock: 7 * 1440 - 60, reviewOpen: 9000, deadline: 10080 }], // lock Sunday 23:00, on the 23-hour day
      ['Europe/Berlin', '2026-10-26', { lock: 0, reviewOpen: 5760, deadline: 7200 }], // lock Monday 00:00 after the 25-hour Sunday
      ['Europe/Berlin', '2026-10-19', { lock: 6 * 1440 + 600, reviewOpen: 9000, deadline: 10080 }], // lock Sunday 10:00, on the 25-hour day
      ['America/Los_Angeles', '2026-11-02', { lock: 0, reviewOpen: 5760, deadline: 7200 }], // after fall back (Nov 1)
      ['America/Los_Angeles', '2027-03-15', { lock: 0, reviewOpen: 5760, deadline: 7200 }], // after spring forward (Mar 14)
      ['America/Los_Angeles', '2027-03-15', undefined],
      ['Pacific/Kiritimati', '2026-11-09', undefined],
      ['Asia/Kolkata', '2026-11-09', undefined],
    ]
    for (const [tz, weekId, schedule] of cases) {
      const sp = space({ timezone: tz, schedule })
      const clock = dealClock(sp, 'week')
      const l = B(weekId, tz, schedule).lockAt
      expect(clock.lockOf(weekId), `${tz} ${weekId}`).toBe(l)
      expect(agreeBy(weekId, clock), `${tz} ${weekId}`).toBe(l - 24 * H)
      expect(firstPeriodAfter(sp, 'week', l - 24 * H, clock), `${tz} ${weekId}`).toBe(weekId)
      expect(firstPeriodAfter(sp, 'week', l - 24 * H + 1, clock), `${tz} ${weekId}`).toBe(nextPeriod('week', weekId))
    }
    // On the 25-hour Sunday a lock at Monday 00:00 needs the Agree by Sunday 01:00, not Saturday midnight.
    const zero = space({ schedule: { lock: 0, reviewOpen: 5760, deadline: 7200 } })
    expect(agreeBy('2026-10-26', dealClock(zero, 'week'))).toBe(at('2026-10-25T01:00'))
    // After the 23-hour Sunday (spring forward), Monday's lock at Tuesday 00:00 needs it by Monday 00:00 as usual.
    expect(agreeBy('2027-03-29', dealClock(SP, 'week'))).toBe(at('2027-03-29T00:00'))
  })

  it('months: by a day before the month’s first lock that month, else the next', () => {
    expect(first('2026-11-02T00:00', SP, 'month')).toBe('2026-11')
    expect(first('2026-11-02T00:01', SP, 'month')).toBe('2026-12')
    expect(first('2026-11-01T23:59', SP, 'month')).toBe('2026-11')
    expect(first('2026-10-26T12:00', SP, 'month')).toBe('2026-11')
    expect(first('2026-10-14T12:00', SP, 'month')).toBe('2026-11')
    expect(first('2026-11-18T12:00', SP, 'month')).toBe('2026-12')
    // January 2027's first week starts Monday Dec 28 2026.
    expect(weekIdsInMonth('2027-01')[0]).toBe('2026-12-28')
    expect(first('2026-12-28T00:00', SP, 'month')).toBe('2027-01')
    expect(first('2026-12-28T00:01', SP, 'month')).toBe('2027-02')
    expect(first('2026-12-27T12:00', SP, 'month')).toBe('2027-01')
    // Lists locking at Monday 00:00: late on the Sunday before a month skips it.
    const zero = space({ schedule: { lock: 0, reviewOpen: 5760, deadline: 7200 } })
    expect(first('2026-10-31T23:00', zero, 'month')).toBe('2026-11')
    expect(first('2026-11-01T12:00', zero, 'month')).toBe('2026-12')
  })

  it('months: a stored first-week lock rules; agreeBy is a day before it', () => {
    const stored: Week = { id: '2026-11-02', spaceId: 's1', ...B('2026-11-02'), lockAt: B('2026-11-02').lockAt + H, members: [], submittedBy: [] }
    expect(first('2026-11-02T00:30', SP, 'month')).toBe('2026-12')
    expect(first('2026-11-02T00:30', SP, 'month', { weeks: { '2026-11-02': stored } })).toBe('2026-11')
    const clock = dealClock(SP, 'month', { weeks: { '2026-11-02': stored } })
    expect(agreeBy('2026-11', clock)).toBe(stored.lockAt - 24 * H)
    expect(dealClock(SP, 'month').weekLocks('2026-11')).toEqual(weekIdsInMonth('2026-11').map((w) => lock(w)))
    expect(clock.weekLocks('2026-11')[0]).toBe(stored.lockAt)
  })
})

// ---------- Agreement ----------

describe('agreement', () => {
  const now = at('2026-11-07T12:00')

  it('waiting: needed and waitingFor in friends order; where it would start', () => {
    const s = dealState(deal({ friends: ['sam', 'kim', 'ana'], agreed: { kim: SAM_AGREE } }), space({ memberIds: ['lena', 'sam', 'kim', 'ana'] }), now, WEEKS)
    expect(s.phase).toBe('waiting')
    expect(s.needed).toEqual(['sam', 'kim', 'ana'])
    expect(s.waitingFor).toEqual(['sam', 'ana'])
    expect(s.agreedAt).toBeNull()
    expect(s.start).toBe(W1)
    expect(s.parties).toEqual([])
    expect(s.callOff).toEqual({ asked: [], waitingFor: [], completeAt: null })
    // On Monday morning it would start next week.
    expect(dealState(deal(), SP, at('2026-11-09T10:00'), WEEKS).start).toBe(W2)
  })

  it('fully agreed: agreedAt is the latest Agree; scheduled before the start’s lock, running after', () => {
    const s = dealState(agreedDeal(), SP, at('2026-11-09T10:00'), WEEKS)
    expect(s.phase).toBe('scheduled')
    expect(s.agreedAt).toBe(KIM_AGREE)
    expect(s.start).toBe(W1)
    expect(s.waitingFor).toEqual([])
    expect(s.parties).toEqual(['sam', 'kim'])
    expect(s.current).toBe(W1)
    expect(s.position).toBe(1)
    expect(dealState(agreedDeal(), SP, lock(W1), WEEKS).phase).toBe('running')
  })

  it('a friend leaving without agreeing unblocks it at their leftAt; coming back blocks it again', () => {
    const left = space({ memberIds: ['lena', 'sam'], leftAt: { kim: at('2026-11-08T09:00') } })
    const s = dealState(deal({ agreed: { sam: SAM_AGREE } }), left, now, WEEKS)
    expect(s.phase).toBe('scheduled')
    expect(s.needed).toEqual(['sam'])
    expect(s.agreedAt).toBe(at('2026-11-08T09:00'))
    // Left before Sam agreed: Sam's Agree is the moment.
    const earlier = space({ memberIds: ['lena', 'sam'], leftAt: { kim: at('2026-11-06T12:00') } })
    expect(dealState(deal({ agreed: { sam: SAM_AGREE } }), earlier, now, WEEKS).agreedAt).toBe(SAM_AGREE)
    // Back before the job stamped it: waiting for Kim again.
    const back = space({ leftAt: { kim: at('2026-11-08T09:00') }, joinedAt: { ...SP.joinedAt, kim: at('2026-11-08T10:00') } })
    const again = dealState(deal({ agreed: { sam: SAM_AGREE } }), back, now, WEEKS)
    expect(again.phase).toBe('waiting')
    expect(again.waitingFor).toEqual(['kim'])
  })

  it('every friend gone: waiting with nobody needed; its person gone: never fully agreed', () => {
    const alone = dealState(deal({ agreed: { sam: SAM_AGREE } }), space({ memberIds: ['lena'], leftAt: { sam: now, kim: now } }), now, WEEKS)
    expect(alone.phase).toBe('waiting')
    expect(alone.needed).toEqual([])
    expect(alone.waitingFor).toEqual([])
    const personLeft = dealState(agreedDeal(), space({ memberIds: ['sam', 'kim'], leftAt: { lena: now } }), now, WEEKS)
    expect(personLeft.phase).toBe('waiting')
    expect(personLeft.agreedAt).toBeNull()
  })

  it('a friend who turned judge after the proposal is still needed (and a party)', () => {
    const judging = space({ judges: ['kim'] })
    expect(dealState(deal({ agreed: { sam: SAM_AGREE } }), judging, now, WEEKS).waitingFor).toEqual(['kim'])
    expect(dealState(agreedDeal(), judging, lock(W1), WEEKS).parties).toEqual(['sam', 'kim'])
  })

  it('the job’s stamps win over the computed values', () => {
    const stamped = agreedDeal({ agreedAt: SAM_AGREE, start: W3 })
    const s = dealState(stamped, SP, at('2026-11-12T12:00'), WEEKS)
    expect(s.agreedAt).toBe(SAM_AGREE)
    expect(s.start).toBe(W3)
    expect(s.phase).toBe('scheduled')
    // Stamped, so a friend who left and came back without agreeing doesn't make it wait again.
    const back = space({ leftAt: { kim: at('2026-11-08T09:00') }, joinedAt: { ...SP.joinedAt, kim: at('2026-11-08T10:00') } })
    expect(dealState(deal({ agreed: { sam: SAM_AGREE }, ...STAMPED }), back, at('2026-11-09T12:00'), WEEKS).phase).toBe('scheduled')
    // A start stamp alone (agreedAt unreadable) still reads as agreed.
    const startOnly = dealState(deal({ start: W1 }), SP, lock(W1) + H, WEEKS)
    expect([startOnly.phase, startOnly.start, startOnly.agreedAt, startOnly.parties]).toEqual(['running', W1, null, []])
  })
})

describe('parties', () => {
  it('agreed friends in the space at the start’s lock; left before it: not a party; after it: still one', () => {
    const before = space({ memberIds: ['lena', 'sam', 'kim', 'ana'] })
    const d = deal({ friends: ['sam', 'kim', 'ana'], agreed: { sam: SAM_AGREE, kim: SAM_AGREE, ana: KIM_AGREE }, ...STAMPED })
    expect(dealState(d, before, at('2026-11-09T12:00'), WEEKS).parties).toEqual(['sam', 'kim', 'ana'])
    // Ana left on Monday, before the lock: not a party (before the lock: agreed and still members).
    const anaLeft = space({ memberIds: ['lena', 'sam', 'kim'], leftAt: { ana: at('2026-11-09T12:00') } })
    expect(dealState(d, anaLeft, at('2026-11-09T13:00'), WEEKS).parties).toEqual(['sam', 'kim'])
    expect(dealState(d, anaLeft, lock(W1) + H, WEEKS).parties).toEqual(['sam', 'kim'])
    // Kim left on Wednesday, after the lock: still a party, and on the debt lines.
    const kimLeft = space({ memberIds: ['lena', 'sam', 'ana'], leftAt: { kim: at('2026-11-11T12:00') } })
    const s = dealState(d, kimLeft, at('2026-11-12T12:00'), WEEKS)
    expect(s.parties).toEqual(['sam', 'kim', 'ana'])
    expect(s.needed).toEqual(['sam', 'ana'])
    const won = { ...d, ended: { outcome: 'won' as const, at: dl(W2), period: W2 } }
    expect(dealDebtLines(won, dealState(won, kimLeft, dl(W2) + H, WEEKS).parties)[0].debtors).toEqual(['sam', 'kim', 'ana'])
  })
})

// ---------- The weeks walk ----------

describe('weeks walk', () => {
  const four = agreedDeal({ count: 4 })

  it('four passes: won at the fourth deadline, until then running', () => {
    const periods = [W1, W2, W3, W4].map(PASS)
    const s = dealState(four, SP, dl(W4) + H, WEEKS, periods)
    expect(s.phase).toBe('running')
    expect(s.end).toEqual({ outcome: 'won', at: dl(W4), period: W4 })
    expect(s.provisional).toBe(true)
    expect(s.passes).toBe(4)
    expect(s.position).toBe(4)
    expect(s.track).toEqual(periods)
    expect(s.current).toBeNull()
    const mid = dealState(four, SP, dl(W2) + H, WEEKS, periods.slice(0, 2))
    expect([mid.passes, mid.position, mid.current, mid.end, mid.pending]).toEqual([2, 3, W3, null, null])
    // extra beyond what's final is ignored.
    expect(dealState(four, SP, dl(W2) + H, WEEKS, periods).track).toEqual(periods.slice(0, 2))
  })

  it('a miss in week 2: lost at its deadline with its score', () => {
    const s = dealState(four, SP, dl(W2) + H, WEEKS, [PASS(W1), wk(W2, { tasks: 25, done: 21 })])
    expect(s.end).toEqual({ outcome: 'lost', at: dl(W2), period: W2, score: 84 })
    expect(s.track.map((p) => p.result)).toEqual(['pass', 'miss'])
  })

  it('a paused week is a skip: won after 5 weeks', () => {
    const paused = space({ paused: { '2026-11': W2 } })
    const periods = [W1, W2, W3, W4, W5].map((w) => wk(w, {}, paused))
    expect(periods[1]).toEqual({ id: W2, result: 'skip', score: null, why: 'paused' })
    const s = dealState(four, paused, dl(W5) + H, WEEKS, periods)
    expect(s.end).toEqual({ outcome: 'won', at: dl(W5), period: W5 })
    expect([s.passes, s.skips]).toEqual([4, 1])
  })

  it('week results: excused, no doc, judged, nothing planned, missed reviews', () => {
    expect(wk(W1, { excused: true })).toEqual({ id: W1, result: 'skip', score: null, why: 'excused' })
    expect(wk(W1, { noDoc: true })).toEqual({ id: W1, result: 'skip', score: null, why: 'missing' })
    expect(wk(W1, { judges: ['lena'] })).toEqual({ id: W1, result: 'miss', score: null, why: 'judge' })
    expect(wk(W1, { tasks: 0 })).toEqual({ id: W1, result: 'miss', score: 0, why: 'empty' })
    expect(wk(W1, { tasks: 0, missed: ['sam'] })).toEqual({ id: W1, result: 'miss', score: 0, missed: 1, why: 'empty' })
    expect(wk(W1, { tasks: 25, done: 23, missed: ['sam'] })).toEqual({ id: W1, result: 'miss', score: 87, missed: 1 })
    expect(wk(W1, { tasks: 20, done: 19, missed: ['kim'] })).toEqual({ id: W1, result: 'pass', score: 90, missed: 1 })
    expect(wk(W1, { tasks: 20, done: 18 })).toEqual({ id: W1, result: 'pass', score: 90 })
    const four = space({ memberIds: ['lena', 'sam', 'kim', 'ana'] })
    expect(wk(W1, { tasks: 10, done: 1, missed: ['sam', 'kim', 'ana'] }, four)).toEqual({ id: W1, result: 'miss', score: 0, missed: 3 })
    // Rounded before the bar: 95 − 5.0000000001 is 89.9999999999, which counts as 90.
    expect(wk(W1, { tasks: 20, done: 19, missed: ['kim'] }, space({ latePenalty: 5.0000000001 }))).toEqual({ id: W1, result: 'pass', score: 90, missed: 1 })
    // Not in the week (left before its lock, or not added back): a miss without a score.
    expect(wk(W1, { members: ['sam', 'kim'] })).toEqual({ id: W1, result: 'miss', score: null, why: 'left' })
  })

  it('judged, excused, no doc and nothing planned in the walk', () => {
    expect(dealState(four, SP, dl(W1) + H, WEEKS, [wk(W1, { judges: ['lena'] })]).end).toEqual({ outcome: 'lost', at: dl(W1), period: W1, score: null })
    expect(dealState(four, SP, dl(W1) + H, WEEKS, [wk(W1, { tasks: 0 })]).end).toEqual({ outcome: 'lost', at: dl(W1), period: W1, score: 0 })
    const skips = dealState(four, SP, dl(W2) + H, WEEKS, [wk(W1, { excused: true }), wk(W2, { noDoc: true })])
    expect([skips.end, skips.skips, skips.passes, skips.current, skips.position]).toEqual([null, 2, 0, W3, 1])
  })

  it('final only at the deadline, even when everyone submitted early', () => {
    const data = weekData(W1)
    expect(weekDealPeriod(SP, 'lena', data, dl(W1) - 1)).toBeNull()
    expect(weekDealPeriod(SP, 'lena', data, dl(W1))).toEqual({ id: W1, result: 'pass', score: 100 })
    // A stored deadline rules.
    const later = { ...data, week: { ...(data.week as Week), deadlineAt: dl(W1) + 2 * H } }
    expect(weekDealPeriod(SP, 'lena', later, dl(W1) + H)).toBeNull()
    const s = dealState(four, SP, dl(W1) - 1, WEEKS, [PASS(W1)])
    expect([s.passes, s.current, s.pending]).toEqual([0, W1, null])
  })

  it('pending once a deadline passed without a result; late after 24 hours', () => {
    const s = dealState(four, SP, dl(W1) + H, WEEKS)
    expect([s.pending, s.current, s.late, s.end]).toEqual([W1, W1, false, null])
    expect(dealState(four, SP, dl(W1) + DEAL_LATE_MS - 1, WEEKS).late).toBe(false)
    expect(dealState(four, SP, dl(W1) + DEAL_LATE_MS, WEEKS).late).toBe(true)
    // A stored track entry answers it.
    const tracked = { ...four, ...STAMPED, track: [PASS(W1)] }
    expect(dealState(tracked, SP, dl(W1) + 2 * D, WEEKS)).toMatchObject({ pending: null, late: false, passes: 1, current: W2 })
    // A provisional end left unconfirmed for a day is late too.
    expect(dealState(four, SP, dl(W1) + DEAL_LATE_MS, WEEKS, [wk(W1, { tasks: 0 })])).toMatchObject({ provisional: true, late: true })
  })

  it('a stored ended wins; a stored track is never re-judged', () => {
    const ended = { ...four, ...STAMPED, track: [PASS(W1), wk(W2, { tasks: 0 })], ended: { outcome: 'lost' as const, at: dl(W2), period: W2, score: 0 } }
    const s = dealState(ended, SP, dl(W3) + H, WEEKS, [PASS(W3)])
    expect(s.phase).toBe('lost')
    expect(s.end).toBe(ended.ended)
    expect(s.provisional).toBe(false)
    expect(s.track).toEqual(ended.track)
    expect([s.passes, s.position, s.current, s.pending]).toEqual([1, 2, null, null])
    // The stored pass stands, whatever `extra` says about that week.
    const tracked = { ...four, ...STAMPED, track: [PASS(W1)] }
    const again = dealState(tracked, SP, dl(W1) + H, WEEKS, [wk(W1, { tasks: 0 })])
    expect([again.passes, again.end, again.track]).toEqual([1, null, [PASS(W1)]])
    // Stored won/off as they are.
    expect(dealState({ ...four, ended: { outcome: 'off', at: 5, reason: 'alone' } }, SP, dl(W2), WEEKS).phase).toBe('off')
    expect(dealState({ ...deal(), ended: { outcome: 'withdrawn', at: 5, by: 'lena' } }, SP, dl(W2), WEEKS)).toMatchObject({ phase: 'withdrawn', start: null, parties: [] })
  })
})

// ---------- The months walk ----------

describe('months walk', () => {
  const NOV = '2026-11'
  const NOV_WEEKS = weekIdsInMonth(NOV)
  const MONTHS = dealClock(SP, 'month')
  const lb = monthlyBounds(NOV, (w) => B(w))

  function list(score: number, deadlineAt = lb.deadlineAt): MonthlyData {
    const n = 10
    const done = Math.round(score / 10)
    const marks = (k: number): Record<string, ReviewMark> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`lenam${i + 1}`, i < k ? 1 : 0]))
    return {
      spaceId: 's1',
      monthId: NOV,
      monthly: { id: NOV, spaceId: 's1', ...lb, deadlineAt, members: ['lena', 'sam', 'kim'], submittedBy: ['lena', 'sam', 'kim'], judges: [] },
      plans: { lena: { uid: 'lena', tasks: Array.from({ length: n }, (_, i) => ({ id: `lenam${i + 1}`, title: 'M' })), updatedAt: 0 } },
      progress: {},
      reviews: ['sam', 'kim'].map((r) => ({ id: `${r}_lena`, reviewerId: r, revieweeId: 'lena', marks: marks(done), submittedAt: 0 })),
    }
  }

  function month(spec: (w: WeekId, i: number) => WeekSpec = () => ({}), sp: Space = SP, monthly?: MonthlyData, nowMs = lb.deadlineAt + H) {
    const weeks = NOV_WEEKS.map((w, i) => weekData(w, spec(w, i), sp))
    const results = computeMonth(sp, NOV, weeks, nowMs, monthly)
    return { weeks, result: results.lena, period: monthDealPeriod('lena', results.lena, weeks) }
  }

  it('passed → pass; under 90 → miss; missed reviews count', () => {
    expect(month().period).toEqual({ id: NOV, result: 'pass', score: 100 })
    expect(month(() => ({ done: 8 })).period).toEqual({ id: NOV, result: 'miss', score: 80 })
    expect(month((_, i) => (i === 0 ? { missed: ['sam'] } : {})).period).toEqual({ id: NOV, result: 'pass', score: 95, missed: 1 })
  })

  it('the monthly list counts (one more score of the month)', () => {
    expect(month(() => ({}), SP, list(50)).period).toEqual({ id: NOV, result: 'pass', score: 90 })
    expect(month(() => ({}), SP, list(40)).period).toEqual({ id: NOV, result: 'miss', score: 88 })
  })

  it('judged only → miss; all paused or excused → skip; no doc → skip', () => {
    expect(month(() => ({ judges: ['lena'] })).period).toEqual({ id: NOV, result: 'miss', score: null, why: 'judge' })
    expect(month(() => ({ excused: true })).period).toEqual({ id: NOV, result: 'skip', score: null, why: 'no-score' })
    const paused = space({ paused: { [NOV]: NOV_WEEKS[0] } })
    expect(month((_, i) => (i === 0 ? {} : { noDoc: true }), paused).period).toEqual({ id: NOV, result: 'skip', score: null, why: 'no-score' })
    expect(month(() => ({ noDoc: true })).period).toEqual({ id: NOV, result: 'skip', score: null, why: 'no-score' })
    expect(monthDealPeriod('lena', undefined, [weekData(NOV_WEEKS[0], { noDoc: true })])).toEqual({ id: NOV, result: 'skip', score: null, why: 'missing' })
  })

  it('a week of the month without its person is a miss: left', () => {
    expect(month((_, i) => (i === 2 ? { members: ['sam', 'kim'] } : {})).period).toEqual({ id: NOV, result: 'miss', score: null, why: 'left' })
  })

  it('an incomplete month is null; complete only at the list’s later deadline', () => {
    expect(month(() => ({}), SP, undefined, dl(NOV_WEEKS[3]) - 1).period).toBeNull()
    const late = list(100, lb.deadlineAt + 6 * H)
    expect(month(() => ({}), SP, late, lb.deadlineAt + H).period).toBeNull()
    expect(month(() => ({}), SP, late, lb.deadlineAt + 6 * H).period).toEqual({ id: NOV, result: 'pass', score: 100 })
    expect(MONTHS.finalOf(NOV)).toBe(dl(NOV_WEEKS[3]))
    expect(dealClock(SP, 'month', { lists: { [NOV]: late.monthly as Week } }).finalOf(NOV)).toBe(lb.deadlineAt + 6 * H)
  })

  it('dealState over months: start, the month’s weeks, won at completion', () => {
    const d = deal({ unit: 'month', count: 2, agreed: { sam: at('2026-10-29T12:00'), kim: at('2026-10-30T12:00') } })
    const s0 = dealState(d, SP, at('2026-11-01T12:00'), MONTHS)
    expect([s0.phase, s0.start, s0.agreedAt]).toEqual(['scheduled', NOV, at('2026-10-30T12:00')])
    const p = month().period as DealPeriod
    const mid = dealState(d, SP, at('2026-11-18T12:00'), MONTHS)
    expect([mid.phase, mid.current, mid.pending]).toEqual(['running', NOV, null])
    const dec = { ...p, id: '2026-12' }
    const s = dealState(d, SP, MONTHS.finalOf('2026-12') + H, MONTHS, [p, dec])
    expect(s.end).toEqual({ outcome: 'won', at: MONTHS.finalOf('2026-12'), period: '2026-12' })
    const lost = dealState(d, SP, MONTHS.finalOf(NOV) + H, MONTHS, [month(() => ({ done: 8 })).period as DealPeriod])
    expect(lost.end).toEqual({ outcome: 'lost', at: MONTHS.finalOf(NOV), period: NOV, score: 80 })
  })
})

// ---------- Leaving ----------

describe('leaving', () => {
  const d = agreedDeal({ ...STAMPED, count: 3 })
  /** Lena gone at `t`. */
  const lenaLeft = (t: number, x: Partial<Space> = {}) => space({ memberIds: ['sam', 'kim'], leftAt: { lena: t }, ...x })

  it('the person leaves mid-week: that week still counts; a pass is followed by a left miss at the next lock', () => {
    const sp = lenaLeft(at('2026-11-11T12:00'))
    const miss = dealState(d, sp, dl(W1) + H, WEEKS, [wk(W1, { tasks: 25, done: 21 }, sp)])
    expect(miss.end).toEqual({ outcome: 'lost', at: dl(W1), period: W1, score: 84 })
    const pass = dealState(d, sp, lock(W2) + H, WEEKS, [wk(W1, {}, sp)])
    expect(pass.end).toEqual({ outcome: 'lost', at: lock(W2), period: W2, score: null })
    expect(pass.track).toEqual([{ id: W1, result: 'pass', score: 100 }, { id: W2, result: 'miss', score: null, why: 'left' }])
    // Before the next lock: still running, nothing decided.
    expect(dealState(d, sp, lock(W2) - 1, WEEKS, [wk(W1, {}, sp)]).end).toBeNull()
    // The pass was the last one: won.
    const one = { ...d, count: 1 }
    expect(dealState(one, sp, lock(W2) + H, WEEKS, [wk(W1, {}, sp)]).end).toEqual({ outcome: 'won', at: dl(W1), period: W1 })
  })

  it('removed after full agreement, before the start’s lock: lost (left) at it', () => {
    const sp = lenaLeft(at('2026-11-09T12:00'))
    const s = dealState(d, sp, lock(W1) + H, WEEKS)
    expect(s.end).toEqual({ outcome: 'lost', at: lock(W1), period: W1, score: null })
    expect(s.track).toEqual([{ id: W1, result: 'miss', score: null, why: 'left' }])
    expect(dealState(d, sp, lock(W1) - 1, WEEKS).phase).toBe('scheduled')
  })

  it('left before a lock and back after it: lost (left) at that lock', () => {
    const sp = space({ leftAt: { lena: lock(W2) - H }, joinedAt: { ...SP.joinedAt, lena: lock(W2) + H } })
    const s = dealState(d, sp, lock(W2) + 2 * H, WEEKS, [PASS(W1)])
    expect(s.end).toEqual({ outcome: 'lost', at: lock(W2), period: W2, score: null })
  })

  it('left and back before a lock, but the week doc doesn’t list them: a left miss at its deadline', () => {
    const sp = space({ leftAt: { lena: lock(W2) - 3 * H }, joinedAt: { ...SP.joinedAt, lena: lock(W2) - 2 * H } })
    const w2 = wk(W2, { members: ['sam', 'kim'] }, sp)
    const s = dealState(d, sp, dl(W2) + H, WEEKS, [PASS(W1), w2])
    expect(s.end).toEqual({ outcome: 'lost', at: dl(W2), period: W2, score: null })
    expect(s.track[1]).toEqual({ id: W2, result: 'miss', score: null, why: 'left' })
  })

  it('months: leaving after the month’s first week locked is lost at the next week’s lock', () => {
    const MONTHS = dealClock(SP, 'month')
    const m = agreedDeal({ unit: 'month', count: 1, agreedAt: KIM_AGREE, start: '2026-12' })
    const decWeeks = weekIdsInMonth('2026-12')
    const sp = lenaLeft(lock(decWeeks[0]) + H)
    const s = dealState(m, sp, lock(decWeeks[1]) + H, MONTHS)
    expect(s.end).toEqual({ outcome: 'lost', at: lock(decWeeks[1]), period: '2026-12', score: null })
    expect(s.track).toEqual([{ id: '2026-12', result: 'miss', score: null, why: 'left' }])
    expect(dealState(m, sp, lock(decWeeks[1]) - 1, MONTHS)).toMatchObject({ end: null, current: '2026-12' })
  })

  it('every party leaves: off (alone) at the next lock, after the week in progress counts; the person first', () => {
    const gone = space({ memberIds: ['lena'], leftAt: { sam: at('2026-11-11T12:00'), kim: at('2026-11-12T12:00') } })
    const s = dealState(d, gone, lock(W2) + H, WEEKS, [wk(W1, {}, gone)])
    expect(s.end).toEqual({ outcome: 'off', at: lock(W2), reason: 'alone' })
    expect(s.passes).toBe(1)
    // The week in progress missed: lost first.
    expect(dealState(d, gone, lock(W2) + H, WEEKS, [wk(W1, { tasks: 0 }, gone)]).end).toMatchObject({ outcome: 'lost', at: dl(W1) })
    // Lena left too, before the same lock: her miss comes first.
    const all = space({ memberIds: [], leftAt: { sam: at('2026-11-11T12:00'), kim: at('2026-11-12T12:00'), lena: at('2026-11-13T12:00') } })
    expect(dealState(d, all, lock(W2) + H, WEEKS, [wk(W1, {}, all)]).end).toEqual({ outcome: 'lost', at: lock(W2), period: W2, score: null })
    // Every agreed friend gone before the start: off at the start's lock.
    const early = space({ memberIds: ['lena'], leftAt: { sam: at('2026-11-09T09:00'), kim: at('2026-11-09T10:00') } })
    expect(dealState(d, early, lock(W1) + H, WEEKS).end).toEqual({ outcome: 'off', at: lock(W1), reason: 'alone' })
  })

  it('one party leaves: it goes on', () => {
    const kimLeft = space({ memberIds: ['lena', 'sam'], leftAt: { kim: at('2026-11-11T12:00') } })
    const s = dealState(d, kimLeft, dl(W3) + H, WEEKS, [W1, W2, W3].map((w) => wk(w, {}, kimLeft)))
    expect(s.end).toEqual({ outcome: 'won', at: dl(W3), period: W3 })
    expect(s.parties).toEqual(['sam', 'kim'])
  })

  it('a deal whose person left while it waited stays waiting', () => {
    const s = dealState(deal({ agreed: { sam: SAM_AGREE } }), lenaLeft(at('2026-11-07T12:00')), lock(W2) + H, WEEKS)
    expect([s.phase, s.end, s.agreedAt]).toEqual(['waiting', null, null])
  })
})

// ---------- Call Off ----------

describe('call off', () => {
  const d = agreedDeal({ ...STAMPED, count: 3 })
  const tue = at('2026-11-10T12:00')

  it('everyone taps before the start: off at the last tap (scheduled until then)', () => {
    const off = { lena: at('2026-11-09T08:00'), sam: at('2026-11-09T09:00'), kim: at('2026-11-09T10:00') }
    const s = dealState({ ...d, off }, SP, at('2026-11-09T11:00'), WEEKS)
    expect(s.phase).toBe('scheduled')
    expect(s.callOff).toEqual({ asked: ['lena', 'sam', 'kim'], waitingFor: [], completeAt: off.kim })
    expect(s.end).toEqual({ outcome: 'off', at: off.kim, reason: 'called-off' })
    expect(s.provisional).toBe(true)
  })

  it('while running, before the deadline: off at the last tap; the week in progress doesn’t count', () => {
    const off = { lena: tue, sam: tue + H, kim: tue + 2 * H }
    const s = dealState({ ...d, off }, SP, dl(W1) + H, WEEKS, [wk(W1, { tasks: 0 })])
    expect(s.end).toEqual({ outcome: 'off', at: tue + 2 * H, reason: 'called-off' })
    expect(s.track).toEqual([])
  })

  it('a miss whose deadline is before the last tap stands', () => {
    const off = { lena: tue, sam: tue, kim: dl(W1) + H }
    const s = dealState({ ...d, off }, SP, dl(W1) + 2 * H, WEEKS, [wk(W1, { tasks: 0 })])
    expect(s.end).toEqual({ outcome: 'lost', at: dl(W1), period: W1, score: 0 })
  })

  it('waitingFor; taps of people not in it are ignored', () => {
    const one = dealState({ ...d, off: { sam: tue } }, SP, tue + H, WEEKS)
    expect(one.callOff).toEqual({ asked: ['sam'], waitingFor: ['lena', 'kim'], completeAt: null })
    const none = dealState(d, SP, tue + H, WEEKS)
    expect(none.callOff).toEqual({ asked: [], waitingFor: ['lena', 'sam', 'kim'], completeAt: null })
    // Ana isn't in it; Kim agreed but left before the start and came back, so isn't a party.
    const sp = space({ memberIds: ['lena', 'sam', 'kim', 'ana'], leftAt: { kim: at('2026-11-09T09:00') }, joinedAt: { ...SP.joinedAt, kim: lock(W1) + H } })
    const s = dealState({ ...d, off: { lena: tue, ana: tue, kim: tue } }, sp, tue + H, WEEKS)
    expect(s.parties).toEqual(['sam'])
    expect(s.callOff).toEqual({ asked: ['lena'], waitingFor: ['sam'], completeAt: null })
    expect(dealState({ ...d, off: { lena: tue, ana: tue, kim: tue, sam: tue + H } }, sp, tue + 2 * H, WEEKS).callOff.completeAt).toBe(tue + H)
  })

  it('a party who left needn’t tap, but their leave dates it when later (lost, not off)', () => {
    // Lena and Sam tap Tuesday, the week misses at Saturday 00:00, Kim leaves Saturday 10:00 without tapping.
    const sp = space({ memberIds: ['lena', 'sam'], leftAt: { kim: at('2026-11-14T10:00') } })
    const s = dealState({ ...d, off: { lena: tue, sam: tue } }, sp, at('2026-11-14T12:00'), WEEKS, [wk(W1, { tasks: 0 }, sp)])
    expect(s.callOff.completeAt).toBe(at('2026-11-14T10:00'))
    expect(s.end).toEqual({ outcome: 'lost', at: dl(W1), period: W1, score: 0 })
    // Kim left Tuesday night instead: off from then.
    const early = space({ memberIds: ['lena', 'sam'], leftAt: { kim: tue + 3 * H } })
    expect(dealState({ ...d, off: { lena: tue, sam: tue } }, early, at('2026-11-14T12:00'), WEEKS, [wk(W1, { tasks: 0 }, early)]).end).toEqual({
      outcome: 'off',
      at: tue + 3 * H,
      reason: 'called-off',
    })
    // A party who tapped and left later: their tap dates it.
    const tapped = space({ memberIds: ['lena', 'sam'], leftAt: { kim: at('2026-11-14T11:00') } })
    const s2 = dealState({ ...d, off: { lena: tue, sam: tue, kim: at('2026-11-14T10:00') } }, tapped, at('2026-11-14T12:00'), WEEKS, [wk(W1, { tasks: 0 }, tapped)])
    expect(s2.callOff.completeAt).toBe(at('2026-11-14T10:00'))
    expect(s2.end).toMatchObject({ outcome: 'lost' })
  })

  it('every party gone: the person’s tap alone never completes; off (alone) at the next lock after the week counts', () => {
    const gone = space({ memberIds: ['lena'], leftAt: { sam: tue + H, kim: tue + 2 * H } })
    const s = dealState({ ...d, off: { lena: tue } }, gone, lock(W2) + H, WEEKS, [wk(W1, {}, gone)])
    expect(s.callOff).toEqual({ asked: ['lena'], waitingFor: [], completeAt: null })
    expect(s.end).toEqual({ outcome: 'off', at: lock(W2), reason: 'alone' })
    expect(dealState({ ...d, off: { lena: tue } }, gone, lock(W2) + H, WEEKS, [wk(W1, { tasks: 0 }, gone)]).end).toMatchObject({ outcome: 'lost', at: dl(W1) })
    // Both tapped, then both left: it was off while Sam and Kim were still in.
    const both = space({ memberIds: ['lena'], leftAt: { sam: tue + 5 * H, kim: tue + 6 * H } })
    expect(dealState({ ...d, off: { lena: tue, sam: tue + H, kim: tue + 2 * H } }, both, lock(W2) + H, WEEKS).end).toEqual({ outcome: 'off', at: tue + 2 * H, reason: 'called-off' })
  })

  it('the person must tap: one who left without tapping keeps it from completing', () => {
    const sp = space({ memberIds: ['sam', 'kim'], leftAt: { lena: tue + H } })
    expect(dealState({ ...d, off: { sam: tue, kim: tue } }, sp, tue + 2 * H, WEEKS).callOff).toEqual({ asked: ['sam', 'kim'], waitingFor: ['lena'], completeAt: null })
  })
})

// ---------- Debts ----------

describe('debts', () => {
  const parties = ['sam', 'kim']
  const per = { sam: { reward: 'Lunch', penalty: 'A coffee' }, kim: { reward: 'Tea', penalty: 'A beer' } }
  const won = agreedDeal({ ended: { outcome: 'won', at: 5, period: W2 } })
  const lost = agreedDeal({ ended: { outcome: 'lost', at: 5, period: W2, score: 80 } })

  it('won together: one line, every party a debtor; per friend: a line each', () => {
    expect(dealDebtLines(won, parties)).toEqual([
      { dealId: 'lena_1', subject: 'lena', kind: 'reward', what: 'Dinner, on us', together: true, debtors: ['sam', 'kim'], creditors: ['lena'], keys: ['sam', 'kim'] },
    ])
    expect(dealDebtLines({ ...won, rewardMode: 'each', per }, parties)).toEqual([
      { dealId: 'lena_1', subject: 'lena', kind: 'reward', what: 'Lunch', together: false, debtors: ['sam'], creditors: ['lena'], keys: ['sam'] },
      { dealId: 'lena_1', subject: 'lena', kind: 'reward', what: 'Tea', together: false, debtors: ['kim'], creditors: ['lena'], keys: ['kim'] },
    ])
  })

  it('lost together or per friend: the person owes the parties', () => {
    expect(dealDebtLines(lost, parties)).toEqual([
      { dealId: 'lena_1', subject: 'lena', kind: 'penalty', what: 'Coffee for a week', together: true, debtors: ['lena'], creditors: ['sam', 'kim'], keys: ['sam', 'kim'] },
    ])
    expect(dealDebtLines({ ...lost, penaltyMode: 'each', per }, parties).map((l) => [l.what, l.debtors, l.creditors, l.keys])).toEqual([
      ['A coffee', ['lena'], ['sam'], ['sam']],
      ['A beer', ['lena'], ['kim'], ['kim']],
    ])
  })

  it('off, withdrawn and in play owe nothing', () => {
    expect(dealDebtLines(agreedDeal({ ended: { outcome: 'off', at: 5, reason: 'called-off' } }), parties)).toEqual([])
    expect(dealDebtLines(deal({ ended: { outcome: 'withdrawn', at: 5, by: 'lena' } }), parties)).toEqual([])
    expect(dealDebtLines(agreedDeal(), parties)).toEqual([])
  })

  it('dealLineSettled: none, partial, all (with the newest mark)', () => {
    const [line] = dealDebtLines(won, parties)
    expect(dealLineSettled(won, line)).toEqual({ settled: false })
    const partial = { ...won, settled: { sam: { settled: true, by: 'lena', at: 10 } } }
    expect(dealLineSettled(partial, line)).toEqual({ settled: false })
    const unsettled = { ...won, settled: { sam: { settled: true, by: 'lena', at: 10 }, kim: { settled: false, by: 'lena', at: 12 } } }
    expect(dealLineSettled(unsettled, line)).toEqual({ settled: false })
    const all = { ...won, settled: { sam: { settled: true, by: 'lena', at: 10 }, kim: { settled: true, by: 'kim', at: 12 } } }
    expect(dealLineSettled(all, line)).toEqual({ settled: true, last: { settled: true, by: 'kim', at: 12 } })
    expect(dealLineSettled(all, { keys: [] })).toEqual({ settled: false })
  })
})

// ---------- Same Again ----------

describe('Same Again', () => {
  const per = { sam: { reward: 'Lunch', penalty: '' }, kim: { reward: 'Tea', penalty: '' } }
  const last = agreedDeal({ unit: 'month', count: 3, rewardMode: 'each', reward: '', per, ended: { outcome: 'won', at: 5, period: '2026-12' } })

  it('copies unit, length, modes and texts; drops friends who left; asks for a newcomer’s text', () => {
    expect(sameAgain(last, ['sam', 'kim'])).toEqual({
      input: { unit: 'month', count: 3, rewardMode: 'each', penaltyMode: 'group', reward: '', penalty: 'Coffee for a week', per },
      missing: [],
    })
    expect(sameAgain(last, ['sam'])).toEqual({ input: { ...sameAgain(last, ['sam', 'kim']).input, per: { sam: per.sam } }, missing: [] })
    expect(sameAgain(last, ['sam', 'ana']).missing).toEqual(['ana'])
    // Both lines for everyone: nothing missing, no per-friend texts.
    const group = agreedDeal({ ended: { outcome: 'lost', at: 5 } })
    expect(sameAgain(group, ['sam', 'ana'])).toEqual({
      input: { unit: 'week', count: 2, rewardMode: 'group', penaltyMode: 'group', reward: 'Dinner, on us', penalty: 'Coffee for a week', per: {} },
      missing: [],
    })
    expect(dealProblem(sameAgain(last, ['sam', 'kim']).input, ['sam', 'kim'])).toBeNull()
  })

  it('lastPlayedDeal skips withdrawn and in-play deals and picks the newest', () => {
    const d = (seq: number, ended: Deal['ended'], uid = 'lena') => deal({ id: `${uid}_${seq}`, uid, seq, ended })
    const deals = [
      d(1, { outcome: 'won', at: 1 }),
      d(3, { outcome: 'off', at: 3, reason: 'alone' }),
      d(2, { outcome: 'lost', at: 2 }),
      d(4, { outcome: 'withdrawn', at: 4, by: 'lena' }),
      d(5, null),
      d(9, { outcome: 'won', at: 9 }, 'sam'),
    ]
    expect(lastPlayedDeal(deals, 'lena')?.seq).toBe(3)
    expect(lastPlayedDeal(deals, 'sam')?.seq).toBe(9)
    expect(lastPlayedDeal(deals, 'kim')).toBeNull()
    expect(lastPlayedDeal([d(1, { outcome: 'withdrawn', at: 1, by: 'lena' })], 'lena')).toBeNull()
  })
})

// ---------- What the job loads ----------

describe('dealPeriodsToLoad', () => {
  const d = agreedDeal({ ...STAMPED, count: 3 })

  it('only final periods after the track, in order, as many as could still be needed', () => {
    expect(dealPeriodsToLoad(d, SP, lock(W1) + H, WEEKS)).toEqual([])
    expect(dealPeriodsToLoad(d, SP, dl(W1) + H, WEEKS)).toEqual([W1])
    expect(dealPeriodsToLoad(d, SP, dl(W3) + H, WEEKS)).toEqual([W1, W2, W3])
    expect(dealPeriodsToLoad(d, SP, dl(W5) + H, WEEKS)).toEqual([W1, W2, W3])
    expect(dealPeriodsToLoad({ ...d, track: [PASS(W1)] }, SP, dl(W5) + H, WEEKS)).toEqual([W2, W3])
    expect(dealPeriodsToLoad({ ...d, track: [PASS(W1), wk(W2, { noDoc: true })] }, SP, dl(W5) + H, WEEKS)).toEqual([W3, W4])
    const long = { ...d, count: 8 }
    expect(dealPeriodsToLoad(long, SP, dl(W5) + H, WEEKS)).toEqual([W1, W2, W3, W4, W5])
  })

  it('none after an end at a lock (everyone else left, the person left), a Call Off, while waiting or once ended', () => {
    const gone = space({ memberIds: ['lena'], leftAt: { sam: at('2026-11-11T12:00'), kim: at('2026-11-12T12:00') } })
    expect(dealPeriodsToLoad(d, gone, dl(W4) + H, WEEKS)).toEqual([W1])
    const left = space({ memberIds: ['sam', 'kim'], leftAt: { lena: at('2026-11-18T12:00') } })
    expect(dealPeriodsToLoad(d, left, dl(W4) + H, WEEKS)).toEqual([W1, W2])
    const off = { lena: at('2026-11-18T12:00'), sam: at('2026-11-18T13:00'), kim: at('2026-11-18T14:00') }
    expect(dealPeriodsToLoad({ ...d, off }, SP, dl(W4) + H, WEEKS)).toEqual([W1])
    expect(dealPeriodsToLoad(deal(), SP, dl(W4) + H, WEEKS)).toEqual([])
    expect(dealPeriodsToLoad({ ...d, ended: { outcome: 'won', at: dl(W3), period: W3 } }, SP, dl(W4) + H, WEEKS)).toEqual([])
  })

  it('months: the final months, each one load', () => {
    const m = agreedDeal({ unit: 'month', count: 2, agreedAt: KIM_AGREE, start: '2026-12' })
    const clock = dealClock(SP, 'month')
    expect(dealPeriodsToLoad(m, SP, clock.finalOf('2026-12') - 1, clock)).toEqual([])
    expect(dealPeriodsToLoad(m, SP, clock.finalOf('2027-01') + H, clock)).toEqual(['2026-12', '2027-01'])
  })
})
