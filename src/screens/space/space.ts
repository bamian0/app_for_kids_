// What the Space screen's transient cards and the settings rows say (SPEC §9.2–§9.4), as pure functions of the
// space doc and the clock, so the copy is unit-tested without a DOM: the week phrases ("next week", "the week of
// Oct 26"), the Week Schedule screen's pickers, confirm and toast, the schedule notice, the pause card and the
// Pause a Week row, the Only Rate Friends footer and confirms, and the house stakes footer and toast.
import { pauseNeeded } from '../../domain/pause.ts'
import type { PauseChoice, PauseView } from '../../domain/pause.ts'
import { isUsualSchedule, momentText, scheduleChangeLines, splitMoment, joinMoment, timeLabel } from '../../domain/schedule.ts'
import type { HourCycle } from '../../domain/schedule.ts'
import { DEFAULT_SCHEDULE, addWeeks, monthIdForWeek } from '../../domain/time.ts'
import type { MonthId, Space, UID, WeekId, WeekSchedule } from '../../domain/types.ts'
import { monthName } from '../components/format.ts'
import { compactNames, listNames } from '../components/people.ts'

type Name = (uid: UID) => string

const WEEK_LABEL = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/** A week's Monday as "Oct 26". */
export function weekLabel(weekId: WeekId): string {
  const ms = Date.parse(`${weekId}T00:00:00Z`)
  return Number.isNaN(ms) ? weekId : WEEK_LABEL.format(ms)
}

