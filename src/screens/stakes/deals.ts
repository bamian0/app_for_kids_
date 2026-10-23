// The words and models of deals on screen (SPEC §12.10), pure so they are unit-tested without a DOM: the Space
// screen's stakes card (your block, the news line, the October window), the Stakes screen's sections and footers,
// a deal's own screen (its periods, friends, actions and footers), the editor's footers, every confirm and toast,
// Past Deals, the Leave and Remove confirms' deal lines, and the streak rewards' save toast. Numbers and dates come
// only from the domain's dealLengthText, periodLabel, positionText and startPhrase, so the app and the pushes say
// the same thing. Times read through `when` (deadlineText on the space's zone).
import {
  agreeBy,
  dealClock,
  dealDebtLines,
  dealLengthText,
  dealLineSettled,
  dealPairTerms,
  dealState,
  firstPeriodAfter,
  lastPlayedDeal,
  periodLabel,
  positionText,
  startPhrase,
  weekDealPeriod,
  DEAL_NEWS_DAYS,
} from '../../domain/deals.ts'
import type { DealClock, DealDebtLine, DealState } from '../../domain/deals.ts'
import { spaceJudges } from '../../domain/scoring.ts'
import { computeWeek } from '../../domain/scoring.ts'
import { addMonths } from '../../domain/time.ts'
import type { Deal, DealPeriod, DealUnit, DealsView, MonthId, Space, UID, Week, WeekData, WeekId } from '../../domain/types.ts'
import { formatScore, monthName, shortDate } from '../components/format.ts'
import { debtLineSubtitle, debtLineText, canSettleLine } from '../components/month.ts'
import { listNames } from '../components/people.ts'
import { deadlineText, deviceHourCycle, deviceZone } from '../components/zone.ts'
import { groupedText, shortWho } from './stakes.ts'
import type { StakesRow } from './stakes.ts'

const DAY = 86_400_000

export type Name = (uid: UID) => string
/** A moment in words on the space's clock: "Sunday at midnight" (deadlineText). */
export type When = (ms: number) => string

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * A moment for a deal's copy ("if Kim agrees by Sunday at midnight"): deadlineText (§9.2), with the date named once
 * it is more than a week and a half away ("by Sunday, Nov 29 at midnight"), where "next Sunday" would mislead.
 */
export function dealWhen(ms: number, tz: string, nowMs: number, device: string = deviceZone(), hourCycle = deviceHourCycle()): string {
  const text = deadlineText(ms, tz, nowMs, device, hourCycle)
  if (ms - nowMs < 11 * DAY || !text.startsWith('next ')) return text
  const midnight = /at midnight$/.test(text)
  const date = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: tz }).format(midnight ? ms - 1 : ms).replace(/[\u202f\u00a0]/g, ' ')
  return text.replace(/^next (\w+)/, (_, day: string) => `${day}, ${date}`)
}

/** "Lena’s" */
export function possessive(name: string): string {
  return `${name}’s`
}

/** "4 weeks at 90%+" */
export function dealTitle(deal: Pick<Deal, 'unit' | 'count'>, threshold: number): string {
  return `${dealLengthText(deal.unit, deal.count)} at ${threshold}%+`
}

/** "Sam", "Sam and Kim", then "3 friends": who, on one short line. */
export function who(uids: UID[], name: Name): string {
  return shortWho(uids.map(name))
}

/** Names with "you" last: "Sam and you", "you". */
export function withYou(uids: UID[], me: UID, name: Name): string {
  const others = uids.filter((u) => u !== me)
  const names = others.length > 2 ? [`${others.length} friends`] : others.map(name)
  return listNames(uids.includes(me) ? [...names, 'you'] : names)
}

/** "Sam agrees" / "Sam and Kim agree". */
function agrees(uids: UID[], name: Name): string {
  return `${who(uids, name)} ${uids.length === 1 ? 'agrees' : 'agree'}`
}

/** "Nov 28": a moment's date on the space's clock. */
export function zoneDate(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: tz }).format(ms).replace(/[\u202f\u00a0]/g, ' ')
  } catch {
    return shortDate(ms)
  }
}

/** "84%" (floored, as every score). */
export function pct(score: number | null | undefined): string {
  return formatScore(score ?? 0)
}

/** "1 week" / "2 weeks" added. */
function added(unit: DealUnit, n: number): string {
  return `${n} ${unit}${n === 1 ? '' : 's'} added`
}

/** "a missed review" / "2 missed reviews". */
function missedReviews(n: number): string {
  return n === 1 ? 'a missed review' : `${n} missed reviews`
}

// ---------- The deal's clock and state on screen ----------

/** The clock of a deal's unit, from the week docs the screen has (this week's and next week's). */
export function clockOf(space: Space, unit: DealUnit, weeks?: Array<Week | null | undefined>): DealClock {
  const known: Record<WeekId, Week> = {}
  for (const w of weeks ?? []) if (w) known[w.id] = w
  return dealClock(space, unit, { weeks: known })
}

/**
 * A deal's state as the screens show it (SPEC §12.6): dealState with the stored track, plus, for a weeks deal whose
 * pending period is the week the screen has loaded (its deadline passed, the job hasn't confirmed it yet), that week's
 * own result (weekDealPeriod), so a miss or the last pass reads as provisional at once.
 */
export function dealNow(deal: Deal, space: Space, nowMs: number, weeks?: Array<Week | null | undefined>, live?: WeekData | null): DealState {
  const clock = clockOf(space, deal.unit, weeks)
  const state = dealState(deal, space, nowMs, clock)
  if (deal.unit !== 'week' || !live || state.pending !== live.weekId) return state
  const period = weekDealPeriod(space, deal.uid, live, nowMs)
  return period ? dealState(deal, space, nowMs, clock, [period]) : state
}

/** The week's own score behind a deal score (the deal score plus the missed reviews' points, from the loaded week
 *  when it's that week). */
export function weekOwnScore(entry: DealPeriod, space: Pick<Space, 'latePenalty'>, live?: { data: WeekData; score: number | null } | null): number | null {
  if (entry.score === null) return null
  if (live && live.data.weekId === entry.id && live.score !== null) return live.score
  return Math.min(100, entry.score + space.latePenalty * (entry.missed ?? 0))
}

/** The week's own score from a loaded week (for weekOwnScore). */
export function liveScore(space: Space, uid: UID, data: WeekData | null | undefined, nowMs: number): { data: WeekData; score: number | null } | null {
  if (!data) return null
  return { data, score: computeWeek(data, space, nowMs).members[uid]?.score ?? null }
}

