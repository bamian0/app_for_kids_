// Pure reminder planning for scripts/reminders.ts (no Firebase, no network). See docs/SPEC.md §4 and §9.11.
//
// Each reminder has a window in the space's local time instead of an exact hour, so a delayed or
// dropped hourly run still sends it on the next run. The sent log (keys from reminderKey) makes
// sure each one goes out once. Weekly windows follow each week's own times (its schedule, in nominal
// wall-clock minutes from its Monday) and close at its stored bounds; on the usual times they are
// exactly the windows from before batch 2 (scripts/reminders-legacy-oracle.ts is the test oracle).
import { DateTime } from 'luxon'
import { isWeekPaused, pauseNeeded } from '../src/domain/pause.ts'
import { boundsFor, momentText, scheduleOf } from '../src/domain/schedule.ts'
import {
  computeMonth,
  computeMonthly,
  computeWeek,
  isTaskDone,
  judgesOf,
  membersAt,
  monthEndsAt,
  monthEndsAtFor,
  reviewTargets,
  spaceJudges,
  taskSelfFraction,
} from '../src/domain/scoring.ts'
import { agreementStatus, monthDebts, monthHouse, monthTerms, termsMonth, type Debt } from '../src/domain/stakes.ts'
import {
  addMonths,
  addWeeks,
  isMonthlyReviewWeek,
  lastCompleteMonthCandidate,
  momentAt,
  monthIdFor,
  monthIdForWeek,
  utcOffsetMinutes,
  weekIdFor,
  weekIdsInMonth,
} from '../src/domain/time.ts'
import type { MemberStakes, MonthId, MonthlyData, MonthlyList, MonthResults, Space, UID, UserProfile, Week, WeekData, WeekId } from '../src/domain/types.ts'

export type ReminderKind =
  | 'plan'
  | 'no-progress'
  | 'open-tasks'
  | 'review'
  | 'last-call'
  | 'results'
  | 'verdict'
  // Event pushes (SPEC §9.11): sent only 09:00–21:00 local, open `./?space=<id>`.
  | 'pause-ask'
  | 'paused'
  | 'schedule'
  | 'stakes'
  | 'house'

/** The midweek nudges: they need only the plans and progress of the members still waiting for one. */
export function isNudge(kind: ReminderKind): boolean {
  return kind === 'no-progress' || kind === 'open-tasks'
}

/** What the job loads for a window's weeks: everything, only what the nudges need, or just the week doc (a pause
 *  request needs only who is in the week). */
export function weekLoad(kind: ReminderKind): WeekLoad {
  return isNudge(kind) ? 'nudge' : kind === 'pause-ask' ? 'doc' : 'full'
}

/** Whether a week loaded as `have` serves a window that needs `need`. */
function serves(have: WeekLoad, need: WeekLoad): boolean {
  return have === 'full' || need === 'doc' || have === need
}

/** Kinds that, in a month's last week, also carry that month's list as a part with its own key. */
const MONTHLY_PARTS: ReadonlySet<ReminderKind> = new Set(['review', 'last-call', 'results'])
const EVENT_KINDS: ReadonlySet<ReminderKind> = new Set(['pause-ask', 'paused', 'schedule', 'stakes', 'house'])

export interface DueWindow {
  kind: ReminderKind
  /** The key's period: the WeekId for the weekly kinds, the MonthId being judged for the verdict,
   *  `${weekId}@${atMs}` (pause-ask, paused), `${fromWeek}@${atMs}` (schedule), `house@${atMs}` (house).
   *  null when the window has no part of its own: a paused last week's review, last-call and results carry only
   *  the month's list, and `stakes` keys depend on the stakes docs (stakesCandidates). */
  period: string | null
  /** Weeks whose data the planner needs to decide this window. */
  weekIds: WeekId[]
  /** Monthly lists the planner needs: in a month's last week its list (a part of review, last-call and results
   *  with its own key `${spaceId}_${monthId}_${kind}_${uid}`), and the judged month's list for the verdict. */
  monthIds?: MonthId[]
  opensAt: number
  closesAt: number
  /** After this the reminder is pointless; used as the push TTL. */
  expiresAt: number
}

export interface Reminder {
  /** Doc id under _private/sent/log. */
  key: string
  /** Every part's key this push carries, when it carries more than one (a week and its month's list): each
   *  one is logged with it. Absent: just `key`. */
  parts?: string[]
  kind: ReminderKind
  spaceId: string
  uid: UID
  title: string
  body: string
  /** Opened on tap, relative to the app root. */
  url: string
  /** A newer notification with the same tag replaces the older one. */
  tag: string
  expiresAt: number
}

/** House stakes frozen for a month (spaces/{id}/months/{monthId}); `createdAt` decides whether the freeze binds. */
export interface FrozenStakes {
  reward: string
  penalty: string
  createdAt?: number
}

export interface SpaceInput {
  space: Space
  /** Loaded weeks by id (a week without a doc has `week: null`). Windows whose weeks are absent are skipped. */
  weeks: Record<WeekId, WeekData>
  /** Week docs known before loading (the job reads last, this and next week after a recent change of times):
   *  their stored bounds and schedules decide the windows, as loaded weeks do. */
  stored?: Record<WeekId, Week>
  /** Loaded monthly lists by month (a month without a list has `monthly: null`). Windows whose lists are absent
   *  are skipped. */
  monthly?: Record<MonthId, MonthlyData>
  /** Frozen house stakes by month (spaces/{id}/months). The verdict falls back to the space's text. */
  stakes?: Record<MonthId, FrozenStakes>
  /** Members' own stakes (spaces/{id}/stakes), for the verdict's terms and the `stakes` kind. The verdict reads
   *  none as no stakes docs (house stakes for everyone); the `stakes` kind waits until they are loaded. */
  memberStakes?: Record<UID, MemberStakes>
  /** Month results docs (spaces/{id}/results): the verdict quotes their terms and streaks. */
  results?: Record<MonthId, MonthResults | null>
  /** How much of each week the job loaded (absent: everything). A window is decided only on weeks loaded as far
   *  as its kind needs (weekLoad), so a week read just for a pause request never decides its review push. */
  loads?: Record<WeekId, WeekLoad>
}

