// The words and rows of the stakes screens (SPEC §9.7, §9.8), pure so they are unit-tested without a DOM:
// what the Space screen's stakes card shows, the Stakes screen's sections and footers, the Agree confirm and
// its toast, and the editor's draft and its save toast. Every "counts now" row is memberTerms for termsMonth
// with termsFriends of that row's subject and the space's own house stakes (the month whose terms count now is
// never complete, so no freeze binds for it and nothing here reads a months/ doc).
import { judgesOf, spaceJudges } from '../../domain/scoring.ts'
import { boundsFor } from '../../domain/schedule.ts'
import { agreementStatus, agreeOutcome, memberTerms, missingFor, pairTerms, termsFriends, termsMonth, waitingFor } from '../../domain/stakes.ts'
import type { House } from '../../domain/stakes.ts'
import { addMonths, monthIdForWeek, weekIdFor, weekIdsInMonth } from '../../domain/time.ts'
import type { MemberStakes, MonthId, MonthlyList, PairTerms, Space, StakesMode, StreakTier, TermsInForce, UID, Week } from '../../domain/types.ts'
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
  /** Between a month's completion and the next month's first week: changes count from `month`, `thisMonth` is final. */
  window: boolean
}

export function termsNow(space: Space, nowMs: number, thisWeek?: Week | null, monthly?: MonthlyList | null): TermsNow {
  const thisMonth = monthIdForWeek(weekIdFor(nowMs, space.timezone))
  const month = termsMonth(space, nowMs, thisWeek ?? null, monthly ?? null)
  const first = weekIdsInMonth(month)[0]
  const firstLockAt = boundsFor(space, first, thisWeek && thisWeek.id === first ? thisWeek : null).lockAt
  return { month, thisMonth, firstLockAt, window: month !== thisMonth }
}

/** The space's house stakes: what counts between two people who haven't agreed on their own, right now. */
export function houseOf(space: Pick<Space, 'reward' | 'penalty'>): House {
  return { reward: space.reward, penalty: space.penalty }
}

/** The friends whose agreement `subject`'s terms wait for right now (termsFriends of the month that counts). */
export function friendsOf(space: Space, subject: UID, now: TermsNow): UID[] {
  return termsFriends(space, subject, now.firstLockAt)
}

/** What counts right now between `subject` and each of their friends. */
export function termsInForceNow(space: Space, subject: UID, stakes: StakesDocs | undefined, now: TermsNow, extra: UID[] = []): Record<UID, TermsInForce> {
  const friends = [...new Set([...friendsOf(space, subject, now), ...extra])].filter((f) => f !== subject)
  return memberTerms(space, subject, friends, stakes, houseOf(space), Infinity)
}

/** You judge: this week's snapshot, or the space's list (from the next unlocked week on). */
export function isJudging(space: Space, me: UID, thisWeek?: Week | null): boolean {
  return spaceJudges(space).includes(me) || (!!thisWeek && judgesOf(thisWeek).includes(me))
}

/** Current members other than `me` who play (not judges), in join order. */
export function playingFriends(space: Space, me: UID): UID[] {
  const judges = spaceJudges(space)
  return space.memberIds
    .filter((uid) => uid !== me && !judges.includes(uid))
    .sort((a, b) => (space.joinedAt[a] ?? 0) - (space.joinedAt[b] ?? 0))
}

// ---------- Names ----------

/** "Lena", "Lena and Sam", up to three names, then "4 friends" ("all 4 friends" when that's every friend). */
export function whoPhrase(names: string[], total = Infinity): string {
  if (names.length <= 3) return listNames(names)
  return `${names.length === total ? 'all ' : ''}${names.length} friends`
}

/** A short list for a one-line status: "Sam", "Sam and Ana", then "3 friends". */
export function shortWho(names: string[]): string {
  return names.length <= 2 ? listNames(names) : `${names.length} friends`
}