/** Is `me` in the deal right now: its person, or a friend still to agree (waiting), or a party (once agreed). */
export function inDeal(deal: Deal, state: DealState, me: UID): boolean {
  if (deal.uid === me) return true
  if (state.phase === 'waiting') return state.needed.includes(me)
  return state.parties.includes(me)
}

/** The deal is in play and everyone agreed: scheduled or running, with no end the job confirmed. */
export function isOn(state: DealState): boolean {
  return state.phase === 'scheduled' || state.phase === 'running'
}

// ---------- Lines shared by the card, the Stakes screen and a deal's screen ----------

/** The short status: "Waiting for Sam and Kim", "Starts next week", "Week 2 of 4 · all 90%+ so far". */
export function statusLine(deal: Deal, state: DealState, ctx: { me: UID; nowMs: number; tz: string; threshold: number; name: Name }): string {
  if (state.phase === 'waiting') return state.needed.length === 0 ? 'Nobody left to agree' : `Waiting for ${withYou(state.waitingFor, ctx.me, ctx.name)}`
  if (state.phase === 'scheduled') return `Starts ${startPhrase(deal.unit, state.start ?? '', ctx.nowMs, ctx.tz)}`
  if (state.phase === 'running') return runningLine(deal, state, ctx.threshold)
  return endedTitle(deal, state, ctx.me, ctx.name, ctx.threshold)
}

/** "Week 2 of 4 · all 90%+ so far" (no pass yet: "Week 1 of 4 · every week needs 90%+"), with " · 1 week added". */
export function runningLine(deal: Pick<Deal, 'unit' | 'count'>, state: Pick<DealState, 'passes' | 'skips' | 'position'> & Partial<Pick<DealState, 'end' | 'provisional'>>, threshold: number): string {
  const position = positionText(deal.unit, state.position, deal.count)
  // A miss the job hasn't confirmed yet: the note under it says so, so no "all 90%+ so far" beside it.
  if (state.provisional && state.end?.outcome === 'lost') return [position, state.skips > 0 ? added(deal.unit, state.skips) : null].filter(Boolean).join(' · ')
  const progress = state.passes === 0 ? `every ${deal.unit} needs ${threshold}%+` : `all ${threshold}%+ so far`
  return [position, progress, state.skips > 0 ? added(deal.unit, state.skips) : null].filter(Boolean).join(' · ')
}

/** Whose deal a line is about: "your" for yours, else the person's first name. */
interface Whose {
  mine: boolean
  /** The person's first name (for a friend's deal). */
  name: string
}

function theDeal(w: Whose): string {
  return w.mine ? 'your deal' : `${possessive(w.name)} deal`
}

/**
 * The note under a deal in play (at most one, SPEC §12.10): a result coming in, results running late, a
 * provisional end (a miss, with both numbers when missed reviews made them differ; a judged period; the last pass;
 * everyone called it off), or a Call Off waiting.
 */
export function dealNote(
  deal: Deal,
  state: DealState,
  ctx: { me: UID; threshold: number; latePenalty: number; name: Name; own?: (entry: DealPeriod) => number | null },
): { text: string; action?: 'take-a-look' } | null {
  const mine = deal.uid === ctx.me
  const w: Whose = { mine, name: ctx.name(deal.uid) }
  if (state.late) return { text: 'Deal results are running late. They’ll catch up.' }
  if (state.pending) return { text: `Results for ${periodLabel(deal.unit, state.pending)} come in within a few hours.` }
  const end = state.provisional ? state.end : null
  if (end?.outcome === 'lost') {
    const entry = state.track.find((e) => e.id === end.period)
    const label = periodLabel(deal.unit, end.period ?? '')
    const ends = `ends ${theDeal(w)} once it’s confirmed, within a few hours.`
    if (entry?.why === 'judge') return { text: `${mine ? 'You' : w.name} judged ${label}, so it counts as a miss. That ${ends}` }
    if (entry?.why === 'left') return { text: `${mine ? 'You weren’t' : `${w.name} wasn’t`} in ${label}, so it counts as a miss. That ${ends}` }
    const score = end.score ?? entry?.score ?? 0
    const missed = entry?.missed ?? 0
    if (missed > 0 && entry) {
      const own = ctx.own?.(entry) ?? Math.min(100, score + ctx.latePenalty * missed)
      return {
        text: `${cap(label)} was ${pct(score)} for ${theDeal(w)}: ${pct(own)}, minus ${ctx.latePenalty * missed} for ${missedReviews(missed)}. That’s under ${ctx.threshold}%, so it ${ends}`,
      }
    }
    return { text: `${cap(label)} was ${pct(score)}, under ${ctx.threshold}%. That ${ends}` }
  }
  if (end?.outcome === 'won') return { text: `That’s ${dealLengthText(deal.unit, deal.count)} at ${ctx.threshold}%+. It’s confirmed within a few hours.` }
  if (end?.outcome === 'off') {
    return { text: end.reason === 'alone' ? 'Everyone in it left, so nothing’s owed. It’s confirmed within a few hours.' : 'Everyone called it off. It’s confirmed within a few hours.' }
  }
  const { asked, waitingFor } = state.callOff
  if (asked.length === 0) return null
  if (asked.includes(ctx.me)) return { text: `You asked to call it off. Waiting for ${who(waitingFor, ctx.name)}.` }
  const askers = asked.map(ctx.name)
  return { text: `${shortWho(askers)} asked to call it off. It’s off once everyone taps Call Off.`, action: 'take-a-look' }
}

/** Your deal's headline once it's over (and Past Deals' reading of it). */
export function endedTitle(deal: Deal, state: DealState, me: UID, name: Name, threshold: number): string {
  const end = deal.ended ?? state.end
  const mine = deal.uid === me
  if (!end) return ''
  if (end.outcome === 'won') return mine ? `You made it: ${dealTitle(deal, threshold)}` : `${name(deal.uid)} made it: ${dealTitle(deal, threshold)}`
  if (end.outcome === 'off') return mine ? 'Your deal is off' : `${possessive(name(deal.uid))} deal is off`
  if (end.outcome === 'withdrawn') return 'Withdrawn'
  const prefix = mine ? 'Your deal ended' : `${possessive(name(deal.uid))} deal ended`
  return `${prefix}: ${lostReason(deal, state, mine ? 'you' : name(deal.uid))}`
}