export type WeekLoad = 'full' | 'nudge' | 'doc'

export interface PlanInput {
  nowMs: number
  spaces: SpaceInput[]
  profiles: Record<UID, Pick<UserProfile, 'name'>>
  /** Keys already in the sent log. */
  sent: ReadonlySet<string>
}

export interface PlanResult {
  send: Reminder[]
  /** Keys whose answer is final and is "nothing to send" (already reviewed, no score…).
   *  Logging them keeps later runs from reloading the same data. */
  skipped: string[]
}

const HOUR = 3_600_000
const DAY_MS = 24 * HOUR
const DAY = 1440
/** Two periods' review windows that differ by more than this aren't the same window yet (a list not healed). */
const SAME_WINDOW_MS = 60_000
/** How long the `schedule` and `house` pushes stay worth sending, and how far back `stakes` changes count. */
const EVENT_DAYS = 3
const STAKES_DAYS = 7
const LOCALE = 'en-US'
/** A newer notification with the same tag replaces the older one: the last call replaces the
 *  morning's review reminder, and so on. Other kinds tag as themselves. */
const TAG_GROUP: Partial<Record<ReminderKind, string>> = {
  'last-call': 'review',
  'pause-ask': 'pause',
  paused: 'pause',
  house: 'stakes',
}

export function reminderKey(spaceId: string, period: string, kind: ReminderKind, uid: UID): string {
  return `${spaceId}_${period}_${kind}_${uid}`
}

/** The sent-log keys a window decides for one member, known before loading: its own part's and, in a month's
 *  last week, its list's. None for `stakes` (stakesCandidates gives those once the stakes docs are loaded). */
export function windowKeys(spaceId: string, window: DueWindow, uid: UID): string[] {
  const keys = window.period === null ? [] : [reminderKey(spaceId, window.period, window.kind, uid)]
  if (MONTHLY_PARTS.has(window.kind)) for (const monthId of window.monthIds ?? []) keys.push(reminderKey(spaceId, monthId, window.kind, uid))
  return keys
}

/**
 * The utcOffsetMin the job writes to a space, or null to leave it: spaces from before it existed get
 * one, and so does a space whose offset is more than DST's hour off its own zone (whoever creates a
 * space can write any offset, and one that doesn't fit the zone stops the app from starting weeks).
 */
export function offsetToStore(space: Pick<Space, 'timezone' | 'utcOffsetMin'>, nowMs: number): number | null {
  const offset = Math.round(utcOffsetMinutes(space.timezone, nowMs))
  return space.utcOffsetMin === undefined || Math.abs(space.utcOffsetMin - offset) > 60 ? offset : null
}

// ---------- Quiet hours ----------

const mod = (m: number) => ((m % DAY) + DAY) % DAY

/** A warning before a moment (nominal minutes from a Monday) that would land outside 08:00–22:00 moves back to
 *  20:00 the evening before. */
export function earlierAwake(m: number): number {
  const t = mod(m)
  return t >= 480 && t < 1320 ? m : t >= 1320 ? m - t + 1200 : m - t - 240
}

/** News after a moment (nominal minutes from a Monday) that would land outside `hour`:00–21:00 waits for
 *  `hour`:00. */
export function laterAwake(m: number, hour = 9): number {
  const t = mod(m)
  const h = hour * 60
  return t >= h && t < 1260 ? m : t < h ? m - t + h : m - t + DAY + h
}

/** laterAwake for an instant: `ms` itself between `hour`:00 and 21:00 local, else the next `hour`:00. */
export function laterAwakeAt(ms: number, tz: string, hour = 9): number {
  const local = DateTime.fromMillis(ms, { zone: tz })
  const t = local.hour * 60 + local.minute
  if (t >= hour * 60 && t < 1260) return ms
  return (t < hour * 60 ? local : local.plus({ days: 1 })).set({ hour, minute: 0, second: 0, millisecond: 0 }).toMillis()
}

/** Minutes after local midnight. */
function localMinutes(ms: number, tz: string): number {
  const local = DateTime.fromMillis(ms, { zone: tz })
  return local.hour * 60 + local.minute
}

/** Nothing at all is sent between 00:00 and 08:00 local (SPEC §9.11): the run leaves it for later. */
export function isMuted(space: Pick<Space, 'timezone'>, nowMs: number): boolean {
  return localMinutes(nowMs, space.timezone) < 480
}

/** Event pushes go out only between 09:00 and 21:00 local. */
function eventHours(space: Pick<Space, 'timezone'>, nowMs: number): boolean {
  const t = localMinutes(nowMs, space.timezone)
  return t >= 540 && t < 1260
}

/** `hour`:00 local time, `days` calendar days after `date` ('YYYY-MM-DD') in `tz`. */
function localTime(date: string, days: number, hour: number, tz: string): number {
  return DateTime.fromISO(date, { zone: tz }).plus({ days }).set({ hour, minute: 0, second: 0, millisecond: 0 }).toMillis()
}

// ---------- Windows ----------

/** What is known about stored docs when the windows are computed: week docs and monthly lists by id. */
export interface KnownDocs {
  weeks?: Record<WeekId, Week>
  lists?: Record<MonthId, MonthlyList>
}

/**
 * One week's windows (SPEC §9.11), on the week's own schedule (its doc's, else the space's) in nominal wall-clock
 * minutes from its Monday, closed by its stored bounds (computed without a doc). A paused week has none, except
 * that in a month's last week review, last-call and results still carry the month's list (period null).
 */
