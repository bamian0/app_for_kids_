// The rows of month stakes (SPEC §9.7, §9.8), pure so they are unit-tested without a DOM. From deals (SPEC §12)
// they show only October's stakes read-only, in the October window (the stakes card's and the Stakes screen's
// rows), plus the streak rewards' rows and helpers; deals have their own words in deals.ts. Every "counts now" row is memberTerms for termsMonth
// with termsFriends of that row's subject and the space's own house stakes (the month whose terms count now is
// never complete, so no freeze binds for it and nothing here reads a months/ doc).
import { judgesOf, spaceJudges } from '../../domain/scoring.ts'
import { boundsFor } from '../../domain/schedule.ts'
import { agreementStatus, inLockedWeek, memberTerms, missingFor, monthLocks, pairTerms, termsFriends, termsMonth, waitingFor } from '../../domain/stakes.ts'
import type { House } from '../../domain/stakes.ts'
import { addMonths, monthIdForWeek, weekIdFor, weekIdsInMonth } from '../../domain/time.ts'
import type { MemberStakes, MonthId, MonthlyList, PairTerms, Space, StreakTier, TermsInForce, UID, Week } from '../../domain/types.ts'
import { monthName } from '../components/format.ts'
import { listNames } from '../components/people.ts'

const DAY = 86_400_000
/** How long a friend's new stakes and a house-stakes change stay news on the card. */
export const NEWS_DAYS = 7

export type StakesDocs = Record<UID, MemberStakes>
type Name = (uid: UID) => string

// ---------- When terms count ----------

/** Where the stakes stand right now: the month whose terms count, and its first lock (for termsFriends). */
export interface TermsNow {
  /** termsMonth: this week's month, or the next one once that month is complete. */
  month: MonthId
  /** This week's month (its Friday's). */
  thisMonth: MonthId
  /** The first lock of `month`: its first week's stored lock when that is this week, else computed. */
  firstLockAt: number
  /** The locks of `month`'s weeks that aren't paused (stored for this week, else computed) and of its list when
   *  known: a friend who left counts only when they were in one of these (inLockedWeek). */
  locks: number[]
  /** Between a month's completion and the next month's first week: changes count from `month`, `thisMonth` is final. */
  window: boolean
}

export function termsNow(space: Space, nowMs: number, thisWeek?: Week | null, monthly?: MonthlyList | null): TermsNow {
  const thisMonth = monthIdForWeek(weekIdFor(nowMs, space.timezone))
  const month = termsMonth(space, nowMs, thisWeek ?? null, monthly ?? null)
  const first = weekIdsInMonth(month)[0]
  const firstLockAt = boundsFor(space, first, thisWeek && thisWeek.id === first ? thisWeek : null).lockAt
  return { month, thisMonth, firstLockAt, locks: monthLocks(space, month, thisWeek, monthly), window: month !== thisMonth }
}

/** The space's house stakes: what counts between two people who haven't agreed on their own, right now. */
export function houseOf(space: Pick<Space, 'reward' | 'penalty'>): House {
  return { reward: space.reward, penalty: space.penalty }
}

/** The friends whose agreement `subject`'s terms wait for right now (termsFriends of the month that counts; a
 *  friend who left counts when they were in one of its weeks, by the space doc). */
export function friendsOf(space: Space, subject: UID, now: TermsNow): UID[] {
  return termsFriends(space, subject, now.firstLockAt, undefined, (uid) => inLockedWeek(space, uid, now.locks))
}

/** What counts right now between `subject` and each of their friends. */
export function termsInForceNow(space: Space, subject: UID, stakes: StakesDocs | undefined, now: TermsNow, extra: UID[] = []): Record<UID, TermsInForce> {
  const friends = [...new Set([...friendsOf(space, subject, now), ...extra])].filter((f) => f !== subject)
  return memberTerms(space, subject, friends, stakes, houseOf(space), Infinity)
}

/** Where `me` stands on `subject`'s current stakes right now: agreementStatus with what counts now, so a change back
 *  to terms that already count (everyone had agreed to them) doesn't wait on anyone. */
export function myStatus(space: Space, subject: UID, me: UID, stakes: StakesDocs | undefined, now: TermsNow): 'agreed' | 'waiting' | 'missing' {
  const theirs = stakes?.[subject]
  const status = agreementStatus(theirs, me)
  return status === 'waiting' ? agreementStatus(theirs, me, termsInForceNow(space, subject, stakes, now, [me])) : status
}

