import { describe, expect, it } from 'vitest'
import { pauseView } from '../../domain/pause.ts'
import type { PauseChoice } from '../../domain/pause.ts'
import { scheduleProblem } from '../../domain/schedule.ts'
import { weekBounds } from '../../domain/time.ts'
import type { PauseRequest, Space, UID, Week } from '../../domain/types.ts'
import {
  changeSentence,
  dayOptions,
  houseFooter,
  houseSaved,
  judgeConfirm,
  judgeSelf,
  memberSubtitle,
  monthlyReviewRow,
  ownTimesLine,
  pauseAskLine,
  pauseAskedToast,
  pauseBlockedReason,
  pauseCardView,
  pausedListFooter,
  pausedWeekCard,
  pauseRow,
  pauseSheet,
  pauseSeenKey,
  playConfirm,
  roleFooter,
  scheduleConfirm,
  scheduleFooter,
  scheduleNotice,
  scheduleReadOnlyFooter,
  scheduleSaved,
  scheduleSeenKey,
  scheduleSummary,
  scheduleTimesFooter,
  startsDetail,
  startsPhrase,
  timeOptions,
  weekFor,
  withDay,
  withTime,
} from './space.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const BERLIN = 'Europe/Berlin'
const THIS = '2026-10-12'
const NEXT = '2026-10-19'
const names: Record<UID, string> = { lena: 'Lena', sam: 'Sam', ben: 'Ben', kim: 'Kim', me: 'Ana' }
const name = (uid: UID) => names[uid] ?? 'Someone'
const never = () => false
const thisWeek = weekBounds(THIS, BERLIN)
const nextWeek = weekBounds(NEXT, BERLIN)

function space(over: Partial<Space> = {}): Space {
  return {
    id: 'film',
    name: 'Film Club',
    reward: 'Dinner on me',
    penalty: 'Coffee for a week',
    ownerId: 'lena',
    memberIds: ['lena', 'sam', 'ben', 'me'],
    joinedAt: { lena: 0, sam: 0, ben: 0, me: 0 },
    timezone: BERLIN,
    utcOffsetMin: 120,
    inviteCode: 'ABCDEFGH',
    threshold: 90,
    latePenalty: 5,
    createdAt: 0,
    ...over,
  }
}

function week(id: string, members: UID[], over: Partial<Week> = {}): Week {
  return { id, spaceId: 'film', ...weekBounds(id, BERLIN), members, submittedBy: [], ...over }
}

// SPEC §9.2's example: lists lock Monday at 8:00 PM, reviews open Thursday at midnight, due Saturday at noon.
const CUSTOM = { lock: 1200, reviewOpen: 5760, deadline: 7920 }

describe('when a change starts', () => {
  it('names the week relative to this one', () => {
    expect(startsPhrase(THIS, THIS)).toBe('this week')
    expect(startsPhrase(NEXT, THIS)).toBe('next week')
    expect(startsPhrase('2026-10-26', THIS)).toBe('the week of Oct 26')
    expect(startsDetail(THIS, THIS)).toBe('This week')
    expect(startsDetail(NEXT, THIS)).toBe('Next week')
    expect(startsDetail('2026-10-26', THIS)).toBe('Week of Oct 26')
  })
})