function weekWindows(space: Space, weekId: WeekId, doc: Week | null): DueWindow[] {
  const paused = isWeekPaused(space, weekId)
  const lastWeek = isMonthlyReviewWeek(weekId)
  if (paused && !lastWeek) return []
  const tz = space.timezone
  const s = doc ? scheduleOf(doc) : scheduleOf(space)
  const b = boundsFor(space, weekId, doc)
  const at = (m: number) => momentAt(weekId, tz, m)
  const monthIds = lastWeek ? [monthIdForWeek(weekId)] : undefined
  const win = (kind: ReminderKind, opensAt: number, closesAt: number, expiresAt = closesAt, withList = false): DueWindow => {
    const w: DueWindow = { kind, period: paused ? null : weekId, weekIds: paused ? [] : [weekId], opensAt, closesAt, expiresAt }
    if (withList && monthIds) w.monthIds = monthIds
    return w
  }
  const openTasksAt = at(earlierAwake(s.reviewOpen - 360))
  // 18:00 on the day halfway between the lock and the review opening, until that midnight.
  const mid = Math.floor((s.lock + s.reviewOpen) / 2 / DAY) * DAY
  const noProgress = win('no-progress', at(mid + 1080), at(mid + DAY))
  const lastCallAt = Math.max(b.reviewOpenAt, at(earlierAwake(s.deadline - 240)))
  const review = win('review', Math.max(b.reviewOpenAt, at(laterAwake(s.reviewOpen))), lastCallAt, b.deadlineAt, true)
  const resultsAt = laterAwake(s.deadline)
  const reviewing = [
    // No separate review push when the last call opens as soon as reviews do (a short window).
    ...(review.opensAt < review.closesAt ? [review] : []),
    win('last-call', lastCallAt, b.deadlineAt, b.deadlineAt, true),
    // Until midnight two days after the day results come in.
    win('results', Math.max(b.deadlineAt, at(resultsAt)), at((Math.floor(resultsAt / DAY) + 2) * DAY), undefined, true),
  ]
  if (paused) return reviewing
  return [
    win('plan', at(earlierAwake(s.lock - 360)), b.lockAt),
    ...(noProgress.opensAt >= b.lockAt && noProgress.closesAt <= openTasksAt ? [noProgress] : []),
    ...(openTasksAt >= b.lockAt ? [win('open-tasks', openTasksAt, b.reviewOpenAt)] : []),
    ...reviewing,
  ]
}

/** The previous month's verdict: from the 1st at 10:00, or once the month is complete (its last stored deadline,
 *  or its list's) the next morning at 10:00, until midnight two days after that day. */
function verdictWindow(space: Space, nowMs: number, known: KnownDocs): DueWindow {
  const tz = space.timezone
  const monthId = monthIdFor(nowMs, tz)
  const judged = addMonths(monthId, -1)
  const weekIds = weekIdsInMonth(judged)
  const last = weekIds[weekIds.length - 1]
  const completeAt = monthEndsAtFor(space, judged, known.weeks?.[last] ?? null, known.lists?.[judged] ?? null)
  const opensAt = Math.max(localTime(`${monthId}-01`, 0, 10, tz), laterAwakeAt(completeAt, tz, 10))
  const day = DateTime.fromMillis(opensAt, { zone: tz }).toISODate() ?? `${monthId}-01`
  const closesAt = localTime(day, 2, 0, tz)
  return { kind: 'verdict', period: judged, weekIds, monthIds: [judged], opensAt, closesAt, expiresAt: closesAt }
}

/** The event pushes' windows (SPEC §9.11) known from the space doc alone (not `stakes`: stakesWindow); only
 *  between 09:00 and 21:00 local. */
function eventWindows(space: Space, nowMs: number, known: KnownDocs): DueWindow[] {
  if (!eventHours(space, nowMs)) return []
  const tz = space.timezone
  const windows: DueWindow[] = []
  const p = space.pause
  if (p) {
    const reviewOpenAt = boundsFor(space, p.weekId, known.weeks?.[p.weekId] ?? null).reviewOpenAt
    const period = `${p.weekId}@${p.at}`
    const opensAt = laterAwakeAt(p.at, tz)
    if (isWeekPaused(space, p.weekId)) {
      windows.push({ kind: 'paused', period, weekIds: [], opensAt, closesAt: reviewOpenAt, expiresAt: reviewOpenAt })
    } else if (!p.declinedBy) {
      // Until that week's reviews open: then the request has lapsed.
      windows.push({ kind: 'pause-ask', period, weekIds: [p.weekId], opensAt, closesAt: reviewOpenAt, expiresAt: reviewOpenAt })
    }
  }
  const note = space.scheduleNote
  if (note) {
    const closesAt = note.at + EVENT_DAYS * DAY_MS
    windows.push({ kind: 'schedule', period: `${note.fromWeek}@${note.at}`, weekIds: [], opensAt: laterAwakeAt(note.at, tz), closesAt, expiresAt: closesAt })
  }
  const house = space.stakesNote
  if (house) {
    const closesAt = house.at + EVENT_DAYS * DAY_MS
    windows.push({ kind: 'house', period: `house@${house.at}`, weekIds: [], opensAt: laterAwakeAt(house.at, tz), closesAt, expiresAt: closesAt })
  }
  return windows
}

/**
 * The `stakes` window: every day 09:00–21:00 local in a space with friends. Whether anyone's stakes changed in the
 * last week takes a query (the job's one stakes read a run), so it isn't among dueWindows; its keys come from
 * stakesCandidates once the stakes docs are loaded.
 */
export function stakesWindow(space: Space, nowMs: number): DueWindow | null {
  if (space.memberIds.length < 2 || !eventHours(space, nowMs)) return null
  const tz = space.timezone
  const today = DateTime.fromMillis(nowMs, { zone: tz }).toISODate() ?? ''
  const closesAt = localTime(today, 0, 21, tz)
  return { kind: 'stakes', period: null, weekIds: [], opensAt: localTime(today, 0, 9, tz), closesAt, expiresAt: closesAt }
}

/**
 * Every reminder window around `nowMs` for a space, open or not: last, this and next week's on their own times (a
 * Sunday-midnight deadline puts results on Monday, an early lock puts next week's plan push on Sunday), the previous
 * month's verdict, and the event pushes of the moment (not `stakes`: stakesWindow). Apart from the event pushes
 * (only 09:00–21:00 local), it depends on nowMs only through its week and month. `known`: stored docs already read
 * (the job's preload, or loaded data), whose bounds and schedules decide; weeks without one are computed on the
 * space's schedule.
 */