/** You judge this week: its snapshot when the doc exists (a locked week keeps its role), else the space's list. */
export function isJudging(space: Space, me: UID, thisWeek?: Week | null): boolean {
  return thisWeek ? judgesOf(thisWeek).includes(me) : spaceJudges(space).includes(me)
}

/** Current members other than `me` who play (not judges), in join order. */
export function playingFriends(space: Space, me: UID): UID[] {
  const judges = spaceJudges(space)
  return space.memberIds
    .filter((uid) => uid !== me && !judges.includes(uid))
    .sort((a, b) => (space.joinedAt[a] ?? 0) - (space.joinedAt[b] ?? 0))
}

// ---------- Names ----------

/** A short list for a one-line status: "Sam", "Sam and Ana", then "3 friends". */
export function shortWho(names: string[]): string {
  return names.length <= 2 ? listNames(names) : `${names.length} friends`
}

// ---------- Grouping texts by friend ----------

/** One text when everyone is on the same; else "Lena and Sam: Dinner · Kim: Coffee", at most 3 groups, then "and 2 more". */
export function groupedText(entries: Array<[UID, string]>, name: Name, maxGroups = 3): string {
  const groups: Array<{ text: string; uids: UID[] }> = []
  for (const [uid, text] of entries) {
    const group = groups.find((g) => g.text === text)
    if (group) group.uids.push(uid)
    else groups.push({ text, uids: [uid] })
  }
  if (groups.length === 0) return ''
  if (groups.length === 1) return groups[0].text
  const shown = groups.slice(0, maxGroups).map((g) => `${listNames(g.uids.map(name))}: ${g.text}`)
  const more = groups.slice(maxGroups).reduce((n, g) => n + g.uids.length, 0)
  return more > 0 ? `${shown.join(' · ')} · and ${more} more` : shown.join(' · ')
}

export interface StakesRow {
  icon: 'trophy' | 'flame' | 'sparkles'
  label: string
  text: string
  /** A small line under the text ("Together with everyone"). */
  note?: string
}

/** Your two rows ("Hit 90%, they owe you" / "Miss, you owe them") from what counts with each friend. */
export function ownRows(terms: Record<UID, TermsInForce>, shown: UID[], house: House, name: Name, threshold = 90): StakesRow[] {
  const friends = shown.filter((f) => terms[f])
  const reward = friends.length > 0 ? groupedText(friends.map((f) => [f, terms[f].reward.text]), name) : house.reward
  const penalty = friends.length > 0 ? groupedText(friends.map((f) => [f, terms[f].penalty.text]), name) : house.penalty
  return [
    { icon: 'trophy', label: `Hit ${threshold}%, they owe you`, text: reward },
    { icon: 'flame', label: 'Miss, you owe them', text: penalty },
  ]
}

/** The streak rewards in force among `shown` (they all come from one agreement, so the first non-empty list). */
export function tiersShown(terms: Record<UID, TermsInForce>, shown: UID[]): StreakTier[] {
  for (const f of shown) if (terms[f]?.tiers.length) return terms[f].tiers
  return []
}

export function tierRows(tiers: StreakTier[]): StakesRow[] {
  return tiers.map((t) => ({ icon: 'sparkles', label: `${t.months} months in a row`, text: t.reward }))
}

/** A pair's current terms in the shape of terms in force, to compare and to show as "New". */
function asInForce(t: PairTerms): TermsInForce {
  return {
    reward: { text: t.reward, together: t.rewardMode === 'group', source: 'agreed' },
    penalty: { text: t.penalty, together: t.penaltyMode === 'group', source: 'agreed' },
    tiers: t.tiers,
  }
}

function sameTierList(a: StreakTier[], b: StreakTier[]): boolean {
  return a.length === b.length && a.every((t, i) => t.months === b[i].months && t.reward === b[i].reward)
}

/** What counts between two people differs from the subject's current terms for that friend. */
export function differsFromCurrent(inForce: TermsInForce | undefined, current: PairTerms | null): boolean {
  if (!current) return false
  if (!inForce) return true
  const t = asInForce(current)
  return (
    inForce.reward.text !== t.reward.text ||
    inForce.reward.together !== t.reward.together ||
    inForce.penalty.text !== t.penalty.text ||
    inForce.penalty.together !== t.penalty.together ||
    !sameTierList(inForce.tiers, t.tiers)
  )
}