/** "84% in the week of Nov 16", ", after a missed review", "you judged …", "you left during it". */
export function lostReason(deal: Deal, state: Pick<DealState, 'track'>, subject: string): string {
  const end = deal.ended ?? null
  const period = end?.period ?? ''
  const entry = state.track.find((e) => e.id === period) ?? deal.track?.find((e) => e.id === period)
  const label = periodLabel(deal.unit, period)
  if (entry?.why === 'judge') return `${subject} judged ${label}`
  if (entry?.why === 'left') return `${subject} left during it`
  const score = end?.score ?? entry?.score ?? 0
  const missed = entry?.missed ?? 0
  return `${pct(score)} in ${label}${missed > 0 ? `, after ${missedReviews(missed)}` : ''}`
}

// ---------- Terms as rows ----------

/** The parties a deal's lines are with right now: its parties once agreed, else the friends still in the space. */
export function lineFriends(state: DealState): UID[] {
  return state.phase === 'waiting' || state.phase === 'withdrawn' ? state.needed : state.parties
}

/** One line's text for the card's rows: the shared text, or grouped per friend ("Sam and Kim: Lunch · Ana: Coffee"). */
export function lineText(deal: Deal, line: 'reward' | 'penalty', friends: UID[], name: Name): string {
  const mode = line === 'reward' ? deal.rewardMode : deal.penaltyMode
  if (mode === 'group') return deal[line]
  const entries = friends.flatMap((f): Array<[UID, string]> => (deal.per[f]?.[line] ? [[f, deal.per[f][line]]] : []))
  return groupedText(entries, name) || 'Different per friend'
}

/** Your deal's rows: "Make it, they owe you" · the reward; "Miss one, you owe them" · the penalty. */
export function ownDealRows(deal: Deal, state: DealState, name: Name): StakesRow[] {
  const friends = lineFriends(state)
  return [
    { icon: 'trophy', label: 'Make it, they owe you', text: lineText(deal, 'reward', friends, name) },
    { icon: 'flame', label: 'Miss one, you owe them', text: lineText(deal, 'penalty', friends, name) },
  ]
}

/** A friend's deal as it applies to you: "Lena makes it, you owe" · "Dinner, with everyone" / "Lunch". */
export function friendDealRows(deal: Deal, me: UID, subject: string): StakesRow[] {
  const t = dealPairTerms(deal, me)
  const alone = deal.friends.filter((f) => f !== me).length === 0
  const reward = !t ? 'Not set for you' : t.rewardTogether && !alone ? `${t.reward}, with everyone` : t.reward
  const penalty = !t ? 'Not set for you' : t.penaltyTogether && !alone ? `${t.penalty}, shared with everyone` : t.penalty
  return [
    { icon: 'trophy', label: `${subject} makes it, you owe`, text: reward },
    { icon: 'flame', label: `${subject} misses one, you get`, text: penalty },
  ]
}

/** Friends’ Deals' second line: "If Lena makes it, you owe: Dinner, with everyone · If not, you get: A coffee". */
export function atStakeLine(deal: Deal, me: UID, subject: string): string | null {
  const [reward, penalty] = friendDealRows(deal, me, subject)
  return `If ${subject} makes it, you owe: ${reward.text} · If not, you get: ${penalty.text}`
}

// ---------- The Space screen's stakes card ----------

export interface CardButton {
  kind: 'make' | 'new' | 'same-again' | 'invite'
  label: string
}

export interface CardBlock {
  kind: 'alone' | 'judge' | 'none' | 'no-friends' | 'unavailable' | 'waiting' | 'scheduled' | 'running' | 'won' | 'lost' | 'off'
  title: string
  text: string
  note?: { text: string; action?: 'take-a-look' } | null
  rows?: StakesRow[]
  /** Waiting: everyone it waits on or agreed, the agreed ones full. */
  avatars?: Array<{ uid: UID; agreed: boolean }>
  buttons: CardButton[]
  /** Under Same Again: "Last time: 4 weeks · Dinner, on them". */
  caption?: string
  deal?: Deal
  state?: DealState
}

export type CardNews =
  /** Friends' deals wait on your Agree: "New deal from Lena" · Take a Look. */
  | { kind: 'agree'; text: string; uids: UID[]; dealId: string }
  /** Someone in a deal you're in asked to call it off: "Sam wants to call off Lena’s deal" · Take a Look. */
  | { kind: 'call-off'; text: string; uid: UID; dealId: string }
  /** A friend's deal you're in ended lately: "Lena made it: you owe Dinner, on us" (dismissable). */
  | { kind: 'ended'; text: string; uid: UID; dealId: string; seenKey: string }

export interface DealCardInput {
  space: Space
  me: UID
  nowMs: number
  /** undefined while the deals load or after they failed (the card then shows "Nothing at stake" without buttons). */
  deals: DealsView | undefined
  name: Name
  when: When
  /** This week's and next week's stored docs (the clock), and this week's data (its result, once its deadline passed). */
  weeks?: Array<Week | null | undefined>
  live?: WeekData | null
  /** You judge this week (its snapshot) or have Only Rate Friends on. */
  judging: boolean
  /** The October window's month (oldStakesMonth), or null. */
  oldMonth: MonthId | null
  /** Whether this device dismissed a notice (`dealSeen.…`). */
  seen?: (key: string) => boolean
}

const MAKE: CardButton = { kind: 'make', label: 'Make a Deal' }
const NEW: CardButton = { kind: 'new', label: 'New Deal' }
const SAME: CardButton = { kind: 'same-again', label: 'Same Again' }

/** "Make a deal: what you get for hitting 90%, what you owe if you miss, and for how long." */
export function makeDealText(threshold: number): string {
  return `Make a deal: what you get for hitting ${threshold}%, what you owe if you miss, and for how long.`
}

/** "Last time: 4 weeks · Dinner, on them" (per friend: "Different per friend"). */
export function lastTimeText(last: Deal): string {
  return `Last time: ${dealLengthText(last.unit, last.count)} · ${last.rewardMode === 'group' ? last.reward : 'Different per friend'}`
}

/** "From November, stakes don’t renew on their own." for the October window's month. */
function fromNext(oldMonth: MonthId): string {
  return `From ${monthName(addMonths(oldMonth, 1))}, stakes don’t renew on their own.`
}

/** A deal ended (won, lost, off) less than DEAL_NEWS_DAYS ago. */
function recent(deal: Deal, nowMs: number): boolean {
  return !!deal.ended && nowMs - deal.ended.at < DEAL_NEWS_DAYS * DAY
}