/** "Lena agrees" / "Lena and Sam agree". */
function agreesPhrase(names: string[], total = Infinity): string {
  return `${whoPhrase(names, total)} ${names.length === 1 ? 'agrees' : 'agree'}`
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

/** Your own current stakes as rows (the "Your new stakes" group): each line for everyone, or grouped per friend. */
export function proposedRows(own: MemberStakes, shown: UID[], name: Name, threshold = 90): StakesRow[] {
  const line = (mode: StakesMode, text: string, key: 'reward' | 'penalty') =>
    mode === 'group' ? text : groupedText(shown.flatMap((f) => (own.per[f]?.[key] ? [[f, own.per[f][key]] as [UID, string]] : [])), name) || 'Not set yet'
  return [
    { icon: 'trophy', label: `Hit ${threshold}%, they owe you`, text: line(own.rewardMode, own.reward, 'reward') },
    { icon: 'flame', label: 'Miss, you owe them', text: line(own.penaltyMode, own.penalty, 'penalty') },
    ...tierRows(own.tiers),
  ]
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

/** A friend's current terms for you as "New" rows. */
export function newFriendRows(subject: string, terms: PairTerms, threshold = 90, alone = false): StakesRow[] {
  return friendRows(subject, asInForce(terms), threshold, alone)
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
  const waitingOnMe = judge ? [] : subjects.filter((s) => stakes[s] && agreementStatus(stakes[s], me) === 'waiting')
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
    const waiting = waitingFor(own, shown)
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
  if (current.some((f) => agreementStatus(own, f) === 'waiting')) return []
  const blocked = current.some((f) => differsFromCurrent(terms[f], pairTerms(own, f)))
  if (!blocked) return []
  return friends.filter((f) => !space.memberIds.includes(f) && agreementStatus(own, f) !== 'agreed')
}

/** "Ben left before agreeing, so your shared stakes count from November." */
export function leaverText(names: string[], month: MonthId): string {
  return `${listNames(names)} left before agreeing, so your shared stakes count from ${monthName(addMonths(month, 1))}.`
}

// ---------- The Stakes screen ----------

/** The footer of "Your stakes": who your new stakes wait for, or that everyone agreed, then your streak. */
export function ownFooter(opts: { waiting: string[]; total: number; leavers: string[]; month: MonthId; allAgreed: boolean; streak?: number | null }): string | null {
  const parts: string[] = []
  if (opts.waiting.length > 0) parts.push(`Your new stakes count as soon as ${agreesPhrase(opts.waiting, opts.total)}.`)
  else if (opts.leavers.length > 0) parts.push(`Everyone here agreed. ${leaverText(opts.leavers, opts.month)}`)
  else if (opts.allAgreed) parts.push('Everyone agreed: they count now.')
  const line = streakLine(opts.streak)
  if (line) parts.push(line)
  return parts.length > 0 ? parts.join(' ') : null
}

/** "Your streak: 3 months in a row." from 2 on. */
export function streakLine(streak: number | null | undefined): string | null {
  return typeof streak === 'number' && streak >= 2 ? `Your streak: ${streak} months in a row.` : null
}

export const NO_OWN_FOOTER = 'Set what you get and what you give, the same for everyone or per friend. They count as soon as your friends tap Agree.'

/** A friend's status row in "Your stakes": "Agreed", "Waiting" (with what counts meanwhile), or missing terms. */
export function friendStatus(own: MemberStakes, friend: UID, inForce?: TermsInForce): { kind: 'agreed' } | { kind: 'waiting'; subtitle: string } | { kind: 'missing' } {
  const status = agreementStatus(own, friend)
  if (status === 'agreed') return { kind: 'agreed' }
  if (status === 'missing') return { kind: 'missing' }
  const earlier = inForce ? inForce.reward.source === 'agreed' || inForce.penalty.source === 'agreed' || inForce.tiers.length > 0 : !!own.agreed[friend]
  return { kind: 'waiting', subtitle: earlier ? 'What they agreed before counts for now' : 'The house stakes count for now' }
}

/** A friend's section footer: "Waiting for Sam and you" / "Waiting for Sam" / "Everyone agreed". */
export function waitingFooter(waiting: UID[], me: UID, name: Name): string {
  if (waiting.length === 0) return 'Everyone agreed'
  const others = waiting.filter((f) => f !== me).map(name)
  const names = waiting.includes(me) ? [...(others.length > 3 ? [`${others.length} friends`] : others), 'you'] : others.length > 3 ? [`${others.length} friends`] : others
  return `Waiting for ${listNames(names)}`
}

/** Friend sections in order: those whose stakes wait on you first, then join order. */
export function friendOrder(space: Space, me: UID, stakes: StakesDocs | undefined, judge: boolean): UID[] {
  const friends = playingFriends(space, me)
  if (judge || !stakes) return friends
  const waits = (f: UID) => (stakes[f] && agreementStatus(stakes[f], me) === 'waiting' ? 0 : 1)
  return [...friends].sort((a, b) => waits(a) - waits(b))
}

export function houseFooter(ownerName: string, isOwner: boolean): string {
  return isOwner
    ? 'These count between two friends until they agree on their own. Change them in Settings.'
    : `These count between two friends until they agree on their own. Only ${ownerName} can change them; changes count right away.`
}

export const JUDGE_NOTE = 'You’re judging, so nothing’s owed either way. Your stakes count again when you play.'

// ---------- Agreeing ----------

export interface AgreeOutcome {
  counts: 'now' | 'partly' | 'later'
  waitingFor: UID[]
}

/** What `me`'s Agree to `subject`'s current terms would do right now. */
export function agreeOutcomeNow(space: Space, subject: UID, me: UID, stakes: StakesDocs | undefined, now: TermsNow, nowMs: number): AgreeOutcome {
  return agreeOutcome(space, subject, me, friendsOf(space, subject, now), stakes, houseOf(space), nowMs)
}

/** The Agree confirm: "Agree to Lena’s stakes?", the lines as they apply to you, then when they count. */
export function agreeConfirm(subject: string, terms: PairTerms, outcome: AgreeOutcome, now: TermsNow, name: Name, threshold = 90): { title: string; lines: string[] } {
  const lines = [
    terms.rewardMode === 'group'
      ? `${subject} hits ${threshold}%: you all owe “${terms.reward}”, together.`
      : `${subject} hits ${threshold}%: you owe “${terms.reward}”.`,
    terms.penaltyMode === 'group' ? `If ${subject} misses, the group gets “${terms.penalty}”.` : `If ${subject} misses, you get “${terms.penalty}”.`,
    ...terms.tiers.map((t) => `${t.months} months in a row: you all owe “${t.reward}”, together.`),
  ]
  lines.push(agreeWhen(outcome, now, name))
  return { title: `Agree to ${subject}’s stakes?`, lines }
}

function waitingNames(outcome: AgreeOutcome, name: Name): string {
  return outcome.waitingFor.length > 0 ? agreesPhrase(outcome.waitingFor.map(name)) : 'everyone agrees'
}

/** When an Agree counts, for the confirm. */
export function agreeWhen(outcome: AgreeOutcome, now: TermsNow, name: Name): string {
  const from = `from ${monthName(now.month)}`
  const who = waitingNames(outcome, name)
  if (outcome.counts === 'now') return now.window ? `They count ${from}. ${monthName(now.thisMonth)} is final.` : 'They count right away.'
  if (outcome.counts === 'later') return now.window ? `They count ${from}, once ${who} too.` : `They count once ${who} too.`
  return now.window ? `Your own part counts ${from}, the shared part once ${who} too.` : `Your own part counts right away, the shared part once ${who} too.`
}

/** The toast after an Agree: "You agreed to Lena’s stakes" · "They count now." */
export function agreeToast(subject: string, outcome: AgreeOutcome, now: TermsNow, name: Name): { title: string; message: string } {
  const from = `from ${monthName(now.month)}`
  const who = waitingNames(outcome, name)
  let message: string
  if (outcome.counts === 'now') message = now.window ? `They count ${from}.` : 'They count now.'
  else if (outcome.counts === 'later') message = now.window ? `They count ${from}, once ${who} too.` : `They count once ${who} too.`
  else message = now.window ? `Part counts ${from}, the rest once ${who}.` : `Part counts now, the rest once ${who}.`
  return { title: `You agreed to ${subject}’s stakes`, message }
}

// ---------- The editor ----------

export interface EditorDraft {
  rewardMode: StakesMode
  penaltyMode: StakesMode
  reward: string
  penalty: string
  per: Record<UID, { reward: string; penalty: string }>
  tiers: StreakTier[]
}

const MAX_TEXT = 120

/** Your doc, else the house stakes on Same for Everyone; a field per friend (empty when new). */
export function draftFrom(own: MemberStakes | undefined, house: House, friends: UID[]): EditorDraft {
  const per: EditorDraft['per'] = {}
  for (const f of friends) per[f] = { reward: own?.per[f]?.reward ?? '', penalty: own?.per[f]?.penalty ?? '' }
  if (!own) return { rewardMode: 'group', penaltyMode: 'group', reward: house.reward, penalty: house.penalty, per, tiers: [] }
  return { rewardMode: own.rewardMode, penaltyMode: own.penaltyMode, reward: own.reward, penalty: own.penalty, per, tiers: own.tiers.map((t) => ({ ...t })) }
}

/** Switching a line's mode prefills its empty fields from the other mode. */
export function switchMode(draft: EditorDraft, line: 'reward' | 'penalty', mode: StakesMode): EditorDraft {
  const key = line === 'reward' ? 'rewardMode' : 'penaltyMode'
  if (draft[key] === mode) return draft
  const next: EditorDraft = { ...draft, [key]: mode, per: { ...draft.per } }
  if (mode === 'each') {
    for (const f of Object.keys(next.per)) if (next.per[f][line].trim() === '') next.per[f] = { ...next.per[f], [line]: draft[line] }
  } else if (draft[line].trim() === '') {
    const first = Object.values(draft.per).find((e) => e[line].trim() !== '')
    if (first) next[line] = first[line]
  }
  return next
}

const blank = (s: string) => s.trim() === ''
const tooLong = (s: string) => s.trim().length > MAX_TEXT

/** Save is allowed: Same-for-everyone lines filled, each playing friend's per-friend fields filled (a judge's may
 *  be left empty, but not half), streak rewards filled with distinct lengths, everything under 120. */
export function draftValid(d: EditorDraft, friends: UID[], judges: UID[]): boolean {
  if ((d.rewardMode === 'group' && blank(d.reward)) || (d.penaltyMode === 'group' && blank(d.penalty))) return false
  if (tooLong(d.reward) || tooLong(d.penalty)) return false
  for (const f of friends) {
    const e = d.per[f] ?? { reward: '', penalty: '' }
    const fields = [d.rewardMode === 'each' ? e.reward : null, d.penaltyMode === 'each' ? e.penalty : null].filter((v): v is string => v !== null)
    if (fields.some(tooLong)) return false
    const empty = fields.filter(blank).length
    if (empty > 0 && !(judges.includes(f) && empty === fields.length)) return false
  }
  if (d.tiers.some((t) => blank(t.reward) || tooLong(t.reward))) return false
  return new Set(d.tiers.map((t) => t.months)).size === d.tiers.length
}

/** What the editor saves: trimmed, per-friend entries only while a line is per friend (a judge left empty is left out), tiers sorted. */
export function draftInput(d: EditorDraft, friends: UID[]): EditorDraft {
  const anyEach = d.rewardMode === 'each' || d.penaltyMode === 'each'
  const per: EditorDraft['per'] = {}
  if (anyEach) {
    for (const f of friends) {
      const e = d.per[f] ?? { reward: '', penalty: '' }
      const reward = d.rewardMode === 'each' ? e.reward.trim() : ''
      const penalty = d.penaltyMode === 'each' ? e.penalty.trim() : ''
      if ((d.rewardMode === 'each' && reward === '') || (d.penaltyMode === 'each' && penalty === '')) continue
      per[f] = { reward, penalty }
    }
  }
  return {
    rewardMode: d.rewardMode,
    penaltyMode: d.penaltyMode,
    reward: d.reward.trim(),
    penalty: d.penalty.trim(),
    per,
    tiers: d.tiers.map((t) => ({ months: t.months, reward: t.reward.trim() })).sort((a, b) => a.months - b.months),
  }
}

/** The draft differs from what is stored (or, with no doc, from the prefill). */
export function draftChanged(d: EditorDraft, initial: EditorDraft, friends: UID[]): boolean {
  return JSON.stringify(draftInput(d, friends)) !== JSON.stringify(draftInput(initial, friends))
}

/** Your stakes as they will read once saved (agreements kept), to tell who has to agree. */
export function stakesAfterSave(me: UID, input: EditorDraft, own: MemberStakes | undefined, nowMs: number): MemberStakes {
  return { uid: me, ...input, agreed: own?.agreed ?? {}, updatedAt: nowMs }
}

/** The save toast's message: when your stakes count ("Counts now.", "Counts as soon as Lena agrees."); none alone. */
export function saveMessage(waiting: string[], total: number, now: TermsNow): string | undefined {
  if (total === 0) return undefined
  if (waiting.length === 0) return now.window ? `Counts from ${monthName(now.month)}. ${monthName(now.thisMonth)} is final.` : 'Counts now.'
  return now.window ? `Counts from ${monthName(now.month)}, as soon as ${agreesPhrase(waiting, total)}.` : `Counts as soon as ${agreesPhrase(waiting, total)}.`
}

export const EDITOR_FOOTER = 'Changes count as soon as your friends agree; a line that’s the same for everyone needs all of them. A month that has ended keeps its stakes.'
export const TIERS_FOOTER = 'Hit 90% this many months in a row and your friends owe you this too, together. A month you sit out doesn’t break a streak.'

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