describe('Week Schedule', () => {
  it('keeps today’s Settings footer for the usual times', () => {
    expect(scheduleFooter(undefined, 'Berlin')).toBe('Lists lock Monday at midnight and reviews are due Friday at midnight, Berlin time.')
    expect(scheduleFooter(CUSTOM, 'Berlin')).toBe('Lists lock Monday at 8:00 PM and reviews are due Saturday at noon, Berlin time.')
    expect(scheduleFooter(CUSTOM, 'Berlin', 'h23')).toBe('Lists lock Monday at 20:00 and reviews are due Saturday at noon, Berlin time.')
    expect(scheduleSummary(undefined)).toBe('Usual')
    expect(scheduleSummary({ lock: 1440, reviewOpen: 5760, deadline: 7200 })).toBe('Usual')
    expect(scheduleSummary(CUSTOM)).toBe('Custom')
  })

  it('every example schedule here is one the rules accept', () => {
    expect(scheduleProblem(CUSTOM)).toBeNull()
    expect(scheduleProblem({ lock: 2160, reviewOpen: 5760, deadline: 8640 })).toBeNull()
  })

  it('confirms with only the moments that change, and which weeks keep their times', () => {
    expect(scheduleConfirm('Film Club', undefined, { lock: 1200, reviewOpen: 5760, deadline: 7920 }, NEXT, THIS)).toEqual({
      title: 'Change the times?',
      message:
        'From next week, lists lock Monday at 8:00 PM and reviews are due Saturday at noon. This week keeps its times. Everyone in Film Club gets a notice.',
    })
    expect(scheduleConfirm('Film Club', undefined, CUSTOM, THIS, THIS).message).toBe(
      'From this week, lists lock Monday at 8:00 PM and reviews are due Saturday at noon. Everyone in Film Club gets a notice.',
    )
    expect(scheduleConfirm('Film Club', CUSTOM, { ...CUSTOM, reviewOpen: 5400 }, '2026-10-26', THIS).message).toBe(
      'From the week of Oct 26, reviews open Thursday at 6:00 PM. This week and next week keep their times. Everyone in Film Club gets a notice.',
    )
  })

  it('toasts when the new times start', () => {
    expect(scheduleSaved(NEXT, THIS)).toEqual({ title: 'New times saved', message: 'They start next week.' })
    expect(scheduleSaved('2026-10-26', THIS).message).toBe('They start the week of Oct 26.')
  })

  it('tells friends who can change them', () => {
    expect(scheduleReadOnlyFooter('Lena')).toBe('Only Lena, the owner, can change the times.')
    expect(scheduleReadOnlyFooter('Lena', { byName: 'Lena', at: 'Oct 13' })).toBe('Only Lena, the owner, can change the times. Changed by Lena on Oct 13.')
    expect(scheduleTimesFooter('Berlin')).toBe('Midnight is the end of the day you pick. Times follow Berlin time.')
  })

  it('offers lock Sunday (midnight only) to Saturday, reviews Monday to Sunday', () => {
    expect(dayOptions('lock', 1440).map((o) => o.label)).toEqual(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])
    expect(dayOptions('deadline', 7200).map((o) => o.label)).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'])
    expect(timeOptions('lock', 0)).toEqual([{ value: 1440, label: 'Midnight (end of day)' }])
    const times = timeOptions('reviewOpen', 5760)
    expect(times).toHaveLength(48)
    expect(times[0]).toEqual({ value: 30, label: '12:30 AM' })
    expect(times[23]).toEqual({ value: 720, label: 'Noon' })
    expect(times[47]).toEqual({ value: 1440, label: 'Midnight (end of day)' })
    expect(timeOptions('reviewOpen', 5760, 'h23')[35].label).toBe('18:00')
    // A stored time off the half-hour grid stays as an extra option.
    expect(timeOptions('deadline', 7200 - 1440 + 615).map((o) => o.value)).toContain(615)
  })

  it('moves a lock to Sunday at midnight, and keeps the time otherwise', () => {
    expect(withDay('lock', 1200, -1)).toBe(0)
    expect(withDay('lock', 0, 0)).toBe(1440)
    expect(withDay('deadline', 7200, 5)).toBe(8640)
    expect(withDay('deadline', 7920, 6)).toBe(9360)
    expect(withTime(5760, 1080)).toBe(5400)
  })
})