/** Every debt line of a won or lost deal is settled. */
export function allSettled(deal: Deal, state: DealState): boolean {
  const lines = dealDebtLines(deal, state.parties)
  return lines.length > 0 && lines.every((l) => dealLineSettled(deal, l).settled)
}

/**
 * Your block on the stakes card (SPEC §12.10), the first that applies: alone; judging with no deal in play; no deal
 * in play (and none ended in the last 7 days); waiting; scheduled; running; won; lost; off.
 */
export function dealCard(input: DealCardInput): CardBlock {
  const { space, me, nowMs, deals, oldMonth } = input
  const t = space.threshold
  const others = space.memberIds.filter((id) => id !== me)
  if (others.length === 0) return { kind: 'alone', title: 'Nothing at stake', text: 'Stakes need witnesses. Invite at least one friend.', buttons: [{ kind: 'invite', label: 'Invite' }] }
  const own = deals?.open[me]
  const noneTitle = oldMonth ? `Nothing at stake after ${monthName(oldMonth)}` : 'Nothing at stake'
  const noneText = oldMonth ? `${fromNext(oldMonth)} ${makeDealText(t)}` : makeDealText(t)
  if (!deals) return { kind: 'unavailable', title: noneTitle, text: noneText, buttons: [] }
  if (!own && input.judging) {
    return { kind: 'judge', title: noneTitle, text: 'You’re judging, so nothing’s at stake. Turn off Only Rate Friends to make a deal.', buttons: [] }
  }
  if (own) return liveBlock(own, input)

  const last = lastPlayedDeal(deals.ended, me)
  const ended = deals.ended.filter((d) => d.uid === me && recent(d, nowMs)).sort((a, b) => b.seq - a.seq)[0]
  const same = last ? [SAME] : []
  if (ended && ended.ended) {
    const state = dealNow(ended, space, nowMs, input.weeks)
    return endedBlock(ended, state, input, same)
  }
  const playing = others.filter((id) => !spaceJudges(space).includes(id))
  if (playing.length === 0) return { kind: 'no-friends', title: noneTitle, text: 'Deals need a friend who plays. Invite one first.', buttons: [{ kind: 'invite', label: 'Invite' }] }
  return { kind: 'none', title: noneTitle, text: noneText, buttons: [MAKE, ...same], caption: last ? lastTimeText(last) : undefined }
}

function liveBlock(deal: Deal, input: DealCardInput): CardBlock {
  const { space, me, nowMs, name, when } = input
  const t = space.threshold
  const state = dealNow(deal, space, nowMs, input.weeks, input.live)
  const rows = ownDealRows(deal, state, name)
  const length = dealLengthText(deal.unit, deal.count)
  const clock = clockOf(space, deal.unit, input.weeks)
  const base = { deal, state, rows, buttons: [] as CardButton[] }
  if (state.phase === 'waiting') {
    const avatars = state.needed.map((uid) => ({ uid, agreed: typeof deal.agreed[uid] === 'number' }))
    if (state.needed.length === 0) return { ...base, kind: 'waiting', title: 'Your deal: nobody left to agree', text: 'Withdraw it and make a new one.', avatars }
    const start = state.start ?? firstPeriodAfter(space, deal.unit, nowMs, clock)
    const ask = state.waitingFor.length === 1 ? `${name(state.waitingFor[0])} agrees` : 'they agree'
    return {
      ...base,
      kind: 'waiting',
      title: `Your deal: waiting for ${who(state.waitingFor, name)}`,
      text: `${length} at ${t}%+. Starts ${startPhrase(deal.unit, start, nowMs, space.timezone)} if ${ask} by ${when(agreeBy(start, clock))}.`,
      avatars,
    }
  }
  const note = dealNote(deal, state, { me, threshold: t, latePenalty: space.latePenalty, name, own: (e) => weekOwnScore(e, space, liveScore(space, me, input.live, nowMs)) })
  if (state.phase === 'scheduled') {
    const start = state.start ?? ''
    const counts = deal.unit === 'week' ? `It counts from ${when(clock.lockOf(start))}.` : `It counts from ${possessive(monthName(start))} first lists.`
    return { ...base, kind: 'scheduled', title: `Your deal starts ${startPhrase(deal.unit, start, nowMs, space.timezone)}`, text: `${length} at ${t}%+ each. ${counts}`, note }
  }
  return { ...base, kind: 'running', title: 'Your deal', text: runningLine(deal, state, t), note }
}

function endedBlock(deal: Deal, state: DealState, input: DealCardInput, same: CardButton[]): CardBlock {
  const { me, name, space } = input
  const end = deal.ended
  const buttons = [...same, NEW]
  const base = { deal, state, buttons }
  const parties = state.parties
  const settled = allSettled(deal, state)
  if (end?.outcome === 'won') {
    const text = settled
      ? 'All settled'
      : deal.rewardMode === 'group'
        ? `${who(parties, name)} ${parties.length === 1 ? 'owes' : 'owe'} you: ${deal.reward}`
        : `Collect from ${who(parties, name)}`
    return { ...base, kind: 'won', title: endedTitle(deal, state, me, name, space.threshold), text }
  }
  if (end?.outcome === 'lost') {
    const text = settled ? 'All settled' : deal.penaltyMode === 'group' ? `You owe ${who(parties, name)}: ${deal.penalty}` : `Pay up to ${who(parties, name)}`
    return { ...base, kind: 'lost', title: endedTitle(deal, state, me, name, space.threshold), text }
  }
  return {
    ...base,
    kind: 'off',
    title: 'Your deal is off',
    text: end?.reason === 'alone' ? 'Everyone in it left, so nothing’s owed.' : 'Everyone called it off, so nothing’s owed.',
    buttons: [NEW, ...same],
  }
}

/** The key that remembers a dismissed deal news line on this device. */
export function dealSeenKey(spaceId: string, dealId: string): string {
  return `dealSeen.${spaceId}.${dealId}`
}

/**
 * The card's news line (SPEC §12.10), the first that applies: friends' deals waiting on your Agree; someone asking
 * to call off a friend's deal you're in; a friend's deal you're in that ended in the last 7 days (dismissable).
 */