/** A friend's terms as they apply to you: "Lena hits 90%, you owe" · "Dinner, with everyone". `alone`: you're their only friend. */
export function friendRows(subject: string, terms: TermsInForce, threshold = 90, alone = false): StakesRow[] {
  const all = (text: string, together: boolean, suffix: string) => (together && !alone ? `${text}, ${suffix}` : text)
  return [
    { icon: 'trophy', label: `${subject} hits ${threshold}%, you owe`, text: all(terms.reward.text, terms.reward.together, 'with everyone') },
    { icon: 'flame', label: `${subject} misses, you get`, text: all(terms.penalty.text, terms.penalty.together, 'shared with everyone') },
    ...terms.tiers.map((t): StakesRow => ({ icon: 'sparkles', label: `${subject}: ${t.months} months in a row, you owe`, text: t.reward, note: alone ? undefined : 'Together with everyone' })),
  ]
}

// ---------- The Space screen's stakes card ----------

export type CardNews =
  /** Friends' stakes wait on your Agree: "New stakes from Lena" · Take a Look (opens on `focus`). */
  | { kind: 'agree'; text: string; uids: UID[]; focus: UID }
  /** A friend changed their stakes lately without needing you: "Lena has new stakes". */
  | { kind: 'friend'; text: string; uid: UID; seenKey: string }
  /** The owner changed the house stakes: "Lena changed the house stakes" · "They count now." */
  | { kind: 'house'; text: string; message: string; seenKey: string }

export type CardPending =
  /** "Your new stakes: waiting for Sam to agree", with an avatar stack. */
  | { kind: 'waiting'; text: string; uids: UID[] }
  /** "Add your stakes for Kim": opens the editor. */
  | { kind: 'missing'; text: string; uids: UID[] }
  /** "Ben left before agreeing, so your shared stakes count from November." */
  | { kind: 'leaver'; text: string; uids: UID[] }
  | { kind: 'agreed'; text: string }
  /** No own stakes: "Same stakes for everyone, for now." with Set Your Own. */
  | { kind: 'house'; text: string }
  | { kind: 'judge'; text: string }

export interface CardInput {
  space: Space
  me: UID
  /** undefined while the stakes listener loads, or after it failed: the card then shows the house rows only. */
  stakes: StakesDocs | undefined
  nowMs: number
  thisWeek?: Week | null
  monthly?: MonthlyList | null
  name: Name
  /** Whether this device dismissed a notice (`stakesSeen.…`, `houseSeen.…`). */
  seen?: (key: string) => boolean
}

/** The stakes docs the screens go by: none while loading or after an error (the house stakes for everyone). */
export function stakesFromLive(live: { data: StakesDocs | undefined; error: Error | null }): StakesDocs | undefined {
  return live.error ? undefined : live.data
}

export interface CardModel {
  rows: StakesRow[]
  news: CardNews | null
  pending: CardPending | null
  alone: boolean
  now: TermsNow
}

/**
 * The stakes card (SPEC §9.7): two rows of what counts for you right now (friends grouped by text), then at most
 * two status lines: news (friends' stakes waiting on you; else a friend's new stakes; else the house-stakes
 * notice) and pending (your new stakes waiting; else a friend without terms from you; else a leaver holding a
 * shared line; else "Everyone agreed" or, without own stakes, "Same stakes for everyone, for now."). It never
 * waits for the stakes docs: without them (`undefined`) everyone is on the house stakes and there are no lines.
 */