export function windowsAround(space: Space, nowMs: number, known: KnownDocs = {}): DueWindow[] {
  const thisWeek = weekIdFor(nowMs, space.timezone)
  const windows = [addWeeks(thisWeek, -1), thisWeek, addWeeks(thisWeek, 1)].flatMap((weekId) => {
    const doc = known.weeks?.[weekId]
    return weekWindows(space, weekId, doc && doc.id === weekId ? doc : null)
  })
  windows.push(verdictWindow(space, nowMs, known), ...eventWindows(space, nowMs, known))
  return windows
}

/** Whether a window is open at `nowMs`. */
export function isOpen(window: DueWindow, nowMs: number): boolean {
  return window.opensAt <= nowMs && nowMs < window.closesAt
}

/** The reminder windows open at `nowMs` for a space (windowsAround, open now). */
export function dueWindows(space: Space, nowMs: number, known: KnownDocs = {}): DueWindow[] {
  return windowsAround(space, nowMs, known).filter((w) => isOpen(w, nowMs))
}

/** The stored docs a space's input knows: preloaded weeks, then loaded weeks and lists. */
function knownDocs(input: SpaceInput): KnownDocs {
  const known: KnownDocs = { weeks: { ...input.stored }, lists: {} }
  for (const data of Object.values(input.weeks)) if (data.week) known.weeks![data.weekId] = data.week
  for (const data of Object.values(input.monthly ?? {})) if (data.monthly) known.lists![data.monthId] = data.monthly
  return known
}

function windowId(w: DueWindow): string {
  return `${w.kind}|${w.period ?? ''}|${w.weekIds.join(',')}|${(w.monthIds ?? []).join(',')}`
}

/**
 * The windows planSpace decides for a space: those open by what the job knew when it chose what to load (its
 * preloaded `stored` docs, else computed times), and those open only by the docs it then loaded; a window both see
 * is taken from the loaded docs. Deciding a window the stored bounds have already closed logs its final no-ops
 * (no plan push after a stored lock), so the job doesn't reload that week every run. Plus `stakes` once the stakes
 * docs are in.
 */
export function planWindows(input: SpaceInput, nowMs: number): DueWindow[] {
  const loaded = dueWindows(input.space, nowMs, knownDocs(input))
  const byId = new Map(loaded.map((w) => [windowId(w), w]))
  const windows: DueWindow[] = []
  for (const w of dueWindows(input.space, nowMs, { weeks: input.stored ?? {} })) {
    const id = windowId(w)
    windows.push(byId.get(id) ?? w)
    byId.delete(id)
  }
  windows.push(...byId.values())
  const stakes = input.memberStakes ? stakesWindow(input.space, nowMs) : null
  if (stakes) windows.push(stakes)
  return windows
}

/**
 * The newest month the results writer looks at (SPEC §9.8, §9.11): lastCompleteMonthCandidate, or this week's
 * month when this week is its last week and the month is already complete by what is known (the stored last week
 * and list, else computed times), so a month's results come in the first run after it ends rather than the
 * following Monday. The writer still checks the stored deadlines before writing.
 */
export function resultsTarget(space: Space, nowMs: number, known: KnownDocs = {}): MonthId {
  const thisWeek = weekIdFor(nowMs, space.timezone)
  if (isMonthlyReviewWeek(thisWeek)) {
    const monthId = monthIdForWeek(thisWeek)
    if (nowMs >= monthEndsAtFor(space, monthId, known.weeks?.[thisWeek] ?? null, known.lists?.[monthId] ?? null)) return monthId
  }
  return lastCompleteMonthCandidate(nowMs, space.timezone)
}

// ---------- Copy ----------

/** "Anna", "Anna and Ben", "Anna, Ben, and Chris", "Anna, Ben, and 3 others". */
export function listNames(names: string[]): string {
  if (names.length <= 3) return new Intl.ListFormat(LOCALE, { type: 'conjunction' }).format(names)
  return `${names.slice(0, 2).join(', ')}, and ${names.length - 2} others`
}

/** Whole percent, rounded down so 89.6 never reads as a passing 90 (with slack for float error). */
export function formatPercent(score: number): string {
  return `${Math.floor(score + 1e-9)}%`
}

function monthName(monthId: MonthId): string {
  return new Intl.DateTimeFormat(LOCALE, { month: 'long', timeZone: 'UTC' }).format(new Date(`${monthId}-01T00:00:00Z`))
}

/** "Oct 19": a week by its Monday. */
function weekDate(weekId: WeekId): string {
  return new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${weekId}T00:00:00Z`))
}

/** "Europe/Berlin" → "Berlin", "America/Los_Angeles" → "Los Angeles". */
function cityOf(zone: string): string {
  return (zone.split('/').pop() ?? zone).replace(/_/g, ' ')
}

/** "6 hours", "1 hour", "under an hour". Relative, so it reads right in every member's timezone. */
export function hoursFromNow(ms: number): string {
  const hours = Math.round(ms / HOUR)
  if (hours >= 2) return `${hours} hours`
  return hours === 1 ? '1 hour' : 'under an hour'
}

/** "1 task", "3 tasks". */
function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`
}

function hoursLeftTitle(msLeft: number): string {
  const hours = Math.round(msLeft / HOUR)
  if (hours >= 2) return `${hours} hours left`
  return hours === 1 ? '1 hour left' : 'Less than an hour left'
}

/** The day reviews open, for "… to go before Friday": the weekday when they open at the start of a day (the
 *  usual Thursday at midnight is "Friday"), else "reviews open". */
function beforeReviews(reviewOpen: number): string {
  if (reviewOpen % DAY !== 0) return 'reviews open'
  return ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][((reviewOpen / DAY) % 7 + 7) % 7]
}

/** "next week", "this week", "the week of Oct 26". */
function weekPhrase(weekId: WeekId, nowMs: number, tz: string): string {
  const thisWeek = weekIdFor(nowMs, tz)
  if (weekId === thisWeek) return 'this week'
  if (weekId === addWeeks(thisWeek, 1)) return 'next week'
  return `the week of ${weekDate(weekId)}`
}

// ---------- Decisions ----------