export function dealNews(input: DealCardInput): CardNews | null {
  const { space, me, nowMs, deals, name } = input
  if (!deals) return null
  const friendsOpen = Object.values(deals.open)
    .filter((d) => d.uid !== me && space.memberIds.includes(d.uid))
    .sort((a, b) => space.memberIds.indexOf(a.uid) - space.memberIds.indexOf(b.uid))
  const states = friendsOpen.map((d) => ({ deal: d, state: dealNow(d, space, nowMs, input.weeks) }))
  const asking = states.filter(({ state }) => state.phase === 'waiting' && state.waitingFor.includes(me))
  if (asking.length > 0) {
    const uids = asking.map((s) => s.deal.uid)
    return { kind: 'agree', text: `New deal from ${who(uids, name)}`, uids, dealId: asking[0].deal.id }
  }
  const off = states.find(({ state }) => isOn(state) && !state.provisional && state.callOff.asked.length > 0 && state.callOff.waitingFor.includes(me))
  if (off) {
    const askers = off.state.callOff.asked
    const verb = askers.length === 1 ? 'wants' : 'want'
    return { kind: 'call-off', text: `${who(askers, name)} ${verb} to call off ${possessive(name(off.deal.uid))} deal`, uid: off.deal.uid, dealId: off.deal.id }
  }
  const ended = deals.ended
    .filter((d) => d.uid !== me && recent(d, nowMs) && !(input.seen?.(dealSeenKey(space.id, d.id)) ?? false))
    .map((d) => ({ deal: d, state: dealNow(d, space, nowMs, input.weeks) }))
    .filter(({ state }) => state.parties.includes(me))
    .sort((a, b) => (b.deal.ended?.at ?? 0) - (a.deal.ended?.at ?? 0))[0]
  if (!ended) return null
  return { kind: 'ended', text: endedNewsText(ended.deal, ended.state, me, name), uid: ended.deal.uid, dealId: ended.deal.id, seenKey: dealSeenKey(space.id, ended.deal.id) }
}

/** "Lena made it: you owe Dinner, on us" / "Lena’s deal ended: Lena owes you Coffee for a week" / "Lena’s deal is off". */
export function endedNewsText(deal: Deal, state: DealState, me: UID, name: Name): string {
  const subject = name(deal.uid)
  const terms = dealPairTerms(deal, me)
  const end = deal.ended
  if (end?.outcome === 'won') return `${subject} made it: you owe ${terms?.reward ?? deal.reward}`
  if (end?.outcome === 'lost') {
    const entry = state.track.find((e) => e.id === end.period) ?? deal.track?.find((e) => e.id === end.period)
    const owes = `${subject} owes you ${terms?.penalty ?? deal.penalty}`
    return entry?.why === 'left' ? `${subject} left, so ${possessive(subject)} deal ended: ${owes}` : `${possessive(subject)} deal ended: ${owes}`
  }
  return `${possessive(subject)} deal is off`
}

/** The October window under your block: "October’s stakes" and, with a deal in play, that both count. */
export function octoberHeader(oldMonth: MonthId): string {
  return `${possessive(monthName(oldMonth))} stakes`
}

export function octoberAlsoLine(oldMonth: MonthId): string {
  const month = monthName(oldMonth)
  return `${possessive(month)} stakes count too, for ${month}.`
}

// ---------- The Stakes screen ----------

/** Your Deal's footer when you have none. */
export function yourDealFooter(threshold: number): string {
  return `Pick what friends owe you if every week (or month) hits ${threshold}%, what you owe if one doesn’t, and for how long. It starts once everyone agrees.`
}

export const JUDGE_NO_DEAL = 'You’re judging, so there’s no deal to make. Turn off Only Rate Friends to play.'
export const NO_FRIENDS = 'Deals need a friend who plays. Invite one first.'

/** "Leaving Film Club while your deal is on counts as a miss: you’d owe your penalty." */
export function leavingFooter(spaceName: string): string {
  return `Leaving ${spaceName} while your deal is on counts as a miss: you’d owe your penalty.`
}

/** October’s section footer on the Stakes screen. */
export function octoberFooter(oldMonth: MonthId): string {
  const month = monthName(oldMonth)
  return `These count for ${month}, as agreed by now. From ${monthName(addMonths(oldMonth, 1))} nothing renews on its own: make a deal.`
}

/** Waiting on You's footer for a friend's deal: who it still waits for, or who asked to call it off. */
export function waitingOnYouFooter(deal: Deal, state: DealState, me: UID, name: Name, nowMs: number, tz: string): string {
  if (state.phase === 'waiting') {
    const others = state.waitingFor.filter((u) => u !== me)
    if (others.length === 0) return `Starts ${startPhrase(deal.unit, state.start ?? '', nowMs, tz)} once you agree.`
    return `Waiting for ${withYou(state.waitingFor, me, name)}.`
  }
  return `${shortWho(state.callOff.asked.map(name))} asked to call it off. It’s off once everyone taps Call Off.`
}

/** To Settle's footer. */
export const SETTLE_FOOTER =
  'Nothing is paid in the app. Settle up in real life, then whoever was owed marks it Settled. Deals that ended over 60 days ago are in Past Deals.'

/** House Stakes' footer on the Stakes screen. */
export function houseStakesFooter(ownerName: string, isOwner: boolean, oldMonth: MonthId | null): string {
  if (oldMonth) {
    const month = monthName(oldMonth)
    return `${possessive(month)} house stakes are set. They count for ${month}, as agreed.`
  }
  return isOwner ? 'New deals start from these. Change them in Settings.' : `New deals start from these. Only ${ownerName} can change them.`
}

/** The streak rewards' footer: the rule, then your streak. */
export function streakFooter(threshold: number, streak: number | null | undefined): string {
  const rule = `Hit ${threshold}% this many months in a row and your friends owe you this too, together, deal or not. A month you sit out doesn’t break a streak.`
  return typeof streak === 'number' && streak >= 2 ? `${rule} Your streak: ${streak} months in a row.` : rule
}

/** A friend's streak rewards you can't agree to (an old per-friend line without your text). */
export function streakMissingText(subject: string): string {
  return `${subject} hasn’t set streak rewards with you yet. They count for you once ${subject} saves them again.`
}

/** The streak rewards' Agree confirm. */
export function streakAgreeConfirm(subject: string, tiers: Array<{ months: number; reward: string }>): { title: string; lines: string[] } {
  return {
    title: `Agree to ${possessive(subject)} streak rewards?`,
    lines: tiers.map((t) => `${t.months} months in a row: you all owe “${t.reward}”, together.`),
  }
}