describe('the schedule notice', () => {
  const note = { by: 'lena', at: thisWeek.startAt + 10 * HOUR, fromWeek: NEXT, before: { lock: 1440, reviewOpen: 5760, deadline: 7200 } }
  const base = { me: 'sam', nowMs: thisWeek.startAt + DAY, thisWeek: THIS, fromWeekDeadline: nextWeek.deadlineAt, name, seen: never }

  it('tells everyone else what changed, until that week’s deadline', () => {
    const view = scheduleNotice({ ...base, space: space({ schedule: CUSTOM, scheduleNote: note }) })
    expect(view).toEqual({
      kind: 'change',
      title: 'New times from next week',
      subtitle: 'Lena changed them. Lists now lock Monday at 8:00 PM and reviews are due Saturday at noon.',
      seenKey: scheduleSeenKey('film', note.at),
    })
    expect(scheduleNotice({ ...base, nowMs: nextWeek.deadlineAt, space: space({ schedule: CUSTOM, scheduleNote: note }) })).toBeNull()
  })

  it('shows nothing to the owner who changed them, or once dismissed', () => {
    expect(scheduleNotice({ ...base, me: 'lena', space: space({ schedule: CUSTOM, scheduleNote: note }) })).toBeNull()
    const seen = (key: string) => key === `scheduleSeen.film.${note.at}`
    expect(scheduleNotice({ ...base, seen, space: space({ schedule: CUSTOM, scheduleNote: note }) })).toBeNull()
  })

  it('tells a newcomer once that the space has its own times', () => {
    const later = space({ schedule: CUSTOM, scheduleNote: note, joinedAt: { lena: 0, sam: note.at + HOUR } })
    expect(scheduleNotice({ ...base, space: later })).toEqual({
      kind: 'own',
      title: 'This space has its own times',
      subtitle: 'Lists lock Monday at 8:00 PM · Reviews open Thursday at midnight · Reviews due Saturday at noon.',
      seenKey: `scheduleSeen.film.${note.at}`,
    })
    // Without a note (the times came with the space): the same, keyed at 0.
    expect(scheduleNotice({ ...base, space: space({ schedule: CUSTOM }) })?.seenKey).toBe('scheduleSeen.film.0')
    expect(scheduleNotice({ ...base, space: space() })).toBeNull()
  })

  it('joins the change lines into one sentence', () => {
    expect(changeSentence(['Lists now lock Monday at 8:00 PM', 'Reviews now open Thursday at 6:00 PM', 'Reviews are now due Saturday at noon'])).toBe(
      'Lists now lock Monday at 8:00 PM, reviews open Thursday at 6:00 PM and reviews are due Saturday at noon.',
    )
    expect(ownTimesLine(undefined)).toBe('Lists lock Monday at midnight · Reviews open Thursday at midnight · Reviews due Friday at midnight.')
  })
})