/** One member's answer for one key: a push to send (carrying every key in `keys`), or a skip. */
type Outcome =
  | { uid: UID; key: string; skip: 'final' | 'not-yet' }
  | { uid: UID; keys: string[]; title: string; body: string; expiresAt?: number }

interface Context {
  input: SpaceInput
  space: Space
  weeks: Record<WeekId, WeekData>
  monthly: Record<MonthId, MonthlyData>
  profiles: PlanInput['profiles']
  sent: ReadonlySet<string>
  nowMs: number
  /** Someone who left after lock is still reviewed; with their profile gone (a deleted account) they are named
   *  as what they are. */
  name: (uid: UID) => string
}

const final = (uid: UID, key: string): Outcome => ({ uid, key, skip: 'final' })
const notYet = (uid: UID, key: string): Outcome => ({ uid, key, skip: 'not-yet' })

/** A part of a review-day push (the week, or the month's list) for one member. */
type Part =
  | { key: string; skip: 'final' | 'not-yet' }
  | { key: string; due: true; targets: UID[]; judge: boolean; points: number; deadlineAt: number; score?: number }

function weeklyKey(ctx: Context, window: DueWindow, uid: UID): string | null {
  return window.period === null ? null : reminderKey(ctx.space.id, window.period, window.kind, uid)
}

/** The weekly part of review and last-call: whom `uid` still has to rate in the week. */
function weekReviewPart(ctx: Context, weekId: WeekId, key: string, uid: UID): Part {
  const { space, nowMs } = ctx
  const data = ctx.weeks[weekId]
  const week = data?.week
  // After lock, members and plans are frozen and submitting is one-way: every decision is final. Only current
  // members are asked (a leaver can't submit), but whoever they must rate includes anyone who left after lock.
  if (!week || !week.members.includes(uid) || week.submittedBy.includes(uid)) return { key, skip: 'final' }
  // The stored review window rules: never "due in" after it has closed.
  if (nowMs >= week.deadlineAt) return { key, skip: 'final' }
  if (nowMs < week.reviewOpenAt) return { key, skip: 'not-yet' }
  const targets = reviewTargets(data, uid, membersAt(space, week.lockAt))
  if (targets.length === 0) return { key, skip: 'final' }
  const judge = judgesOf(week).includes(uid)
  return { key, due: true, targets, judge, points: judge ? 0 : space.latePenalty * targets.length, deadlineAt: week.deadlineAt }
}

/** The monthly part of review and last-call in a month's last week: whom `uid` still has to rate in the list.
 *  Not yet while the list's stored window differs from the week's (not healed): the week goes out alone. */
function listReviewPart(ctx: Context, monthId: MonthId, weekId: WeekId | null, key: string, uid: UID): Part {
  const { space, nowMs } = ctx
  const data = ctx.monthly[monthId]
  const list = data?.monthly
  if (!list || !list.members.includes(uid) || list.submittedBy.includes(uid)) return { key, skip: 'final' }
  if (nowMs >= list.deadlineAt) return { key, skip: 'final' }
  if (nowMs < list.reviewOpenAt) return { key, skip: 'not-yet' }
  const week = weekId ? ctx.weeks[weekId]?.week : null
  if (week && (Math.abs(week.reviewOpenAt - list.reviewOpenAt) > SAME_WINDOW_MS || Math.abs(week.deadlineAt - list.deadlineAt) > SAME_WINDOW_MS)) {
    return { key, skip: 'not-yet' }
  }
  const targets = reviewTargets(data, uid, membersAt(space, list.lockAt))
  if (targets.length === 0) return { key, skip: 'final' }
  const judge = judgesOf(list).includes(uid)
  // Missed monthly reviews cost nothing when the month's last week is paused (SPEC §9.3).
  const paused = weekId === null || isWeekPaused(space, weekId)
  return { key, due: true, targets, judge, points: judge || paused ? 0 : space.latePenalty * targets.length, deadlineAt: list.deadlineAt }
}

/** The weekly part of results. */
function weekResultsPart(ctx: Context, weekId: WeekId, key: string, uid: UID): Part {
  const data = ctx.weeks[weekId]
  const result = data?.week ? computeWeek(data, ctx.space, ctx.nowMs) : null
  const member = result?.members[uid]
  if (!result || !member?.participating) return { key, skip: 'final' }
  if (member.judge) return result.revealed ? { key, due: true, targets: [], judge: true, points: 0, deadlineAt: 0 } : { key, skip: 'not-yet' }
  if (member.score === null) return { key, skip: 'not-yet' }
  return { key, due: true, targets: [], judge: false, points: 0, deadlineAt: 0, score: member.score }
}

/** The monthly part of results: the score of `uid`'s own list, once revealed. */
function listResultsPart(ctx: Context, monthId: MonthId, key: string, uid: UID): Part {
  const data = ctx.monthly[monthId]
  if (!data?.monthly) return { key, skip: 'final' }
  const member = computeMonthly(data, ctx.space, ctx.nowMs).members[uid]
  // Judges and players without a list have nothing to hear about it.
  if (!member?.participating || member.judge || member.taskCount === 0) return { key, skip: 'final' }
  if (member.score === null) return { key, skip: 'not-yet' }
  return { key, due: true, targets: [], judge: false, points: 0, deadlineAt: 0, score: member.score }
}

type Due = Extract<Part, { due: true }>

/** Review, last-call and results: the week's part and, in a month's last week, the list's part, each with its
 *  own key. One push carries every part that is due and not yet logged; final parts are logged as skipped. */