/** The streak rewards' save toast message: when they count. */
export function streakSaveMessage(waiting: string[]): string {
  return waiting.length === 0 ? 'Counts now.' : `Counts as soon as ${shortWho(waiting)} ${waiting.length === 1 ? 'agrees' : 'agree'}.`
}

// ---------- Settling ----------

export interface SettleRow {
  deal: Deal
  line: DealDebtLine
  title: string
  subtitle: string
  settled: boolean
  canSettle: boolean
}

/** A deal's debt lines that involve `me` (as debtor or creditor), with their words (SPEC §12.10, To Settle). */
export function settleRows(deal: Deal, state: DealState, ctx: { me: UID; memberIds: UID[]; name: Name; all?: boolean }): SettleRow[] {
  const { me, memberIds, name } = ctx
  const whose = deal.uid === me ? 'Your deal' : `${possessive(name(deal.uid))} deal`
  return dealDebtLines(deal, state.parties)
    .filter((line) => ctx.all || line.debtors.includes(me) || line.creditors.includes(me))
    .map((line) => {
      const s = dealLineSettled(deal, line)
      const mark = s.last ? { settledBy: s.last.by, settledAt: s.last.at } : undefined
      const sub = debtLineSubtitle(line, { settled: s.settled, last: mark }, me, memberIds, name)
      return {
        deal,
        line,
        title: debtLineText(line, me, name),
        subtitle: [`${whose}, ${dealLengthText(deal.unit, deal.count)}`, sub].filter(Boolean).join(' · '),
        settled: s.settled,
        canSettle: canSettleLine(line, me, memberIds),
      }
    })
}

/** Unsettled lines first, then by when the deal ended (newest first). */
export function sortSettleRows(rows: SettleRow[]): SettleRow[] {
  return [...rows].sort((a, b) => Number(a.settled) - Number(b.settled) || (b.deal.ended?.at ?? 0) - (a.deal.ended?.at ?? 0))
}

// ---------- A deal's screen ----------

export interface PeriodRowModel {
  id: string
  title: string
  detail: string
  glyph: 'pass' | 'miss' | null
  state: 'done' | 'current' | 'pending' | 'upcoming'
}

/** "Week of Nov 2" / "November". */
export function periodTitle(unit: DealUnit, id: string): string {
  return unit === 'week' ? cap(periodLabel('week', id).replace(/^the /, '')) : monthName(id)
}

/** A finished period's detail: "93%", "Paused · a week added", "Judge · counts as a miss", "87% · 92%, 1 missed review". */
export function periodDetail(unit: DealUnit, entry: DealPeriod, own: number | null): string {
  const more = `a ${unit} added`
  if (entry.result === 'skip') {
    if (entry.why === 'paused') return `Paused · ${more}`
    if (entry.why === 'excused') return `Skipped · ${more}`
    if (entry.why === 'missing') return `Nobody played · ${more}`
    return `No score · ${more}`
  }
  if (entry.why === 'judge') return 'Judge · counts as a miss'
  if (entry.why === 'left') return 'Left · counts as a miss'
  if (entry.why === 'empty') return 'Nothing planned · 0%'
  if ((entry.missed ?? 0) > 0 && own !== null) return `${pct(entry.score)} · ${pct(own)}, ${entry.missed} missed review${entry.missed === 1 ? '' : 's'}`
  return pct(entry.score)
}

/**
 * The deal's periods, one row each (SPEC §12.10): the finished ones from `start` with their result, then the one in
 * progress ("In progress", or "Checking…" once its final time passed without a result), then the ones still to come.
 * Before the start, nothing (the screen says when it starts).
 */
export function periodRows(deal: Deal, state: DealState, own: (entry: DealPeriod) => number | null): PeriodRowModel[] {
  if (state.start === null || state.phase === 'waiting' || state.phase === 'scheduled' || state.phase === 'withdrawn') return []
  const rows: PeriodRowModel[] = state.track.map((e) => ({
    id: e.id,
    title: periodTitle(deal.unit, e.id),
    detail: periodDetail(deal.unit, e, own(e)),
    glyph: e.result === 'pass' ? 'pass' : e.result === 'miss' ? 'miss' : null,
    state: 'done',
  }))
  if (state.end || deal.ended) return rows
  let left = deal.count - state.passes
  let p = state.current
  if (p) {
    rows.push({ id: p, title: periodTitle(deal.unit, p), detail: state.pending === p ? 'Checking…' : 'In progress', glyph: null, state: state.pending === p ? 'pending' : 'current' })
    left -= 1
  }
  let next = p ?? state.start
  for (let i = 0; i < left; i++) {
    next = nextPeriodOf(deal.unit, next)
    rows.push({ id: next, title: periodTitle(deal.unit, next), detail: '', glyph: null, state: 'upcoming' })
  }
  return rows
}

function nextPeriodOf(unit: DealUnit, id: string): string {
  if (unit === 'month') return addMonths(id, 1)
  const [y, m, d] = id.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + 7))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

/** A friend's place in a waiting deal: "Agreed", "Waiting" or "Left". */
export function friendAgreement(deal: Deal, friend: UID, memberIds: UID[]): 'Agreed' | 'Waiting' | 'Left' {
  if (!memberIds.includes(friend)) return 'Left'
  return typeof deal.agreed[friend] === 'number' ? 'Agreed' : 'Waiting'
}

/** The footer under a deal's screen, by its state. */
export function dealFooter(deal: Deal, state: DealState, ctx: { me: UID; nowMs: number; tz: string; threshold: number; latePenalty: number; name: Name; when: When; clock: DealClock; canSameAgain: boolean }): string {
  const { me, nowMs, tz, threshold, name } = ctx
  const mine = deal.uid === me
  const subject = name(deal.uid)
  const unit = deal.unit
  if (deal.ended) {
    const ended = `Ended ${zoneDate(deal.ended.at, tz)}.`
    return mine && ctx.canSameAgain ? `${ended} Same Again proposes it with today’s friends.` : ended
  }
  if (state.phase === 'waiting') {
    if (state.needed.length === 0) return 'Everyone it was with has left. Withdraw it and make a new one.'
    const start = state.start ?? ''
    const waiting = state.waitingFor.length === 1 ? `${name(state.waitingFor[0])} agrees` : `${who(state.waitingFor, name)} agree`
    return `Starts ${startPhrase(unit, start, nowMs, tz)} if ${waiting} by ${ctx.when(agreeBy(start, ctx.clock))}. Friends see it on their stakes card.`
  }
  if (state.phase === 'scheduled') {
    const owes = mine ? 'you owe your penalty' : `${subject} owes the penalty`
    return `Starts ${startPhrase(unit, state.start ?? '', nowMs, tz)}. Every ${unit} needs ${threshold}%; the first one under ends it and ${owes}. Leaving the space counts as a miss too.`
  }
  if (unit === 'week') {
    return mine
      ? `Every week needs ${threshold}%, minus ${ctx.latePenalty} for each friend you don’t review that week. A paused or skipped week adds one more; a week you judge or aren’t in counts as a miss.`
      : `Every week needs ${threshold}%, minus ${ctx.latePenalty} for each friend ${subject} doesn’t review that week. A paused or skipped week adds one more; a week ${subject} judges or isn’t in counts as a miss.`
  }
  return mine
    ? `Every month needs ${threshold}%. A month with no score, like one that was all paused, adds one more. A month you only judge, or leave during, counts as a miss.`
    : `Every month needs ${threshold}%. A month with no score, like one that was all paused, adds one more. A month ${subject} only judges, or leaves during, counts as a miss.`
}