describe('the pause card', () => {
  const at = thisWeek.startAt + 2 * HOUR
  const request = (over: Partial<PauseRequest> = {}): PauseRequest => ({ weekId: NEXT, by: 'lena', at, oks: ['lena'], ...over })
  const when = () => 'Thursday at midnight'
  const card = (s: Space, me: UID, nowMs = at + HOUR, w = week(NEXT, s.memberIds)) =>
    pauseCardView({ space: s, me, nowMs, view: pauseView(s, me, nowMs, w), week: w, thisWeek: THIS, name, when, seen: never })

  it('asks those who still have to say OK', () => {
    const s = space({ pause: request({ oks: ['lena', 'ben'] }) })
    expect(card(s, 'sam')).toMatchObject({
      kind: 'pending',
      role: 'to-answer',
      title: 'Pause next week?',
      subtitle: 'Lena asked. It only happens if everyone says OK before reviews open Thursday at midnight.',
      count: '2 of 4 said OK',
      people: [
        { uid: 'lena', ok: true },
        { uid: 'sam', ok: false },
        { uid: 'ben', ok: true },
        { uid: 'me', ok: false },
      ],
    })
    expect(card(s, 'ben')).toMatchObject({ role: 'said-ok', status: 'You said OK. Waiting for Sam and Ana.' })
    expect(card(s, 'lena')).toMatchObject({ role: 'asked', status: 'Waiting for Sam and Ana.' })
  })

  it('tells someone who isn’t in the week they needn’t answer', () => {
    const s = space({ pause: request({ weekId: THIS }), memberIds: ['lena', 'sam', 'kim'], joinedAt: { lena: 0, sam: 0, kim: thisWeek.lockAt + HOUR } })
    const w = week(THIS, ['lena', 'sam'])
    expect(card(s, 'kim', thisWeek.lockAt + 2 * HOUR, w)).toMatchObject({
      role: 'not-asked',
      title: 'Lena asked to pause this week',
      subtitle: 'You’re not in it, so you don’t need to answer.',
    })
  })

  it('says not happening until reviews open, and can be dismissed', () => {
    const s = space({ pause: request({ declinedBy: 'sam' }) })
    expect(card(s, 'ben')).toMatchObject({ kind: 'declined', title: 'Not happening: Sam said not now.', seenKey: pauseSeenKey('film', at) })
    expect(card(s, 'sam')?.title).toBe('Not happening: you said not now.')
    const seen = (key: string) => key === `pauseSeen.film.${at}`
    const w = week(NEXT, s.memberIds)
    expect(pauseCardView({ space: s, me: 'ben', nowMs: at, view: pauseView(s, 'ben', at, w), week: w, thisWeek: THIS, name, when, seen })).toBeNull()
    // A cancelled request shows nothing.
    expect(card(space({ pause: request({ declinedBy: 'lena' }) }), 'sam')).toBeNull()
  })

  it('says the week is paused until it starts', () => {
    const s = space({ pause: request({ oks: ['lena', 'sam', 'ben', 'me'] }), paused: { '2026-10': NEXT } })
    expect(card(s, 'sam')).toEqual({ kind: 'paused', title: 'Next week is paused', subtitle: 'Everyone said OK. No reviews and no score that week.' })
    expect(card(s, 'sam', nextWeek.startAt)).toBeNull()
  })

  it('tells only the asker when it didn’t happen', () => {
    const s = space({ pause: request({ oks: ['lena', 'ben'] }) })
    const after = nextWeek.reviewOpenAt + HOUR
    expect(card(s, 'lena', after)).toMatchObject({ kind: 'lapsed', title: 'Your pause didn’t happen', subtitle: 'Sam and Ana didn’t answer before reviews opened.' })
    expect(card(s, 'sam', after)).toBeNull()
  })

  it('puts the ask on the Spaces card only for those who must answer', () => {
    const s = space({ pause: request() })
    const w = week(NEXT, s.memberIds)
    expect(pauseAskLine(pauseView(s, 'sam', at, w), THIS, name)).toBe('Lena asks to pause next week')
    expect(pauseAskLine(pauseView(s, 'lena', at, w), THIS, name)).toBeNull()
  })
})