function decideReviewDay(ctx: Context, window: DueWindow): Outcome[] {
  const { space, nowMs, sent } = ctx
  const monthId = MONTHLY_PARTS.has(window.kind) ? window.monthIds?.[0] : undefined
  const weekId = window.period
  return space.memberIds.flatMap((uid): Outcome[] => {
    const parts: Part[] = []
    const wKey = weeklyKey(ctx, window, uid)
    if (weekId && wKey) parts.push(window.kind === 'results' ? weekResultsPart(ctx, weekId, wKey, uid) : weekReviewPart(ctx, weekId, wKey, uid))
    const mKey = monthId ? reminderKey(space.id, monthId, window.kind, uid) : null
    if (monthId && mKey) parts.push(window.kind === 'results' ? listResultsPart(ctx, monthId, mKey, uid) : listReviewPart(ctx, monthId, weekId, mKey, uid))
    const open = parts.filter((p) => !sent.has(p.key))
    const skips = open.flatMap((p): Outcome[] => ('skip' in p ? [{ uid, key: p.key, skip: p.skip }] : []))
    const due = open.filter((p): p is Due => 'due' in p)
    if (due.length === 0) return skips
    const weekly = due.find((p) => p.key === wKey)
    const list = due.find((p) => p.key === mKey)
    const label = monthId ? monthName(monthId) : ''
    const names = (ids: UID[]) => listNames([...new Set(ids)].map(ctx.name))
    let copy: { title: string; body: string } | null
    switch (window.kind) {
      case 'review': {
        const targets = [...(weekly?.targets ?? []), ...(list?.targets ?? [])]
        const deadlineAt = (weekly ?? list ?? due[0]).deadlineAt
        const left = hoursFromNow(deadlineAt - nowMs)
        const body = weekly
          ? `Rate ${names(targets)} in ${space.name}${list ? `, ${label} lists too` : ''}. Due in ${left}.`
          : `Rate the ${label} lists of ${names(targets)} in ${space.name}. Due in ${left}.`
        copy = { title: 'Review day', body }
        break
      }
      case 'last-call': {
        const points = due.reduce((sum, p) => sum + p.points, 0)
        const judge = due.some((p) => p.judge)
        const deadlineAt = (weekly ?? list ?? due[0]).deadlineAt
        if (points > 0) copy = { title: hoursLeftTitle(deadlineAt - nowMs), body: `Miss the ${space.name} deadline and you lose ${points} points.` }
        else if (judge) {
          const targets = [...new Set(due.flatMap((p) => p.targets))]
          copy = { title: hoursLeftTitle(deadlineAt - nowMs), body: `${names(targets)} ${targets.length === 1 ? 'is' : 'are'} waiting for your marks in ${space.name}.` }
        } else copy = null // Nothing at stake and no judge: no last call (a paused last week's list).
        break
      }
      default: {
        const weekScore = weekly?.score
        const listScore = list?.score
        const own = weekScore !== undefined ? `You scored ${formatPercent(weekScore)}${listScore !== undefined ? `, and ${formatPercent(listScore)} on your ${label} list` : ''}. ` : listScore !== undefined ? `You scored ${formatPercent(listScore)} on your ${label} list. ` : ''
        copy = { title: 'Results are in', body: `${own}See how ${space.name} did this ${weekly ? 'week' : 'month'}.` }
      }
    }
    if (!copy) return [...skips, ...due.map((p) => final(uid, p.key))]
    return [...skips, { uid, keys: due.map((p) => p.key), ...copy }]
  })
}

function decidePlan(ctx: Context, window: DueWindow): Outcome[] {
  const { space, nowMs } = ctx
  const weekId = window.period as WeekId
  // Once the week doc exists, its stored lockAt is the deadline (see SPEC §1).
  const data = ctx.weeks[weekId]
  const lockAt = data.week?.lockAt ?? window.closesAt
  const key = (uid: UID) => reminderKey(space.id, weekId, 'plan', uid)
  if (nowMs >= lockAt) return space.memberIds.map((uid) => final(uid, key(uid)))
  // A judge has no list, but can switch back before the lock: the week's snapshot, else the space's.
  const judges = data.week ? judgesOf(data.week) : spaceJudges(space)
  return space.memberIds.map((uid): Outcome => {
    // Tasks can still be deleted before lock, so the decision isn't final.
    if (judges.includes(uid) || (data.plans[uid]?.tasks.length ?? 0) > 0) return notYet(uid, key(uid))
    const body = `Your list for ${space.name} locks in ${hoursFromNow(lockAt - nowMs)}.`
    // Everyone in the space joins the week once anyone opens the app before lock; until then the 0% only holds
    // for those already in it.
    const inWeek = data.week?.members.includes(uid) ?? false
    return { uid, keys: [key(uid)], title: 'Lock in your week', body: inWeek ? `${body} Nothing planned = 0%.` : body }
  })
}

function decideNudge(ctx: Context, window: DueWindow): Outcome[] {
  // After lock nobody joins the week, so someone outside it stays out. Tasks can still be added until reviews
  // open and ticks undone until the deadline, so nothing else is final. A member whose plan wasn't loaded (the
  // job loads only those still waiting) reads as having no tasks, which isn't final either.
  const { space, nowMs } = ctx
  const weekId = window.period as WeekId
  const data = ctx.weeks[weekId]
  const week = data.week
  const key = (uid: UID) => reminderKey(space.id, weekId, window.kind, uid)
  const judges = week ? judgesOf(week) : []
  return space.memberIds.map((uid): Outcome => {
    // Judges have no list, and the week's snapshot is fixed after the lock.
    if (!week || !week.members.includes(uid) || judges.includes(uid)) return final(uid, key(uid))
    // The stored timeline rules: no nudge once reviews have opened.
    if (nowMs >= week.reviewOpenAt) return final(uid, key(uid))
    const tasks = data.plans[uid]?.tasks ?? []
    const done = data.progress[uid]?.done ?? {}
    if (tasks.length === 0) return notYet(uid, key(uid))
    if (window.kind === 'no-progress') {
      // Only the current list counts: a tick left by a task deleted before the lock isn't progress, and one
      // step ticked is.
      if (tasks.some((task) => taskSelfFraction(task, done) > 0)) return notYet(uid, key(uid))
      const before = beforeReviews(scheduleOf(week).reviewOpen)
      return { uid, keys: [key(uid)], title: 'Nothing ticked yet', body: `Halfway through the week in ${space.name}. ${count(tasks.length, 'task')} to go before ${before}.` }
    }
    const open = tasks.filter((task) => !isTaskDone(task, done)).length
    if (open === 0) return notYet(uid, key(uid))
    return {
      uid,
      keys: [key(uid)],
      title: `${open} of ${count(tasks.length, 'task')} still open`,
      body: `Reviews in ${space.name} start in ${hoursFromNow(week.reviewOpenAt - nowMs)}. Finish what you can before then.`,
    }
  })
}