// ---------- The editor ----------

/** The editor's "How long?" footer: the rule, then when it would start. */
export function editorLengthFooter(unit: DealUnit, threshold: number, start: string, agreeByText: string, nowMs: number, tz: string): string {
  const rule =
    unit === 'week'
      ? `Every week has to reach ${threshold}%. Your first week under ends the deal.`
      : `Every month has to reach ${threshold}%. Your first month under ends the deal.`
  const when =
    unit === 'week'
      ? ` It starts ${startPhrase(unit, start, nowMs, tz)} if everyone agrees by ${agreeByText}.`
      : ` It starts ${startPhrase(unit, start, nowMs, tz)} if everyone agrees by ${agreeByText}: a deal starts with the first lists that lock at least a day after everyone agreed.`
  return rule + when
}

export const EDITOR_FOOTER = 'Friends have to tap Agree. Nothing’s at stake until they all do.'

/** Same Again with texts missing for newcomers: "Add what Kim owes you." / "Add what you owe Kim." */
export function missingTextsLine(missing: UID[], rewardEach: boolean, penaltyEach: boolean, name: Name): string | null {
  if (missing.length === 0) return null
  const names = listNames(missing.map(name))
  const parts: string[] = []
  if (rewardEach) parts.push(`Add what ${names} ${missing.length === 1 ? 'owes' : 'owe'} you.`)
  if (penaltyEach) parts.push(`Add what you owe ${names}.`)
  return parts.join(' ') || null
}

/** The propose toast: "Deal proposed" · "Waiting for Sam and Kim to agree." (Edit: "Deal updated"). */
export function proposedToast(friends: UID[], name: Name, edit: boolean): { title: string; message: string } {
  if (edit) return { title: 'Deal updated', message: 'Friends have to agree again.' }
  return { title: 'Deal proposed', message: `Waiting for ${who(friends, name)} to agree.` }
}

// ---------- Confirms ----------

/** Same Again's confirm. */
export function sameAgainConfirm(last: Pick<Deal, 'unit' | 'count' | 'rewardMode' | 'penaltyMode' | 'reward' | 'penalty'>, threshold: number): { title: string; message: string } {
  const make = last.rewardMode === 'group' ? `Make it: ${last.reward}.` : 'Make it: what each friend owed you last time.'
  const miss = last.penaltyMode === 'group' ? `Miss one: ${last.penalty}.` : 'Miss one: what you owed each friend last time.'
  return { title: 'Same deal again?', message: `${dealLengthText(last.unit, last.count)} at ${threshold}%+ each. ${make} ${miss} Friends have to agree again.` }
}

/** The Agree confirm on a friend's deal, and the toast after it. */
export function agreeDealConfirm(deal: Deal, state: DealState, me: UID, name: Name, threshold: number, nowMs: number, tz: string, clock: DealClock): { title: string; lines: string[]; toast: { title: string; message: string } } {
  const subject = name(deal.uid)
  const t = dealPairTerms(deal, me)
  const lines = [`${dealLengthText(deal.unit, deal.count)}, each at ${threshold}%+.`]
  if (t) {
    lines.push(t.rewardTogether ? `If ${subject} makes it: you all owe “${t.reward}”, together.` : `If ${subject} makes it: you owe “${t.reward}”.`)
    lines.push(t.penaltyTogether ? `If ${subject} misses one: the group gets “${t.penalty}”.` : `If ${subject} misses one: you get “${t.penalty}”.`)
  }
  const others = state.waitingFor.filter((u) => u !== me)
  // After your Agree, as the last one: it starts with the first period whose lists lock a day from now.
  const start = others.length === 0 ? firstPeriodAfter({ timezone: tz }, deal.unit, nowMs, clock) : (state.start ?? '')
  const phrase = startPhrase(deal.unit, start, nowMs, tz)
  lines.push(others.length > 0 ? `It starts ${phrase} once ${agrees(others, name)} too.` : `It starts ${phrase}.`)
  return {
    title: `Agree to ${possessive(subject)} deal?`,
    lines,
    toast: { title: `You agreed to ${possessive(subject)} deal`, message: others.length > 0 ? `It starts once ${agrees(others, name)} too.` : `It starts ${phrase}.` },
  }
}

export const WITHDRAW_CONFIRM = {
  title: 'Withdraw your deal?',
  message: 'Friends won’t be asked anymore, and nothing’s at stake until you make a new one.',
  confirmLabel: 'Withdraw',
  cancelLabel: 'Keep It',
}

/** Call Off's confirm (yours or a friend's) and the toast after the tap. */
export function callOffConfirm(deal: Deal, state: DealState, me: UID, name: Name): { title: string; message: string; toast: { title: string; message: string } } {
  const others = state.callOff.waitingFor.filter((u) => u !== me)
  const last = others.length === 0
  const toast = last ? { title: 'Deal called off', message: 'It’s confirmed within a few hours.' } : { title: 'Asked to call it off', message: `It’s off once ${agrees(others, name)}.` }
  if (deal.uid === me) {
    const them = others.length === 0 ? 'everyone' : who(others, name)
    const verb = others.length === 1 ? 'calls' : 'call'
    return { title: 'Call off your deal?', message: `It ends only if ${them} ${verb} it off too. Then nothing’s owed. You can’t take this back.`, toast }
  }
  return { title: `Call off ${possessive(name(deal.uid))} deal?`, message: 'It ends only if everyone in it calls it off. Then nothing’s owed.', toast }
}