describe('Pause a Week in Settings', () => {
  const weeks = { thisWeek: THIS, nextWeek: NEXT }
  const both = (a: PauseChoice, b: PauseChoice) => ({ thisWeek: a, nextWeek: b })
  const none = { kind: 'none' } as const

  it('opens the sheet when either week can be asked for', () => {
    expect(pauseRow(none, 'me', both('too-late', 'ok'), weeks)).toEqual({ title: 'Pause a Week', enabled: true, canCancel: false })
  })

  it('says why it can’t', () => {
    expect(pauseBlockedReason(both('month-used', 'month-used'), weeks)).toBe('October’s pause is used.')
    expect(pauseBlockedReason(both('request-pending', 'request-pending'), weeks)).toBe('A request is waiting for answers.')
    expect(pauseBlockedReason(both('cooldown', 'cooldown'), weeks)).toBe('You asked not long ago.')
    expect(pauseBlockedReason(both('too-late', 'reviews-open'), weeks)).toBe('Too close to reviews to ask for this week.')
    expect(pauseRow(none, 'me', both('reviews-open', 'month-used'), weeks)).toMatchObject({ enabled: false, subtitle: 'October’s pause is used.' })
  })

  it('shows a pending request with the asker’s Cancel Request', () => {
    const s = space({ pause: { weekId: NEXT, by: 'me', at: thisWeek.startAt, oks: ['me', 'sam'] } })
    const view = pauseView(s, 'me', thisWeek.startAt + HOUR, week(NEXT, s.memberIds))
    expect(pauseRow(view, 'me', both('request-pending', 'request-pending'), weeks)).toEqual({
      title: 'Pause Requested',
      detail: 'Waiting for 2',
      enabled: false,
      canCancel: true,
    })
    expect(pauseRow(view, 'sam', both('request-pending', 'request-pending'), weeks).canCancel).toBe(false)
  })

  it('asks by the earlier week’s review opening', () => {
    const when = (ms: number) => (ms === thisWeek.reviewOpenAt ? 'Thursday at midnight' : 'next Thursday at midnight')
    expect(pauseSheet('Film Club', both('ok', 'ok'), { thisWeek: thisWeek.reviewOpenAt, nextWeek: nextWeek.reviewOpenAt }, when)).toEqual({
      title: 'Pause a week?',
      message: 'Nothing counts in a paused week, and it’s left out of the month’s average. Everyone in Film Club has to say OK by Thursday at midnight.',
      actions: ['Pause This Week', 'Pause Next Week'],
    })
    expect(pauseSheet('Film Club', both('too-late', 'ok'), { thisWeek: 0, nextWeek: nextWeek.reviewOpenAt }, when)).toMatchObject({
      message: expect.stringContaining('by next Thursday at midnight.'),
      actions: ['Pause Next Week'],
    })
  })

  it('toasts after asking', () => {
    expect(pauseAskedToast('asked', NEXT, THIS)).toEqual({ title: 'Asked everyone', message: 'They’ll see it next time they open Stakes.' })
    expect(pauseAskedToast('paused', NEXT, THIS)).toEqual({ title: 'Next week is paused' })
    expect(pauseAskedToast('paused', THIS, THIS)).toEqual({ title: 'This week is paused' })
  })
})

describe('a paused week', () => {
  it('says so in the week view', () => {
    expect(pausedWeekCard(THIS, THIS)).toEqual({ title: 'This week is paused', subtitle: 'Everyone said OK. No reviews, no score, and it’s left out of October’s average.' })
    expect(pausedWeekCard(NEXT, THIS).title).toBe('Next week is paused')
    expect(pausedListFooter(THIS, THIS)).toBe('Paused: your list is just for you this week.')
    expect(pausedListFooter(NEXT, THIS)).toBe('Paused: your list is just for you next week.')
    expect(monthlyReviewRow('2026-10')).toEqual({ title: 'Review the October Lists', subtitle: 'No points this week, just the monthly lists.' })
  })

  it('uses the current members and computed times until the week has a doc', () => {
    const s = space()
    expect(weekFor(s, NEXT, [])).toEqual({ ...nextWeek, members: s.memberIds })
    const stored = week(NEXT, ['lena', 'sam'], { reviewOpenAt: nextWeek.reviewOpenAt - HOUR })
    expect(weekFor(s, NEXT, [null, stored])).toMatchObject({ members: ['lena', 'sam'], reviewOpenAt: nextWeek.reviewOpenAt - HOUR })
  })
})

