import { describe, expect, it } from 'vitest'
import type { Checkin, SharedGoal } from '../../domain/types.ts'
import {
  amountText,
  bigNumber,
  checkedInToast,
  checkinFooter,
  checkinHeader,
  dayText,
  editTargetFooter,
  endsSoon,
  finishConfirm,
  finishedGoals,
  finishedSubtitle,
  inviteSubtitle,
  invitedYou,
  joinedToast,
  leaveConfirm,
  momentOthers,
  momentText,
  monDay,
  newInviteFooter,
  ofTarget,
  peopleText,
  progressLine,
  rowSubtitle,
  sectionGoals,
  shareSubtitle,
  spotsLeft,
  spotsLeftFooter,
  statusLine,
  teamTotal,
  thisWeekHeader,
  todayId,
  unitChips,
  unitFor,
  weekRange,
  weeksFooter,
} from './copy.ts'

const BERLIN = 'Europe/Berlin'
const HOUR = 3_600_000
const DAY = 24 * HOUR
// Tuesday, October 20, 2026, 10:00 in Berlin.
const NOW = Date.UTC(2026, 9, 20, 8)

function goal(over: Partial<SharedGoal> = {}): SharedGoal {
  return {
    id: 'g1',
    name: 'Run 100 km',
    unit: 'km',
    target: 100,
    endsOn: null,
    timezone: BERLIN,
    utcOffsetMin: 120,
    zones: { ana: BERLIN },
    ownerId: 'ana',
    createdBy: 'ana',
    memberIds: ['ana', 'ben', 'cleo'],
    invited: [],
    joinedAt: { ana: NOW - 10 * DAY, ben: NOW - 9 * DAY, cleo: NOW - 8 * DAY },
    leftAt: {},
    totals: { ana: 30, ben: 20, cleo: 14 },
    total: 64,
    last: null,
    reachedAt: null,
    archivedAt: null,
    createdAt: NOW - 10 * DAY,
    ...over,
  }
}

function checkin(over: Partial<Checkin> = {}): Checkin {
  return {
    id: '2026-10-19_ana',
    uid: 'ana',
    weekId: '2026-10-19',
    amount: 12,
    note: '',
    at: Date.UTC(2026, 9, 21, 16),
    ...over,
  }
}

describe('dates', () => {
  it('formats days, with the year only when it isn’t this year', () => {
    expect(monDay(Date.UTC(2026, 9, 18, 12), NOW, BERLIN)).toBe('Oct 18')
    expect(monDay(Date.UTC(2025, 9, 18, 12), NOW, BERLIN)).toBe('Oct 18, 2025')
    expect(dayText('2026-12-31', NOW, BERLIN)).toBe('Dec 31')
    expect(dayText('2027-01-02', NOW, BERLIN)).toBe('Jan 2, 2027')
  })

  it('names a goal’s week from Monday to Sunday', () => {
    expect(weekRange('2026-10-19')).toBe('Oct 19–25')
    expect(weekRange('2026-10-26')).toBe('Oct 26–Nov 1')
    expect(weekRange('2026-12-28')).toBe('Dec 28–Jan 3')
    expect(thisWeekHeader('2026-10-19')).toBe('This week · Oct 19–25')
    expect(checkinHeader('Run 100 km', '2026-10-19')).toBe('Run 100 km · week of Oct 19')
  })

  it('knows today on the device’s calendar', () => {
    expect(todayId(NOW, BERLIN)).toBe('2026-10-20')
    // 23:30 UTC on Oct 20 is already Oct 21 in Berlin.
    expect(todayId(Date.UTC(2026, 9, 20, 23, 30), BERLIN)).toBe('2026-10-21')
  })
})