/**
 * Last month's verdict per member (SPEC §9.11), quoting the terms that counted: the month's results doc's terms
 * (written earlier in the same run), else monthTerms with the month's completion and its house stakes (its
 * freeze when it binds, else the space's). Not yet while the month isn't complete.
 */
function decideVerdict(ctx: Context, window: DueWindow): Outcome[] {
  const { space, nowMs, input } = ctx
  const monthId = window.period as MonthId
  const weeks = window.weekIds.map((id) => ctx.weeks[id])
  const lists = ctx.monthly[monthId]
  const month = computeMonth(space, monthId, weeks, nowMs, lists)
  const results = input.results?.[monthId] ?? null
  const completeAt = monthEndsAt(space, monthId, weeks, lists)
  const first = window.weekIds[0]
  const firstLockAt = boundsFor(space, first, ctx.weeks[first]?.week ?? null).lockAt
  const frozen = input.stakes?.[monthId]
  const house = monthHouse(space, monthId, frozen ? { ...frozen, frozen: true } : null, completeAt)
  const terms = monthTerms(space, monthId, month, input.memberStakes ?? {}, house, { completeAt, firstLockAt }, results)
  // Streak rewards only once the results doc knows the runs.
  const tierRuns = results ? Object.fromEntries(Object.entries(results.members).map(([uid, e]) => [uid, e.tierRuns ?? {}])) : null
  const debts = monthDebts(monthId, month, terms, tierRuns)
  const label = monthName(monthId)
  return space.memberIds.map((uid): Outcome => {
    const key = reminderKey(space.id, monthId, 'verdict', uid)
    const result = month[uid]
    if (result && !result.complete) return notYet(uid, key)
    if (!result || result.finalScore === null || result.passed === null) return final(uid, key)
    // Nobody else played the month: nothing is owed either way.
    if (result.others.length === 0) return final(uid, key)
    const score = formatPercent(result.finalScore)
    const done = `${label} in ${space.name} is done.`
    const mine = (kind: Debt['kind']) => debts.filter((d) => d.subject === uid && d.kind === kind)
    const uniform = (owed: Debt[]) => owed.every((d) => d.what === owed[0].what)
    const others = (owed: Debt[]) => listNames(owed.map((d) => ctx.name(d.other)))
    if (result.passed) {
      const rewards = mine('reward')
      const tiers = mine('tier')
      const tierTexts = [...new Set(tiers.map((d) => d.what))]
      const streak = results?.members[uid]?.streak ?? 0
      const title = tiers.length > 0 && streak >= 2 ? `${streak} months in a row: ${score}` : `You made it: ${score}`
      if (rewards.length === 0 || uniform(rewards)) {
        const what = rewards[0]?.what ?? house.reward
        return { uid, keys: [key], title, body: `${done} Collect: ${what}${tiers.length > 0 ? `, plus ${listNames(tierTexts)}.` : ''}` }
      }
      const plus = tierTexts.length > 1 ? ', plus your streak rewards' : tierTexts.length === 1 ? ', plus your streak reward' : ''
      return { uid, keys: [key], title, body: `${done} Collect from ${others(rewards)}${plus}.` }
    }
    const penalties = mine('penalty')
    const title = `You fell short: ${score}`
    if (penalties.length === 0 || uniform(penalties)) return { uid, keys: [key], title, body: `${done} Pay up: ${penalties[0]?.what ?? house.penalty}` }
    return { uid, keys: [key], title, body: `${done} Pay up to ${others(penalties)}.` }
  })
}

/** The changes of a schedule note, as one phrase: "lists lock Monday at 8:00 PM and reviews are due Saturday at
 *  noon". */
function changePhrase(before: Space['schedule'], after: Space['schedule']): string | null {
  const b = scheduleOf({ schedule: before })
  const a = scheduleOf({ schedule: after })
  const parts: string[] = []
  if (a.lock !== b.lock) parts.push(`lists lock ${momentText(a.lock)}`)
  if (a.reviewOpen !== b.reviewOpen) parts.push(`reviews open ${momentText(a.reviewOpen)}`)
  if (a.deadline !== b.deadline) parts.push(`reviews are due ${momentText(a.deadline)}`)
  return parts.length > 0 ? listNames(parts) : null
}

/** Whether `uid` was in the space before `atMs` (a member without a join time counts). */
function joinedBefore(space: Space, uid: UID, atMs: number): boolean {
  const joined = space.joinedAt[uid]
  return !(typeof joined === 'number' && joined > atMs)
}

/** The first letter up: names start sentences. */
function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function decideEvent(ctx: Context, window: DueWindow): Outcome[] {
  const { space, nowMs } = ctx
  const period = window.period as string
  const key = (uid: UID) => reminderKey(space.id, period, window.kind, uid)
  const send = (uid: UID, title: string, body: string): Outcome => ({ uid, keys: [key(uid)], title, body })
  switch (window.kind) {
    case 'pause-ask': {
      const p = space.pause!
      // Asking creates the week doc first; who must say OK is everyone in it who is still in the space.
      const needed = pauseNeeded(space.memberIds, ctx.weeks[p.weekId]?.week?.members ?? space.memberIds)
      const body = `${capital(ctx.name(p.by))} wants to pause ${space.name} for the week of ${weekDate(p.weekId)}. It only happens if everyone says OK.`
      return space.memberIds.map((uid) => (!needed.includes(uid) || p.oks.includes(uid) ? final(uid, key(uid)) : send(uid, 'Pause a week?', body)))
    }
    case 'paused': {
      const p = space.pause!
      // Whoever completed it already knows.
      const completer = p.oks[p.oks.length - 1]
      const body = `Everyone said OK: ${space.name} is paused the week of ${weekDate(p.weekId)}. Nothing counts that week.`
      return space.memberIds.map((uid) => (uid === completer ? final(uid, key(uid)) : send(uid, 'Week paused', body)))
    }
    case 'schedule': {
      const note = space.scheduleNote!
      const changes = changePhrase(note.before, space.schedule)
      const body = `${capital(ctx.name(note.by))} changed them. From ${weekPhrase(note.fromWeek, nowMs, space.timezone)}, ${changes}, ${cityOf(space.timezone)} time.`
      return space.memberIds.map((uid) =>
        uid === note.by || !joinedBefore(space, uid, note.at) || !changes ? final(uid, key(uid)) : send(uid, `New times in ${space.name}`, body),
      )
    }
    case 'house': {
      const note = space.stakesNote!
      // A change made between a month's completion and the next month's first week counts from the next month.
      const weekId = weekIdFor(note.at, space.timezone)
      const counts = termsMonth(space, note.at, ctx.weeks[weekId]?.week ?? ctx.input.stored?.[weekId] ?? null, ctx.monthly[monthIdForWeek(weekId)]?.monthly ?? null)
      const when = counts === monthIdForWeek(weekId) ? 'now' : `from ${monthName(counts)}`
      const body = `${capital(ctx.name(note.by))} changed them: “${space.reward}” if you hit ${space.threshold}%, “${space.penalty}” if you miss. They count ${when}, where friends haven’t agreed on their own.`
      return space.memberIds.map((uid) => (uid === note.by || !joinedBefore(space, uid, note.at) ? final(uid, key(uid)) : send(uid, `New house stakes in ${space.name}`, body)))
    }
    default:
      return []
  }
}