describe('Only Rate Friends', () => {
  it('says when a change of role starts', () => {
    expect(roleFooter(false, null, NEXT)).toBe('Judges rate everyone each week, with no list, no score and nothing owed.')
    expect(roleFooter(true, 'judge', NEXT)).toBe('You’re a judge: you rate everyone each week, with no list, no score and nothing owed.')
    expect(roleFooter(true, 'player', '2026-10-20')).toBe(
      'You’re a judge: you rate everyone each week, with no list, no score and nothing owed. This week you’re still playing; you judge from the week of Oct 20.',
    )
    expect(roleFooter(false, 'judge', '2026-10-20')).toBe(
      'Judges rate everyone each week, with no list, no score and nothing owed. This week you’re still judging; you play from the week of Oct 20.',
    )
  })

  it('warns about this week’s list, the month’s list and the 0% rule', () => {
    expect(judgeConfirm({ fromWeek: THIS, thisWeek: THIS, plannedTasks: false, monthlyList: null, played: false })).toEqual({
      title: 'Only rate from this week?',
      message: 'You’ll rate everyone each week, with no list, no score and nothing owed.',
      confirmLabel: 'Only Rate',
    })
    expect(judgeConfirm({ fromWeek: NEXT, thisWeek: THIS, plannedTasks: true, monthlyList: 'unlocked', played: true })).toEqual({
      title: 'Only rate from the week of Oct 19?',
      message:
        'You’ll rate everyone each week, with no list, no score and nothing owed. Tasks you planned for that week won’t count. Your October list won’t count either. You’ve played in October, so weeks you judge this month count as 0%.',
      confirmLabel: 'Only Rate',
    })
    expect(judgeConfirm({ fromWeek: NEXT, thisWeek: THIS, plannedTasks: false, monthlyList: 'locked', played: true }).message).toBe(
      'You’ll rate everyone each week, with no list, no score and nothing owed. Your October list still counts: it locked while you were playing. You’ve played in October, so weeks you judge this month count as 0%.',
    )
  })

  it('asks before playing again', () => {
    expect(playConfirm(NEXT, THIS, 'Monday at midnight', false)).toEqual({
      title: 'Play again from the week of Oct 19?',
      message: 'You’ll have your own list again. Plan it before it locks Monday at midnight, or that week scores 0%.',
      confirmLabel: 'Play',
    })
    expect(playConfirm(THIS, THIS, 'tonight at midnight', true).message).toBe(
      'You’ll have your own list again. Plan it before it locks tonight at midnight, or that week scores 0%. You judged in October, so those weeks will count as 0% if you play this month.',
    )
  })

  it('says how judging went', () => {
    const done = { hasSubmitted: true, missedReviewsOf: [] }
    expect(judgeSelf('planning', false, done)).toEqual({ title: 'You’re judging this week', subtitle: 'You rate everyone on review day. No list, no score.' })
    expect(judgeSelf('review', true, done).subtitle).toBe('Thanks for judging.')
    expect(judgeSelf('planning', false, done, 'next week').title).toBe('You’re judging next week')
    expect(judgeSelf('closed', true, done)).toEqual({ title: 'You judged this week', subtitle: 'You reviewed everyone.' })
    expect(judgeSelf('closed', true, { hasSubmitted: false, missedReviewsOf: ['sam'] }).subtitle).toBe('You didn’t review this week. Judges don’t lose points.')
  })

  it('marks judges in the members list', () => {
    expect(memberSubtitle(true, true, 'Oct 1, 2026')).toBe('Owner · Judge · Joined Oct 1, 2026')
    expect(memberSubtitle(false, false, null)).toBeUndefined()
  })
})

describe('house stakes in Settings', () => {
  const now = { month: '2026-10', thisMonth: '2026-10', window: false }
  const later = { month: '2026-11', thisMonth: '2026-10', window: true }

  it('says changes count right away, for the month that counts', () => {
    expect(houseFooter(now, true, 'Lena')).toBe('They count between two friends until they agree on their own. Changes count right away, for October.')
    expect(houseFooter(later, true, 'Lena')).toBe(
      'They count between two friends until they agree on their own. Changes count right away, for November. October is final.',
    )
    expect(houseFooter(now, false, 'Lena')).toBe('Only Lena can change the house stakes. Set your own on the Stakes screen.')
  })

  it('toasts when they count', () => {
    expect(houseSaved(now)).toBe('The new house stakes count now.')
    expect(houseSaved(later)).toBe('The new house stakes count from November. October is final.')
  })
})