describe('status lines', () => {
  it('reads active, reached, ended and finished', () => {
    expect(statusLine(goal(), NOW, BERLIN)).toBe('36 km to go')
    expect(statusLine(goal({ endsOn: '2026-12-31' }), NOW, BERLIN)).toBe('36 km to go · Ends Dec 31')
    const reached = goal({
      totals: { ana: 60, ben: 44 },
      total: 104,
      reachedAt: Date.UTC(2026, 9, 20, 7),
    })
    expect(statusLine(reached, NOW, BERLIN)).toBe('Reached Oct 20 · 104 of 100 km')
    expect(statusLine(goal({ endsOn: '2026-10-18' }), NOW, BERLIN)).toBe('Ended Oct 18')
    expect(statusLine(goal({ archivedAt: Date.UTC(2026, 9, 19, 12) }), NOW, BERLIN)).toBe('Finished Oct 19')
    // Finished wins over ended.
    expect(statusLine(goal({ endsOn: '2026-10-18', archivedAt: Date.UTC(2026, 9, 19, 12) }), NOW, BERLIN)).toBe('Finished Oct 19')
  })

  it('shows money as money', () => {
    const money = goal({
      name: 'Trip fund',
      unit: 'USD',
      target: 5000,
      totals: { ana: 4200.5 },
      total: 4200.5,
    })
    expect(bigNumber(money)).toBe('$4,200.50')
    expect(ofTarget(money)).toBe('of $5,000')
    expect(statusLine(money, NOW, BERLIN)).toBe('$799.50 to go')
    expect(bigNumber(goal())).toBe('64')
    expect(ofTarget(goal())).toBe('of 100 km')
  })

  it('subtitles a goal’s row, with the end date only within 14 days', () => {
    expect(rowSubtitle(goal(), NOW, BERLIN)).toBe('64 of 100 km · 3 people')
    expect(rowSubtitle(goal({ memberIds: ['ana'] }), NOW, BERLIN)).toBe('64 of 100 km · 1 person')
    expect(rowSubtitle(goal({ endsOn: '2026-12-31' }), NOW, BERLIN)).toBe('64 of 100 km · 3 people')
    expect(rowSubtitle(goal({ endsOn: '2026-11-02' }), NOW, BERLIN)).toBe('64 of 100 km · 3 people · Ends Nov 2')
    const reached = goal({ total: 104, reachedAt: NOW - HOUR })
    expect(rowSubtitle(reached, NOW, BERLIN)).toBe('Reached · 104 of 100 km · 3 people')
    expect(peopleText(8)).toBe('8 people')
  })

  it('knows when an end is near', () => {
    expect(endsSoon(goal({ endsOn: '2026-11-02' }), NOW)).toBe(true)
    expect(endsSoon(goal({ endsOn: '2026-11-20' }), NOW)).toBe(false)
    expect(endsSoon(goal({ endsOn: '2026-10-18' }), NOW)).toBe(false)
    expect(endsSoon(goal(), NOW)).toBe(false)
  })

  it('subtitles invitations and finished goals', () => {
    expect(inviteSubtitle('Lena Park', goal())).toBe('Lena invited you · 64 of 100 km')
    expect(invitedYou('Lena Park')).toBe('Lena invited you.')
    const finished = goal({
      total: 104,
      archivedAt: Date.UTC(2026, 9, 19, 12),
    })
    expect(finishedSubtitle(finished, NOW, BERLIN)).toBe('104 of 100 km · Finished Oct 19')
    expect(finishedSubtitle(goal({ endsOn: '2026-10-18' }), NOW, BERLIN)).toBe('64 of 100 km · Ended Oct 18')
  })
})

describe('units', () => {
  it('agree with the number', () => {
    expect(amountText(1, 'books')).toBe('1 book')
    expect(amountText(1, 'hours')).toBe('1 hour')
    expect(amountText(1, 'times')).toBe('1 time')
    expect(amountText(1, 'km')).toBe('1 km')
    expect(amountText(2, 'books')).toBe('2 books')
    expect(amountText(1.5, 'hours')).toBe('1.5 hours')
    expect(amountText(1, 'USD')).toBe('$1')
    expect(amountText(1250.5, 'km')).toBe('1,250.5 km')
    // Only plain plurals: these keep their "s".
    expect(unitFor(1, 'glasses')).toBe('glasses')
    expect(unitFor(1, 'boxes')).toBe('boxes')
    expect(unitFor(1, 'Books')).toBe('Books')
    expect(unitFor(1, 'laps')).toBe('lap')
    expect(unitFor(1, 'days')).toBe('day')
  })

  it('reads progress with the target’s number', () => {
    expect(progressLine({ total: 64, target: 100, unit: 'km' })).toBe('64 of 100 km')
    expect(progressLine({ total: 1, target: 20, unit: 'books' })).toBe('1 of 20 books')
    expect(progressLine({ total: 0, target: 1, unit: 'books' })).toBe('0 of 1 book')
    expect(progressLine({ total: 4200, target: 5000, unit: 'USD' })).toBe('$4,200 of $5,000')
    expect(statusLine(goal({ unit: 'books', target: 20, totals: { ana: 19 }, total: 19 }), NOW, BERLIN)).toBe('1 book to go')
  })
})

describe('lists', () => {
  it('puts goals waiting for your check-in first, then by name; leaves out finished and ended ones', () => {
    const a = goal({ id: 'a', name: 'Books' })
    const b = goal({ id: 'b', name: 'Alps' })
    const c = goal({ id: 'c', name: 'Cycle' })
    const done = goal({ id: 'd', name: 'Done', archivedAt: NOW - DAY })
    const ended = goal({ id: 'e', name: 'Ended', endsOn: '2026-10-01' })
    const order = sectionGoals([a, b, c, done, ended], 'ana', NOW, {
      a: true,
      b: true,
      c: false,
    })
    expect(order.map((g) => g.id)).toEqual(['c', 'b', 'a'])
    // Unknown yet: by name.
    expect(sectionGoals([a, b, c], 'ana', NOW, {}).map((g) => g.id)).toEqual(['b', 'a', 'c'])
  })

  it('lists finished and ended goals newest first', () => {
    const old = goal({ id: 'old', archivedAt: NOW - 20 * DAY })
    const recent = goal({ id: 'recent', archivedAt: NOW - DAY })
    const ended = goal({ id: 'ended', endsOn: '2026-10-10' })
    const open = goal({ id: 'open' })
    expect(finishedGoals([old, open, ended, recent], NOW).map((g) => g.id)).toEqual(['recent', 'ended', 'old'])
  })

  it('shares as a percent of the total', () => {
    expect(shareSubtitle(30, 64, false)).toBe('47%')
    expect(shareSubtitle(14, 64, true)).toBe('22% · Left')
    expect(shareSubtitle(0, 0, false)).toBe('0%')
  })
})