export interface StakesCandidate {
  /** Whose stakes changed. */
  owner: UID
  /** A current friend (not a judge) whose agreement they wait for. */
  friend: UID
  key: string
  /** A week after the change. */
  expiresAt: number
}

/**
 * The `stakes` pushes that may be due (SPEC §9.11): for each current member whose stakes changed in the last 7
 * days, each current friend who doesn't judge and whose agreement is 'waiting'. Keys depend on the change
 * (`${spaceId}_${owner}@${updatedAtMs}_stakes_${friend}`), so the job reads them from the sent log after loading.
 */
export function stakesCandidates(space: Space, memberStakes: Record<UID, MemberStakes> | undefined, nowMs: number): StakesCandidate[] {
  const judges = spaceJudges(space)
  const out: StakesCandidate[] = []
  for (const owner of space.memberIds) {
    const stakes = memberStakes?.[owner]
    if (!stakes || !(stakes.updatedAt > nowMs - STAKES_DAYS * DAY_MS)) continue
    for (const friend of space.memberIds) {
      if (friend === owner || judges.includes(friend) || agreementStatus(stakes, friend) !== 'waiting') continue
      out.push({ owner, friend, key: reminderKey(space.id, `${owner}@${stakes.updatedAt}`, 'stakes', friend), expiresAt: stakes.updatedAt + STAKES_DAYS * DAY_MS })
    }
  }
  return out
}

function decideStakes(ctx: Context): Outcome[] {
  return stakesCandidates(ctx.space, ctx.input.memberStakes, ctx.nowMs).map(({ owner, friend, key, expiresAt }) => {
    const who = capital(ctx.name(owner))
    return { uid: friend, keys: [key], title: `New stakes from ${who}`, body: `${who} has new stakes in ${ctx.space.name}. Take a look, and tap Agree if you’re in.`, expiresAt }
  })
}

function decide(ctx: Context, window: DueWindow): Outcome[] {
  switch (window.kind) {
    case 'plan':
      return decidePlan(ctx, window)
    case 'no-progress':
    case 'open-tasks':
      return decideNudge(ctx, window)
    case 'review':
    case 'last-call':
    case 'results':
      return decideReviewDay(ctx, window)
    case 'verdict':
      return decideVerdict(ctx, window)
    case 'stakes':
      return decideStakes(ctx)
    default:
      return decideEvent(ctx, window)
  }
}

/** Reminders to send now, and final no-ops to log, for one space, over planWindows. Nothing is sent between 00:00
 *  and 08:00 local (the windows stay open, so a later run sends it); final no-ops are still logged. */
export function planSpace(input: SpaceInput, profiles: PlanInput['profiles'], sent: ReadonlySet<string>, nowMs: number): PlanResult {
  const { space, weeks } = input
  const monthly = input.monthly ?? {}
  const members = space.memberIds
  const ctx: Context = {
    input,
    space,
    weeks,
    monthly,
    profiles,
    sent,
    nowMs,
    name: (uid) => profiles[uid]?.name?.trim() || (members.includes(uid) ? 'a friend' : 'a former member'),
  }
  const muted = isMuted(space, nowMs)
  const result: PlanResult = { send: [], skipped: [] }
  const skipped = new Set<string>()
  for (const window of planWindows(input, nowMs)) {
    const need = weekLoad(window.kind)
    if (!window.weekIds.every((id) => id in weeks && serves(input.loads?.[id] ?? 'full', need))) continue
    if (!(window.monthIds ?? []).every((id) => id in monthly)) continue
    for (const outcome of decide(ctx, window)) {
      if ('skip' in outcome) {
        if (outcome.skip === 'final' && !sent.has(outcome.key) && !skipped.has(outcome.key)) {
          skipped.add(outcome.key)
          result.skipped.push(outcome.key)
        }
        continue
      }
      const keys = outcome.keys.filter((k) => !sent.has(k))
      if (keys.length === 0 || muted) continue
      const reminder: Reminder = {
        key: keys[0],
        kind: window.kind,
        spaceId: space.id,
        uid: outcome.uid,
        title: outcome.title,
        body: outcome.body,
        url: EVENT_KINDS.has(window.kind) ? `./?space=${space.id}` : './',
        tag: `${TAG_GROUP[window.kind] ?? window.kind}-${space.id}`,
        expiresAt: outcome.expiresAt ?? window.expiresAt,
      }
      if (keys.length > 1) reminder.parts = keys
      result.send.push(reminder)
    }
  }
  return result
}

export function planReminders(input: PlanInput): PlanResult {
  const all: PlanResult = { send: [], skipped: [] }
  for (const space of input.spaces) {
    const { send, skipped } = planSpace(space, input.profiles, input.sent, input.nowMs)
    all.send.push(...send)
    all.skipped.push(...skipped)
  }
  return all
}