/** "this week", "next week", or "the week of Oct 26" (relative to the space's current week). */
export function weekPhrase(weekId: WeekId, thisWeek: WeekId): string {
  if (weekId === thisWeek) return 'this week'
  if (weekId === addWeeks(thisWeek, 1)) return 'next week'
  return `the week of ${weekLabel(weekId)}`
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** The Starts row's detail: "This week", "Next week" or "Week of Oct 26". */
export function startsDetail(fromWeek: WeekId, thisWeek: WeekId): string {
  if (fromWeek === thisWeek || fromWeek === addWeeks(thisWeek, 1)) return capitalize(weekPhrase(fromWeek, thisWeek))
  return `Week of ${weekLabel(fromWeek)}`
}

// ---------- Week Schedule ----------

/** The Week Schedule row's detail. */
export function scheduleSummary(s?: WeekSchedule | null): 'Usual' | 'Custom' {
  return isUsualSchedule(s) ? 'Usual' : 'Custom'
}

/** Space Settings' footer: "Lists lock Monday at midnight and reviews are due Friday at midnight, Berlin time."
 *  (exactly the words from before batch 2 for the usual times). */
export function scheduleFooter(s: WeekSchedule | null | undefined, city: string, hourCycle?: HourCycle): string {
  const { lock, deadline } = s ?? DEFAULT_SCHEDULE
  return `Lists lock ${momentText(lock, hourCycle)} and reviews are due ${momentText(deadline, hourCycle)}, ${city} time.`
}

/** The three moments of a space with its own times: "Lists lock Monday at 8:00 PM · Reviews open Thursday at
 *  midnight · Reviews due Saturday at noon." */
export function ownTimesLine(s: WeekSchedule | null | undefined, hourCycle?: HourCycle): string {
  const { lock, reviewOpen, deadline } = s ?? DEFAULT_SCHEDULE
  return `Lists lock ${momentText(lock, hourCycle)} · Reviews open ${momentText(reviewOpen, hourCycle)} · Reviews due ${momentText(deadline, hourCycle)}.`
}

/** scheduleChangeLines as one sentence: "Lists now lock Monday at 8:00 PM and reviews are due Saturday at noon." */
export function changeSentence(lines: string[]): string {
  if (lines.length === 0) return ''
  const rest = lines.slice(1).map((line) => line.replace(' now ', ' ').replace(/^./, (c) => c.toLowerCase()))
  return `${listNames([lines[0], ...rest])}.`
}

/** The moments that differ, for the confirm: "lists lock Monday at 8:00 PM and reviews are due Saturday at noon". */
function changePhrase(before: WeekSchedule, after: WeekSchedule, hourCycle?: HourCycle): string {
  const parts: string[] = []
  if (after.lock !== before.lock) parts.push(`lists lock ${momentText(after.lock, hourCycle)}`)
  if (after.reviewOpen !== before.reviewOpen) parts.push(`reviews open ${momentText(after.reviewOpen, hourCycle)}`)
  if (after.deadline !== before.deadline) parts.push(`reviews are due ${momentText(after.deadline, hourCycle)}`)
  return listNames(parts)
}

/** "Change the times?" · "From next week, lists lock Monday at 8:00 PM and reviews are due Saturday at noon. This
 *  week keeps its times. Everyone in Film Club gets a notice." */
export function scheduleConfirm(
  spaceName: string,
  before: WeekSchedule | null | undefined,
  after: WeekSchedule,
  fromWeek: WeekId,
  thisWeek: WeekId,
  hourCycle?: HourCycle,
): { title: string; message: string } {
  const keep = fromWeek === thisWeek ? '' : fromWeek === addWeeks(thisWeek, 1) ? 'This week keeps its times. ' : 'This week and next week keep their times. '
  const change = changePhrase(before ?? DEFAULT_SCHEDULE, after, hourCycle)
  return {
    title: 'Change the times?',
    message: `From ${weekPhrase(fromWeek, thisWeek)}, ${change}. ${keep}Everyone in ${spaceName} gets a notice.`,
  }
}

/** The toast after saving: "New times saved" · "They start next week." */
export function scheduleSaved(fromWeek: WeekId, thisWeek: WeekId): { title: string; message: string } {
  return { title: 'New times saved', message: `They start ${weekPhrase(fromWeek, thisWeek)}.` }
}

/** Read-only footer for everyone but the owner. */
export function scheduleReadOnlyFooter(ownerName: string, note?: { byName: string; at: string } | null): string {
  const only = `Only ${ownerName}, the owner, can change the times.`
  return note ? `${only} Changed by ${note.byName} on ${note.at}.` : only
}

export const SCHEDULE_FOOTER_START = 'Changes start with the first week whose lists lock at least a day from now. Everyone gets a notice.'

export function scheduleTimesFooter(city: string): string {
  return `Midnight is the end of the day you pick. Times follow ${city} time.`
}

// The pickers: a day capsule and a time capsule per moment, in 30-minute steps, "Midnight (end of day)" last.

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const
const DAY = 1440
const STEP = 30

export type MomentKind = 'lock' | 'reviewOpen' | 'deadline'

export interface Option {
  value: number
  label: string
}

/** −1 is the Sunday before the week (lists lock "Sunday at midnight", m = 0). */
export function dayName(day: number): string {
  return day < 0 ? 'Sunday' : DAY_NAMES[day % 7]
}

/** Lists lock Sunday (midnight only) to Saturday; reviews open and are due Monday to Sunday. A stored day off
 *  that list stays as an extra option. */
export function dayOptions(kind: MomentKind, current: number): Option[] {
  const days = kind === 'lock' ? [-1, 0, 1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6]
  const day = splitMoment(current).day
  if (!days.includes(day)) days.push(day)
  return days.map((d) => ({ value: d, label: dayName(d) }))
}

/** "12:30 AM" … "11:30 PM", then "Midnight (end of day)"; a lock on Sunday offers midnight only. A stored time off
 *  the half-hour grid stays as an extra option. */
export function timeOptions(kind: MomentKind, current: number, hourCycle?: HourCycle): Option[] {
  const { day, time } = splitMoment(current)
  const times = kind === 'lock' && day < 0 ? [DAY] : Array.from({ length: DAY / STEP }, (_, i) => (i + 1) * STEP)
  if (!times.includes(time)) times.push(time)
  times.sort((a, b) => a - b)
  return times.map((t) => ({ value: t, label: pickerTime(t, hourCycle) }))
}

/** A time in the picker: "6:00 PM" / "18:00", "Noon", "Midnight (end of day)". */
export function pickerTime(time: number, hourCycle?: HourCycle): string {
  return time === DAY ? 'Midnight (end of day)' : timeLabel(time, hourCycle)
}

/** A moment with its day changed; the time stays (a Sunday lock can only be at midnight). */
export function withDay(kind: MomentKind, current: number, day: number): number {
  const { time } = splitMoment(current)
  return joinMoment(day, kind === 'lock' && day < 0 ? DAY : time)
}

/** A moment with its time changed. */
export function withTime(current: number, time: number): number {
  return joinMoment(splitMoment(current).day, time)
}

/** A moment as read-only text: "Monday at midnight" → "Monday at midnight". */
export function momentDetail(m: number, hourCycle?: HourCycle): string {
  return momentText(m, hourCycle)
}

// ---------- The schedule notice (top of the Space screen, SPEC §9.2) ----------

export interface NoticeView {
  kind: 'change' | 'own'
  title: string
  subtitle: string
  /** The device key that remembers a dismiss. */
  seenKey: string
}

export interface NoticeInput {
  space: Pick<Space, 'id' | 'ownerId' | 'joinedAt' | 'schedule' | 'scheduleNote'>
  me: UID
  nowMs: number
  thisWeek: WeekId
  /** The deadline of `scheduleNote.fromWeek`: its stored one when the doc is loaded, else computed. */
  fromWeekDeadline: number | null
  name: Name
  seen: (key: string) => boolean
  hourCycle?: HourCycle
}

export function scheduleSeenKey(spaceId: string, atMs: number): string {
  return `scheduleSeen.${spaceId}.${atMs}`
}

/**
 * The notice, or null. "New times from next week" · "Lena changed them. Lists now lock …" for a member who joined
 * before the change and isn't its author, until the deadline of its first week. Someone who joined after it (or a
 * space with its own times and no note) gets "This space has its own times" once instead. Either is dismissed
 * per device.
 */
export function scheduleNotice({ space, me, nowMs, thisWeek, fromWeekDeadline, name, seen, hourCycle }: NoticeInput): NoticeView | null {
  const note = space.scheduleNote
  const joined = space.joinedAt[me] ?? 0
  const seenKey = scheduleSeenKey(space.id, note?.at ?? 0)
  if (seen(seenKey)) return null
  if (note && note.by !== me && joined < note.at) {
    if (fromWeekDeadline === null || nowMs >= fromWeekDeadline) return null
    const lines = scheduleChangeLines(note.before, space.schedule, hourCycle)
    const subtitle = [`${name(note.by)} changed them.`, changeSentence(lines)].filter(Boolean).join(' ')
    return { kind: 'change', title: `New times from ${weekPhrase(note.fromWeek, thisWeek)}`, subtitle, seenKey }
  }
  if (isUsualSchedule(space.schedule)) return null
  if (note ? note.by === me : space.ownerId === me) return null
  return { kind: 'own', title: 'This space has its own times', subtitle: ownTimesLine(space.schedule, hourCycle), seenKey }
}

// ---------- Pausing a week (SPEC §9.3) ----------

export interface PausePerson {
  uid: UID
  ok: boolean
}

export interface PauseCardView {
  kind: 'pending' | 'declined' | 'paused' | 'lapsed'
  title: string
  subtitle: string
  /** Everyone whose OK is needed, in the week's order, with whether they said it (pending only). */
  people?: PausePerson[]
  /** "2 of 4 said OK". */
  count?: string
  /** Your part: answer, wait, or cancel your own request (pending only). */
  role?: 'to-answer' | 'said-ok' | 'asked' | 'not-asked'
  /** "You said OK. Waiting for Sam and Ben." / "Waiting for Sam and Ben." */
  status?: string
  /** Dismissed per device (declined, and the asker's lapsed request). */
  seenKey?: string
}

export function pauseSeenKey(spaceId: string, atMs: number): string {
  return `pauseSeen.${spaceId}.${atMs}`
}

export interface PauseCardInput {
  space: Pick<Space, 'id' | 'memberIds'>
  me: UID
  nowMs: number
  view: PauseView
  /** The request's week: members (stored, else the current members) and bounds (stored, else computed). */
  week: { members: UID[]; startAt: number; reviewOpenAt: number }
  thisWeek: WeekId
  name: Name
  /** A deadline in words ("Thursday at midnight"). */
  when: (ms: number) => string
  seen: (key: string) => boolean
}

/** The pause card at the top of the Space screen, or null (nothing in play, withdrawn, or dismissed). */
export function pauseCardView({ space, me, nowMs, view, week, thisWeek, name, when, seen }: PauseCardInput): PauseCardView | null {
  const who = (uid: UID) => (uid === me ? 'you' : name(uid))
  switch (view.kind) {
    case 'none':
      return null
    case 'paused': {
      // Until that week starts; from then on the week itself says so.
      if (nowMs >= week.startAt) return null
      return { kind: 'paused', title: `${capitalize(weekPhrase(view.weekId, thisWeek))} is paused`, subtitle: 'Everyone said OK. No reviews and no score that week.' }
    }
    case 'declined': {
      const seenKey = pauseSeenKey(space.id, view.request.at)
      if (seen(seenKey)) return null
      return {
        kind: 'declined',
        title: `Not happening: ${who(view.by)} said not now.`,
        subtitle: `${capitalize(weekPhrase(view.request.weekId, thisWeek))} goes on as usual.`,
        seenKey,
      }
    }
    case 'lapsed': {
      if (view.request.by !== me) return null
      const seenKey = pauseSeenKey(space.id, view.request.at)
      if (seen(seenKey)) return null
      const names = view.waitingFor.filter((uid) => uid !== me).map(name)
      const subtitle = names.length > 0 ? `${compactNames(names)} didn’t answer before reviews opened.` : 'Not everyone said OK before reviews opened.'
      return { kind: 'lapsed', title: 'Your pause didn’t happen', subtitle, seenKey }
    }
    case 'pending': {
      const { request } = view
      const phrase = weekPhrase(request.weekId, thisWeek)
      if (view.me === 'not-asked') {
        return { kind: 'pending', role: 'not-asked', title: `${name(request.by)} asked to pause ${phrase}`, subtitle: 'You’re not in it, so you don’t need to answer.' }
      }
      const needed = pauseNeeded(space.memberIds, week.members)
      const people = needed.map((uid) => ({ uid, ok: request.oks.includes(uid) }))
      const oks = people.filter((p) => p.ok).length
      const asker = request.by === me ? 'You' : name(request.by)
      const waiting = compactNames(view.waitingFor.filter((uid) => uid !== me).map(name))
      const status = view.me === 'said-ok' ? `You said OK. Waiting for ${waiting}.` : view.me === 'asked' && waiting ? `Waiting for ${waiting}.` : undefined
      return {
        kind: 'pending',
        role: view.me,
        title: `Pause ${phrase}?`,
        subtitle: `${asker} asked. It only happens if everyone says OK before reviews open ${when(week.reviewOpenAt)}.`,
        people,
        count: `${oks} of ${people.length} said OK`,
        status,
      }
    }
  }
}

/** "Lena asks to pause next week" on the Spaces card, when your OK is needed. */
export function pauseAskLine(view: PauseView, thisWeek: WeekId, name: Name): string | null {
  if (view.kind !== 'pending' || view.me !== 'to-answer') return null
  return `${name(view.request.by)} asks to pause ${weekPhrase(view.request.weekId, thisWeek)}`
}

export interface PauseRowView {
  /** "Pause a Week", or "Pause Requested" while a request waits for answers. */
  title: string
  /** "Waiting for 2" while pending. */
  detail?: string
  /** Why you can't ask now. */
  subtitle?: string
  /** Opens the action sheet. */
  enabled: boolean
  /** You asked: the Cancel Request row shows. */
  canCancel: boolean
}

/** The Pause a Week row in Space Settings. */
export function pauseRow(view: PauseView, me: UID, choices: { thisWeek: PauseChoice; nextWeek: PauseChoice }, weeks: { thisWeek: WeekId; nextWeek: WeekId }): PauseRowView {
  if (view.kind === 'pending') {
    return { title: 'Pause Requested', detail: `Waiting for ${view.waitingFor.length}`, enabled: false, canCancel: view.request.by === me }
  }
  if (choices.thisWeek === 'ok' || choices.nextWeek === 'ok') return { title: 'Pause a Week', enabled: true, canCancel: false }
  return { title: 'Pause a Week', subtitle: pauseBlockedReason(choices, weeks), enabled: false, canCancel: false }
}

/** Why neither week can be asked for, in SPEC order: the month's pause is used, a request is waiting, you asked not
 *  long ago, too close to reviews. */
export function pauseBlockedReason(choices: { thisWeek: PauseChoice; nextWeek: PauseChoice }, weeks: { thisWeek: WeekId; nextWeek: WeekId }): string {
  const used = (['thisWeek', 'nextWeek'] as const).filter((w) => choices[w] === 'month-used').map((w) => monthIdForWeek(weeks[w]))
  const months = [...new Set(used)]
  if (months.length === 1) return `${monthName(months[0])}’s pause is used.`
  if (months.length === 2) return `${monthName(months[0])}’s and ${monthName(months[1])}’s pauses are used.`
  const all = [choices.thisWeek, choices.nextWeek]
  if (all.includes('request-pending')) return 'A request is waiting for answers.'
  if (all.includes('cooldown')) return 'You asked not long ago.'
  return 'Too close to reviews to ask for this week.'
}

/** The action sheet: "Pause a week?" · "… Everyone in Film Club has to say OK by Thursday at midnight." */
export function pauseSheet(
  spaceName: string,
  choices: { thisWeek: PauseChoice; nextWeek: PauseChoice },
  reviewOpens: { thisWeek: number; nextWeek: number },
  when: (ms: number) => string,
): { title: string; message: string; actions: string[] } {
  const actions: string[] = []
  if (choices.thisWeek === 'ok') actions.push('Pause This Week')
  if (choices.nextWeek === 'ok') actions.push('Pause Next Week')
  const by = choices.thisWeek === 'ok' ? reviewOpens.thisWeek : reviewOpens.nextWeek
  return {
    title: 'Pause a week?',
    message: `Nothing counts in a paused week, and it’s left out of the month’s average. Everyone in ${spaceName} has to say OK by ${when(by)}.`,
    actions,
  }
}

/** The toast after asking: "Asked everyone", or, alone in that week, "Next week is paused". */
export function pauseAskedToast(outcome: 'asked' | 'paused', weekId: WeekId, thisWeek: WeekId): { title: string; message?: string } {
  if (outcome === 'paused') return { title: `${capitalize(weekPhrase(weekId, thisWeek))} is paused` }
  return { title: 'Asked everyone', message: 'They’ll see it next time they open Stakes.' }
}

export const PAUSE_FOOTER = 'Need a break? A paused week doesn’t count: no reviews, no score. It needs everyone’s OK, once a month at most.'

// ---------- A paused week (SPEC §9.3) ----------

/** The status card of a paused week. */
export function pausedWeekCard(weekId: WeekId, thisWeek: WeekId): { title: string; subtitle: string } {
  const month = monthName(monthIdForWeek(weekId))
  if (weekId < thisWeek) return { title: 'This week was paused', subtitle: `Everyone said OK. Nothing counted, and it’s left out of ${month}’s average.` }
  return {
    title: `${capitalize(weekPhrase(weekId, thisWeek))} is paused`,
    subtitle: `Everyone said OK. No reviews, no score, and it’s left out of ${month}’s average.`,
  }
}

/** The footer under your list in a paused week. */
export function pausedListFooter(weekId: WeekId, thisWeek: WeekId): string {
  return `Paused: your list is just for you ${weekId === addWeeks(thisWeek, 1) ? 'next week' : 'this week'}.`
}

/** The paused card's row in the month's last week, when the month's lists are still reviewed. */
export function monthlyReviewRow(monthId: MonthId): { title: string; subtitle: string } {
  return { title: `Review the ${monthName(monthId)} Lists`, subtitle: 'No points this week, just the monthly lists.' }
}

// ---------- Judges (SPEC §9.4) ----------

export const JUDGE_FOOTER_OFF = 'Judges rate everyone each week, with no list, no score and nothing owed.'
export const JUDGE_FOOTER_ON = 'You’re a judge: you rate everyone each week, with no list, no score and nothing owed.'
export const JUDGE_FOOTER_NEW = 'Judges rate everyone each week, with no list, no score and nothing owed. You can change this in Settings.'

/**
 * The Your role footer. `thisWeek` is your role in this week's stored snapshot (null without one); when it differs
 * from your choice (the week had locked), a second sentence says when the change starts.
 */
export function roleFooter(judging: boolean, thisWeekRole: 'judge' | 'player' | null, fromWeek: WeekId): string {
  const base = judging ? JUDGE_FOOTER_ON : JUDGE_FOOTER_OFF
  if (thisWeekRole === null || (thisWeekRole === 'judge') === judging) return base
  const when = `the week of ${weekLabel(fromWeek)}`
  return judging
    ? `${base} This week you’re still playing; you judge from ${when}.`
    : `${base} This week you’re still judging; you play from ${when}.`
}

/** "this week" while its lists haven't locked, else "the week of Oct 20". */
function rolePhrase(fromWeek: WeekId, thisWeek: WeekId): string {
  return fromWeek === thisWeek ? 'this week' : `the week of ${weekLabel(fromWeek)}`
}

export interface JudgeConfirmInput {
  fromWeek: WeekId
  thisWeek: WeekId
  /** You have tasks on that week's list. */
  plannedTasks: boolean
  /** That month's list: 'unlocked' with your tasks (they won't count), 'locked' with your tasks (they still do). */
  monthlyList: 'unlocked' | 'locked' | null
  /** You played a week of that week's month already, or have a locked monthly list with tasks. */
  played: boolean
}

/** Turning Only Rate Friends on: "Only rate from this week?" · … · Only Rate. */
export function judgeConfirm({ fromWeek, thisWeek, plannedTasks, monthlyList, played }: JudgeConfirmInput): { title: string; message: string; confirmLabel: string } {
  const month = monthName(monthIdForWeek(fromWeek))
  const parts = ['You’ll rate everyone each week, with no list, no score and nothing owed.']
  if (plannedTasks) parts.push('Tasks you planned for that week won’t count.')
  if (monthlyList === 'unlocked') parts.push(`Your ${month} list won’t count either.`)
  if (monthlyList === 'locked') parts.push(`Your ${month} list still counts: it locked while you were playing.`)
  if (played) parts.push(`You’ve played in ${month}, so weeks you judge this month count as 0%.`)
  return { title: `Only rate from ${rolePhrase(fromWeek, thisWeek)}?`, message: parts.join(' '), confirmLabel: 'Only Rate' }
}

/** Turning it off: "Play again from the week of Oct 20?" · … · Play. */
export function playConfirm(fromWeek: WeekId, thisWeek: WeekId, lockText: string, judged: boolean): { title: string; message: string; confirmLabel: string } {
  const month = monthName(monthIdForWeek(fromWeek))
  const parts = [`You’ll have your own list again. Plan it before it locks ${lockText}, or that week scores 0%.`]
  if (judged) parts.push(`You judged in ${month}, so those weeks will count as 0% if you play this month.`)
  return { title: `Play again from ${rolePhrase(fromWeek, thisWeek)}?`, message: parts.join(' '), confirmLabel: 'Play' }
}

/** Your own section in a week you judge. */
export function judgeSelf(phase: 'planning' | 'active' | 'review' | 'closed', revealed: boolean, member: { hasSubmitted: boolean; missedReviewsOf: UID[] }): { title: string; subtitle: string } {
  if (phase === 'closed') {
    const subtitle =
      member.missedReviewsOf.length > 0
        ? 'You didn’t review this week. Judges don’t lose points.'
        : member.hasSubmitted
          ? 'You reviewed everyone.'
          : 'There was nothing to review.'
    return { title: 'You judged this week', subtitle }
  }
  if (phase === 'review' && revealed) return { title: 'You’re judging this week', subtitle: 'Thanks for judging.' }
  return { title: 'You’re judging this week', subtitle: 'You rate everyone on review day. No list, no score.' }
}

export const NOBODY_PLAYING = { title: 'Nobody’s playing this week', message: 'Everyone here is a judge. Turn off Only Rate Friends in Settings to plan a list.' }

/** "Owner · Judge · Joined Oct 1". */
export function memberSubtitle(owner: boolean, judge: boolean, joined: string | null): string | undefined {
  return [owner ? 'Owner' : null, judge ? 'Judge' : null, joined ? `Joined ${joined}` : null].filter(Boolean).join(' · ') || undefined
}

// ---------- House stakes in Settings (SPEC §9.7) ----------

/** Where the house stakes count right now (termsNow in stakes/stakes.ts). */
export interface HouseWhen {
  month: MonthId
  thisMonth: MonthId
  window: boolean
}

/** The owner's footer: "They count between two friends until they agree on their own. Changes count right away,
 *  for October." (between a month's completion and the next month's first week: "…, for November. October is
 *  final."); everyone else's: "Only Lena can change the house stakes. Set your own on the Stakes screen." */
export function houseFooter(now: HouseWhen, isOwner: boolean, ownerName: string): string {
  if (!isOwner) return `Only ${ownerName} can change the house stakes. Set your own on the Stakes screen.`
  const base = `They count between two friends until they agree on their own. Changes count right away, for ${monthName(now.month)}.`
  return now.window ? `${base} ${monthName(now.thisMonth)} is final.` : base
}

/** The save toast's message after the owner changed the house stakes. */
export function houseSaved(now: HouseWhen): string {
  return now.window ? `The new house stakes count from ${monthName(now.month)}. ${monthName(now.thisMonth)} is final.` : 'The new house stakes count now.'
}
