// The Friends tab's wording (SPEC §11.9.1–§11.9.4), kept pure so Node tests it. Dates read on the device's
// calendar (`tz`, the device's zone by default): "{when}" is "today", "yesterday" or "Oct 18" (with the year once
// it isn't this year), "{Mon d}" is "Oct 18" likewise, "{Month d}" is "October 12".
import { ASK_AGAIN_DAYS } from '../../domain/friends.ts'
import type { AskResult, FriendsView, ShowKey, Space, UID, UserProfile } from '../../domain/types.ts'
import { firstName } from '../components/people.ts'
import { deviceZone } from '../components/zone.ts'

const DAY = 86_400_000

const formats = new Map<string, Intl.DateTimeFormat>()
function format(tz: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${tz}|${JSON.stringify(options)}`
  let f = formats.get(key)
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { ...options, timeZone: tz })
    } catch {
      f = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' })
    }
    formats.set(key, f)
  }
  return f
}

/** The calendar day of `ms` on `tz`'s clock, as a UTC midnight (so days subtract cleanly). */
function dayOf(ms: number, tz: string): number {
  const parts = format(tz, { year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(ms)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return Date.UTC(get('year'), get('month') - 1, get('day'))
}

function yearOf(ms: number, tz: string): number {
  return new Date(dayOf(ms, tz)).getUTCFullYear()
}

/** "Oct 18", or "Oct 18, 2025" when it isn't this year. */
export function shortDay(ms: number, nowMs: number, tz: string = deviceZone()): string {
  const sameYear = yearOf(ms, tz) === yearOf(nowMs, tz)
  return format(tz, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }).format(ms)
}

/** "October 12", or "October 12, 2025" when it isn't this year. */
export function longDay(ms: number, nowMs: number, tz: string = deviceZone()): string {
  const sameYear = yearOf(ms, tz) === yearOf(nowMs, tz)
  return format(tz, sameYear ? { month: 'long', day: 'numeric' } : { month: 'long', day: 'numeric', year: 'numeric' }).format(ms)
}

/** "today", "yesterday" or "Oct 18". */
export function whenText(ms: number, nowMs: number, tz: string = deviceZone()): string {
  const days = Math.round((dayOf(nowMs, tz) - dayOf(ms, tz)) / DAY)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return shortDay(ms, nowMs, tz)
}

/** A request row on the Friends root: "Wants to be friends · today". */
export function requestSubtitle(at: number, nowMs: number, tz?: string): string {
  return `Wants to be friends · ${whenText(at, nowMs, tz)}`
}

/** A sent request: "Requested yesterday". */
export function requestedText(at: number, nowMs: number, tz?: string): string {
  return `Requested ${whenText(at, nowMs, tz)}`
}

/** Your canceled request cooling down: "Ask again Nov 19". */
export function askAgainText(at: number, nowMs: number, tz?: string): string {
  return `Ask again ${shortDay(at, nowMs, tz)}`
}

/** The showcase's relation line. */
export function relationLine(relation: 'me' | 'friend' | 'incoming' | 'sent' | 'none', at: number | null, nowMs: number, tz?: string): string | null {
  if (relation === 'me') return 'Your showcase'
  if (relation === 'incoming') return 'Wants to be friends'
  if (relation === 'friend' && at !== null) return `Friends since ${longDay(at, nowMs, tz)}`
  if (relation === 'sent' && at !== null) return `You asked ${shortDay(at, nowMs, tz)}`
  return null
}

/** "You · 92% · October so far": your own row in Friends. */
export function youLine(ringLine: string): string {
  return `You · ${ringLine}`
}

export const RING_FOOTER = 'Rings show each friend’s score this month so far, across their spaces. They update after each week’s reviews are due.'
export const PEOPLE_FOOTER = 'People you share a space with. Add them to see each other’s rings.'
export const PEOPLE_SHEET_FOOTER = 'People you share a space with.'
export const EMPTY_TITLE = 'Better with friends'

/** The empty Friends tab: with People in Your Spaces, it points at them first. */
export function emptyMessage(withPeople: boolean): string {
  return withPeople
    ? 'Add people from your spaces below, or anyone with your link or code. You’ll see how their month is going, and you can fill shared goals together.'
    : 'Add friends with your link or code. You’ll see how their month is going, and you can fill shared goals together.'
}

/** "In Film Club", "In Film Club and 1 more", "In Film Club and 2 more". */
export function spacesSubtitle(names: string[]): string {
  if (names.length === 0) return ''
  return names.length === 1 ? `In ${names[0]}` : `In ${names[0]} and ${names.length - 1} more`
}

export interface PersonInSpaces {
  uid: UID
  /** Their shared spaces' names, in your spaces' order. */
  spaces: string[]
}

/**
 * People in Your Spaces: current members of your spaces (judges too) who are neither you, your friends, nor in a
 * pending pair with you (incoming or sent), with a profile, by name. Your canceled request (withdrawn) and a
 * request you declined leave them here (Add, or "Ask again" while it cools down).
 */
export function peopleInSpaces(spaces: Space[], me: UID, view: FriendsView, profiles: Record<UID, UserProfile>): PersonInSpaces[] {
  const skip = new Set<UID>([me, ...view.friends.map((p) => p.uid), ...view.incoming.map((p) => p.uid), ...view.sent.map((p) => p.uid)])
  const found = new Map<UID, string[]>()
  for (const space of spaces) {
    for (const uid of space.memberIds) {
      if (skip.has(uid) || !profiles[uid]) continue
      const names = found.get(uid) ?? []
      if (!names.includes(space.name)) names.push(space.name)
      found.set(uid, names)
    }
  }
  const nameOf = (uid: UID) => profiles[uid]?.name?.trim() || ''
  return [...found.entries()]
    .map(([uid, names]) => ({ uid, spaces: names }))
    .sort((a, b) => nameOf(a.uid).localeCompare(nameOf(b.uid)) || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))
}

/** Friends by name ("Ana" before "ben"), for the Friends section. */
export function byName<T extends { uid: UID }>(list: T[], profiles: Record<UID, UserProfile>): T[] {
  const nameOf = (uid: UID) => profiles[uid]?.name?.trim() || ''
  return [...list].sort((a, b) => nameOf(a.uid).localeCompare(nameOf(b.uid)) || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))
}

export interface Confirm {
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
}

/** Cancel a sent request (Sent, and the showcase's Cancel Request). */
export function cancelConfirm(name: string): Confirm {
  return {
    title: 'Cancel your request?',
    message: `${firstName(name)} won’t see it anymore. You can ask again in ${ASK_AGAIN_DAYS} days.`,
    confirmLabel: 'Cancel Request',
    cancelLabel: 'Keep',
  }
}

/** Remove Friend, on their showcase. */
export function removeConfirm(name: string): Confirm {
  return {
    title: `Remove ${firstName(name)}?`,
    message: 'You’ll stop seeing each other’s rings. Shared goals you’re both in stay as they are. Either of you can ask again later.',
    confirmLabel: 'Remove',
    cancelLabel: 'Cancel',
  }
}

export const RESET_CONFIRM: Confirm = {
  title: 'Reset your link?',
  message: 'Your old link and code stop working. Requests you already have stay.',
  confirmLabel: 'Reset Link',
  cancelLabel: 'Cancel',
}

export interface ToastCopy {
  title: string
  message?: string
  success?: boolean
}

/** "You and Lena are friends". */
export function friendsToast(name: string): ToastCopy {
  return { title: `You and ${firstName(name)} are friends`, success: true }
}

/** What Add says afterwards (askFriend's result); null when the row's detail says it all ('already-…'). */
export function addResultToast(result: AskResult, name: string, askAgain: number | null, nowMs: number, tz?: string): ToastCopy | null {
  const first = firstName(name)
  if (result === 'asked') return { title: 'Request sent', message: `${first} sees it next time they open Stakes.` }
  if (result === 'friends') return friendsToast(name)
  if (result === 'too-soon') return { title: askAgain === null ? `You can ask ${first} again soon` : `You can ask ${first} again on ${shortDay(askAgain, nowMs, tz)}` }
  return null
}

/** Decline (no confirm): the toast says it stays quiet. */
export function declinedToast(name: string): ToastCopy {
  return { title: 'Request declined', message: `${firstName(name)} won’t be told.` }
}

/** "Lena hasn’t shared anything yet." */
export function nothingSharedText(name: string): string {
  return `${firstName(name)} hasn’t shared anything yet.`
}

/** "Across 2 spaces" under a ring that averages two or more. */
export function acrossSpaces(spaces: number): string | null {
  return spaces >= 2 ? `Across ${spaces} spaces` : null
}

/** Stats footer: "From finished months since October 2026. Weeks played counts this month too." */
export function statsFooter(since: string | null): string {
  const tail = 'Weeks played counts this month too.'
  if (!since || !/^\d{4}-(0[1-9]|1[0-2])$/.test(since)) return tail
  const [year, month] = since.split('-').map(Number)
  const name = format('UTC', { month: 'long', year: 'numeric' }).format(Date.UTC(year, month - 1, 1))
  return `From finished months since ${name}. ${tail}`
}

/** "Updated Oct 3." under the money sections, once the copies are more than 3 days old; else null. */
export function updatedFooter(updatedAt: number, nowMs: number, tz?: string): string | null {
  if (!(updatedAt > 0) || nowMs - updatedAt <= 3 * DAY) return null
  return `Updated ${shortDay(updatedAt, nowMs, tz)}.`
}

/** "Earned in September". */
export function earnedIn(month: string): string {
  return `Earned in ${month}`
}

/** The editor's switches: title and subtitle (`month`: last month's name, "September"). */
export function switchCopy(key: ShowKey, month: string): { title: string; subtitle: string } {
  switch (key) {
    case 'stats':
      return { title: 'Stats', subtitle: 'Months at 90%+, streaks and weeks played' }
    case 'achieved':
      return { title: 'Achieved Goals', subtitle: 'Goals you marked as bought' }
    case 'goals':
      return { title: 'Current Goals', subtitle: 'Names and progress, never amounts' }
    case 'earnings':
      return { title: 'Last Month’s Earnings', subtitle: `What your tasks earned in ${month}` }
  }
}

/** Turning on a money switch asks first; stats never ask (null). */
export function showConfirm(key: ShowKey, month: string): Confirm | null {
  const base = { confirmLabel: 'Show', cancelLabel: 'Cancel' }
  if (key === 'achieved') return { ...base, title: 'Show your achieved goals?', message: 'Anyone on Stakes can see the names of goals you marked as bought, and when.' }
  if (key === 'goals') return { ...base, title: 'Show your goals?', message: 'Anyone on Stakes can see their names and how far along you are, never amounts.' }
  if (key === 'earnings') return { ...base, title: 'Show last month’s earnings?', message: `Anyone on Stakes can see what your tasks earned in ${month}.` }
  return null
}

export const EDITOR_NOTE = 'Anyone signed in to Stakes can see your showcase.'
export const EDITOR_FOOTER = 'Money stays private unless you switch it on here. Your ring is for friends only.'
export const PROFILE_SHOWCASE_FOOTER = 'Choose what anyone on Stakes can see on your profile.'

/** The friend link's share sheet (shareOrCopy). */
export function shareLinkData(url: string): { title: string; text: string; url: string } {
  return { title: 'Add me on Stakes', text: 'Add me as a friend on Stakes:', url }
}