describe('check-in', () => {
  it('says what saving does, and where the team will be', () => {
    const g = goal()
    expect(checkinFooter(g, null, null, BERLIN)).toBe('Your part this week. Missed a week? Add it here.')
    expect(checkinFooter(g, null, 12, BERLIN)).toBe('Your part this week. Missed a week? Add it here. The team will be at 76 of 100 km.')
    // Wednesday 18:00 in Berlin.
    const mine = checkin({ amount: 12, at: Date.UTC(2026, 9, 21, 16) })
    expect(checkinFooter(g, mine, null, BERLIN)).toBe('You checked in 12 km Wednesday. Saving replaces it.')
    expect(checkinFooter(g, mine, 24, BERLIN)).toBe('You checked in 12 km Wednesday. Saving replaces it. The team will be at 76 of 100 km.')
  })

  it('adds decimals exactly', () => {
    expect(teamTotal({ total: 0.1 }, 0, 0.2)).toBe(0.3)
    expect(teamTotal({ total: 64 }, 12, 12.5)).toBe(64.5)
    expect(checkinFooter(goal({ total: 0.1 }), null, 0.2, BERLIN)).toContain('The team will be at 0.3 of 100 km.')
  })

  it('toasts', () => {
    expect(checkedInToast(goal(), 76)).toEqual({
      title: 'Checked in',
      message: 'The team is at 76 of 100 km.',
    })
    expect(joinedToast('Run 100 km')).toEqual({
      title: 'You joined Run 100 km',
      message: 'Check in your part each week.',
    })
  })
})

describe('confirms and footers', () => {
  it('finishes', () => {
    expect(finishConfirm('Run 100 km')).toEqual({
      title: 'Finish Run 100 km?',
      message: 'Check-ins stop and it moves to Finished. This can’t be undone.',
      confirmLabel: 'Finish',
      cancelLabel: 'Cancel',
    })
  })

  it('leaves: as a member, as the owner handing on, as the last one', () => {
    const base = 'Your part stays in the total. To come back, you’ll need a new invite.'
    expect(leaveConfirm(goal(), 'ben', null).message).toBe(base)
    expect(leaveConfirm(goal(), 'ana', 'Sam Lee').message).toBe(`${base} Sam becomes the owner.`)
    expect(leaveConfirm(goal({ memberIds: ['ana'] }), 'ana', null).message).toBe(`${base} You’re the last one, so it moves to Finished.`)
    expect(leaveConfirm(goal({ archivedAt: NOW }), 'ana', 'Sam').message).toBe('Your part stays in the total.')
    expect(leaveConfirm(goal(), 'ben', null).title).toBe('Leave Run 100 km?')
    expect(leaveConfirm(goal(), 'ben', null).confirmLabel).toBe('Leave')
  })

  it('counts spots', () => {
    expect(newInviteFooter(3)).toBe('3 of 7 spots. They can join or decline.')
    expect(spotsLeftFooter(2)).toBe('2 spots left. Only friends can be invited.')
    expect(spotsLeftFooter(1)).toBe('1 spot left. Only friends can be invited.')
    expect(spotsLeftFooter(0)).toBe('No spots left. Only friends can be invited.')
    expect(spotsLeft(goal({ invited: ['dan', 'eve'] }))).toBe(3)
  })

  it('warns when an edit changes whether the goal is reached', () => {
    const g = goal()
    expect(editTargetFooter(g, 50)).toBe('That’s already reached: the goal will show as reached.')
    expect(editTargetFooter(g, 64)).toBe('That’s already reached: the goal will show as reached.')
    expect(editTargetFooter(g, 120)).toBeNull()
    const reached = goal({ total: 104, reachedAt: NOW })
    expect(editTargetFooter(reached, 150)).toBe('It won’t show as reached until you get there.')
    expect(editTargetFooter(reached, 100)).toBeNull()
    expect(editTargetFooter(g, null)).toBeNull()
  })

  it('celebrates', () => {
    const reached = goal({ total: 104, reachedAt: NOW })
    expect(momentText(reached)).toBe('Run 100 km: 104 of 100 km.')
    expect(momentOthers('Lena Park')).toBe('Keep checking in, or Lena can finish it.')
    expect(momentOthers(null)).toBe('Keep checking in, or the owner can finish it.')
  })

  it('names the goal’s clock and the unit chips', () => {
    expect(weeksFooter('Europe/Berlin')).toBe('Weeks run Monday to Sunday, Berlin time.')
    expect(weeksFooter('America/Port_of_Spain')).toBe('Weeks run Monday to Sunday, Port of Spain time.')
    expect(unitChips(['km', 'books', 'hours', 'times'], 'EUR')).toEqual(['km', 'books', 'hours', 'times', 'EUR'])
  })
})