// ---------- Settings: the confirms' deal lines ----------

/** The Leave Space confirm's deal line: an agreed deal is lost by leaving; a waiting one is withdrawn. */
export function leaveDealLine(deal: Deal | undefined, state: DealState | null, name: Name): string | null {
  if (!deal || !state) return null
  if (state.phase === 'waiting') return 'Your deal waiting for agreement is withdrawn.'
  if (isOn(state)) return `Your deal is on. Leaving counts as a miss: you’d owe ${listNames(state.parties.map(name))} your penalty.`
  return null
}

/** The owner's Remove confirm: removing someone mid-deal counts as a miss for it. */
export function removeDealLine(deal: Deal | undefined, state: DealState | null, name: Name): string | null {
  if (!deal || !state || !isOn(state)) return null
  const subject = name(deal.uid)
  return `${possessive(subject)} deal is on. Removing ${subject} counts as a miss for it, so ${subject} would owe the penalty.`
}

/** The judge switch's confirm: with a deal on, judged weeks (or months) count as a miss. */
export function judgeDealLine(deal: Deal | undefined, state: DealState | null): string | null {
  if (!deal || !state || !isOn(state)) return null
  return deal.unit === 'week' ? 'Your deal is running: weeks you judge count as a miss.' : 'Your deal is running: a month you only judge counts as a miss.'
}

// ---------- Past Deals ----------

/** "Nov 2" for a deal's first Monday (a month's first week's Monday). */
function startDay(deal: Deal, start: string): string {
  if (deal.unit === 'week') return periodLabel('week', start).replace(/^the week of /, '')
  const [y, m] = start.split('-').map(Number)
  // The month's first week: the Monday of the week holding its first Friday.
  for (let d = 1; d <= 7; d++) {
    const t = new Date(Date.UTC(y, m - 1, d))
    if (t.getUTCDay() === 5) {
      const monday = new Date(Date.UTC(y, m - 1, d - 4))
      return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(monday).replace(/[  ]/g, ' ')
    }
  }
  return ''
}

/** Past Deals' row: "4 weeks · Made it" · "Nov 2 – Nov 28 · Dinner, on us". */
export function historyRow(deal: Deal, state: DealState, threshold: number, tz: string): { title: string; subtitle: string } {
  const length = dealLengthText(deal.unit, deal.count)
  const end = deal.ended
  if (!end) {
    if (state.phase === 'waiting') return { title: `${length} · Waiting for agreement`, subtitle: `At ${threshold}%+ each` }
    if (state.phase === 'scheduled') return { title: `${length} · Starts ${state.start ? periodTitle(deal.unit, state.start) : 'soon'}`, subtitle: 'Everyone agreed' }
    return { title: `${length} · ${positionText(deal.unit, state.position, deal.count)}`, subtitle: state.passes > 0 ? `All ${threshold}%+ so far` : `Every ${deal.unit} needs ${threshold}%+` }
  }
  if (end.outcome === 'won') {
    const range = state.start ? `${startDay(deal, state.start)} – ${zoneDate(end.at, tz)}` : zoneDate(end.at, tz)
    return { title: `${length} · Made it`, subtitle: `${range} · ${deal.rewardMode === 'group' ? deal.reward : 'Different per friend'}` }
  }
  if (end.outcome === 'lost') {
    const passes = state.track.filter((e) => e.result === 'pass').length
    const entry = state.track.find((e) => e.id === end.period)
    const label = periodLabel(deal.unit, end.period ?? '')
    const what = entry?.why === 'judge' ? `Judged ${label}` : entry?.why === 'left' ? 'Left the space' : `${pct(end.score)} in ${label}`
    return { title: `${length} · Ended in ${deal.unit} ${passes + 1}`, subtitle: `${what} · ${deal.penaltyMode === 'group' ? deal.penalty : 'Different per friend'}` }
  }
  if (end.outcome === 'off') {
    return end.reason === 'alone' ? { title: `${length} · Off`, subtitle: 'Everyone else left' } : { title: `${length} · Called off`, subtitle: `Ended ${zoneDate(end.at, tz)}` }
  }
  return { title: `${length} · Withdrawn`, subtitle: '' }
}

// ---------- The Spaces card and the month view, from dealsFrom ----------

export const DEALS_FOOTNOTE = 'Deals are settled on the Stakes screen.'

// ---------- Names ----------

/** Everyone a set of deals names: their people and their friends. */
export function dealPeople(deals: Deal[]): UID[] {
  return [...new Set(deals.flatMap((d) => [d.uid, ...d.friends]))]
}

/** First names for deals: a member without a profile yet is "Someone", anyone else without one (a deleted
 *  account) "A former member". */
export function dealNamer(profiles: Record<UID, { name?: string } | undefined>, memberIds: UID[]): Name {
  return (uid) => {
    const full = profiles[uid]?.name?.trim()
    if (full) return full.split(/\s+/)[0]
    return memberIds.includes(uid) ? 'Someone' : 'A former member'
  }
}

// ---------- Streak rewards (SPEC §9.8, edited on their own from the cutover) ----------

type Tier = { months: number; reward: string }

export function sameTierList(a: Tier[], b: Tier[]): boolean {
  return a.length === b.length && a.every((t, i) => t.months === b[i].months && t.reward === b[i].reward)
}

/** A friend's place on your streak rewards: they agreed to exactly these, or not yet. */
export function streakStatus(own: { tiers: Tier[]; agreed: Record<UID, { terms: { tiers: Tier[] } }> }, friend: UID): 'Agreed' | 'Waiting' {
  const agreed = own.agreed[friend]?.terms.tiers
  return agreed && sameTierList(agreed, own.tiers) ? 'Agreed' : 'Waiting'
}

/** A friend's streak rewards differ from what you agreed to (their new ones wait on your Agree). */
export function streaksWaitOnMe(theirs: { tiers: Tier[]; agreed: Record<UID, { terms: { tiers: Tier[] } }> } | undefined, me: UID): boolean {
  if (!theirs) return false
  return !sameTierList(theirs.tiers, theirs.agreed[me]?.terms.tiers ?? [])
}

/** The friends who still have to agree to `tiers` (their agreement holds other tiers). */
export function streakWaiting(own: { agreed: Record<UID, { terms: { tiers: Tier[] } }> } | undefined, tiers: Tier[], friends: UID[]): UID[] {
  return friends.filter((f) => !sameTierList(own?.agreed[f]?.terms.tiers ?? [], tiers))
}