export function stakesCard({ space, me, stakes, nowMs, thisWeek, monthly, name, seen = () => false }: CardInput): CardModel {
  const now = termsNow(space, nowMs, thisWeek, monthly)
  const house = houseOf(space)
  const alone = space.memberIds.filter((id) => id !== me).length === 0
  const friends = friendsOf(space, me, now)
  const shown = friends.filter((f) => space.memberIds.includes(f))
  const terms = stakes ? memberTerms(space, me, friends, stakes, house, Infinity) : {}
  const rows = ownRows(terms, stakes ? shown : [], house, name, space.threshold)
  if (alone || stakes === undefined) return { rows, news: null, pending: null, alone, now }

  const judge = isJudging(space, me, thisWeek)
  const judges = spaceJudges(space)
  const subjects = space.memberIds.filter((id) => id !== me && !judges.includes(id))
  const later = now.window ? `They count from ${monthName(now.month)}.` : 'They count now.'

  // News: one line.
  let news: CardNews | null = null
  const waitingOnMe = judge ? [] : subjects.filter((s) => stakes[s] && myStatus(space, s, me, stakes, now) === 'waiting')
  if (waitingOnMe.length > 0) {
    news = { kind: 'agree', text: `New stakes from ${shortWho(waitingOnMe.map(name))}`, uids: waitingOnMe, focus: waitingOnMe[0] }
  } else {
    const fresh = subjects
      .flatMap((s) => (stakes[s] && nowMs - stakes[s].updatedAt < NEWS_DAYS * DAY ? [stakes[s]] : []))
      // Not news once you agreed to them since (your Agree came after the change).
      .filter((s) => !((s.agreed[me]?.at ?? -Infinity) >= s.updatedAt))
      .filter((s) => !seen(`stakesSeen.${space.id}.${s.uid}.${s.updatedAt}`))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (fresh) {
      news = { kind: 'friend', text: `${name(fresh.uid)} has new stakes`, uid: fresh.uid, seenKey: `stakesSeen.${space.id}.${fresh.uid}.${fresh.updatedAt}` }
    } else {
      const note = space.stakesNote
      const joined = space.joinedAt[me]
      const key = note ? `houseSeen.${space.id}.${note.at}` : ''
      if (note && note.by !== me && typeof joined === 'number' && joined < note.at && nowMs - note.at < NEWS_DAYS * DAY && !seen(key)) {
        const at = termsNow(space, note.at, thisWeek, monthly)
        news = { kind: 'house', text: `${name(note.by)} changed the house stakes`, message: at.window ? `They count from ${monthName(at.month)}.` : later, seenKey: key }
      }
    }
  }

  // Pending: one line.
  let pending: CardPending | null = null
  const own = stakes[me]
  if (judge) {
    pending = { kind: 'judge', text: 'You’re judging: nothing’s owed while you only rate.' }
  } else if (!own) {
    pending = { kind: 'house', text: 'Same stakes for everyone, for now.' }
  } else {
    const waiting = waitingFor(own, shown, terms)
    const missing = missingFor(own, shown)
    if (waiting.length > 0) {
      pending = { kind: 'waiting', text: `Your new stakes: waiting for ${shortWho(waiting.map(name))} to agree`, uids: waiting }
    } else if (missing.length > 0) {
      pending = { kind: 'missing', text: `Add your stakes for ${shortWho(missing.map(name))}`, uids: missing }
    } else {
      const leavers = leaversHolding(space, own, friends, terms)
      if (leavers.length > 0) pending = { kind: 'leaver', text: leaverText(leavers.map(name), now.month), uids: leavers }
      else if (!shown.some((f) => differsFromCurrent(terms[f], pairTerms(own, f)))) pending = { kind: 'agreed', text: 'Everyone agreed' }
    }
  }
  return { rows, news, pending, alone, now }
}

/**
 * Friends who left this month without agreeing to your current terms while every current friend has, and a
 * shared line or your streak rewards still don't count because of it.
 */
export function leaversHolding(space: Space, own: MemberStakes, friends: UID[], terms: Record<UID, TermsInForce>): UID[] {
  const current = friends.filter((f) => space.memberIds.includes(f))
  if (current.some((f) => agreementStatus(own, f, terms) === 'waiting')) return []
  const blocked = current.some((f) => differsFromCurrent(terms[f], pairTerms(own, f)))
  if (!blocked) return []
  return friends.filter((f) => !space.memberIds.includes(f) && agreementStatus(own, f, terms) !== 'agreed')
}

/** "Ben left before agreeing, so your shared stakes count from November." */
export function leaverText(names: string[], month: MonthId): string {
  return `${listNames(names)} left before agreeing, so your shared stakes count from ${monthName(addMonths(month, 1))}.`
}

// ---------- Streak rewards ----------

/** "Add Streak Reward" choices: the unused lengths. */
export function unusedTierChoices(choices: readonly number[], tiers: StreakTier[]): number[] {
  return choices.filter((m) => !tiers.some((t) => t.months === m))
}

// ---------- Streaks in the month view ----------

/** The month view's note when streaks aren't known yet for a complete month (from FIRST_RESULTS_MONTH on). */
export function streakNote(known: boolean, complete: boolean, monthId: MonthId, firstResultsMonth: MonthId, completeAt: number, nowMs: number): string | null {
  if (known || !complete || monthId < firstResultsMonth) return null
  return nowMs - completeAt > 3 * DAY ? 'Streaks are running late. They’ll catch up.' : 'Streaks update within a day of the month ending.'
}
