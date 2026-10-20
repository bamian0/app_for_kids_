// Friends by friend request (batch 3, SPEC §11.3, §11.6, §11.7). Pure.
//
// One doc per pair, friends/{a_b} with a < b, so either side finds it with one get. Its state machine:
//   (none) → asked                       the asker's request (askFriend)
//   asked → friends                      the other person accepts
//   asked → declined                     the other person declines: silent, the asker still sees "Requested"
//   asked | declined → withdrawn         the asker cancels: a tombstone, so asking again waits ASK_AGAIN_DAYS
//   withdrawn → asked                    the asker again, after ASK_AGAIN_DAYS; or the other person any time
//                                        (taking it over: `by` becomes them)
//   declined → friends                   the person who declined changes their mind (the request still stands)
//   friends → (deleted)                  either side removes the friendship; either can ask again at once
import { hasCodeParam, normalizeCodeParam } from './ids.ts'
import { openInvites } from './shared.ts'
import type { FriendRelation, Friendship, FriendsView, SharedGoalsView, UID } from './types.ts'

/** The query parameter of a friend link: `?friend=CODE`. */
export const FRIEND_PARAM = 'friend'
/** The query parameter the check-in push opens: `?goal=<goalId>`. */
export const GOAL_PARAM = 'goal'
/** A canceled request waits this long before its asker can ask the same person again. */
export const ASK_AGAIN_DAYS = 30

const DAY = 86_400_000
const PAIR_UID = /^[A-Za-z0-9]{1,128}$/

/** The pair's doc id: the two uids in string order, joined with `_` (uids have none). The same from either side. */
export function pairId(a: UID, b: UID): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`
}

/** The two uids of a pair id, in order; null for anything that isn't one (unsorted, the same uid twice, bad uids). */
export function pairUsers(id: string): [UID, UID] | null {
  const parts = typeof id === 'string' ? id.split('_') : []
  if (parts.length !== 2) return null
  const [a, b] = parts
  return PAIR_UID.test(a) && PAIR_UID.test(b) && a < b ? [a, b] : null
}

function newestFirst(a: Friendship, b: Friendship): number {
  return b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/**
 * Your pairs, split for the Friends screen: friends; incoming (they asked, still pending: a request you declined is
 * hidden from you); sent (you asked, pending or silently declined: both read "Requested"); withdrawn (your canceled
 * requests: listed nowhere, kept for askAgainAt). A pair the other person withdrew is hidden. Newest first.
 */
export function friendsView(pairs: Friendship[], me: UID): FriendsView {
  const view: FriendsView = { friends: [], incoming: [], sent: [], withdrawn: [] }
  const seen = new Set<UID>()
  for (const pair of [...pairs].sort(newestFirst)) {
    if (pair.uid === me || seen.has(pair.uid)) continue
    seen.add(pair.uid)
    const mine = pair.by === me
    if (pair.state === 'friends') view.friends.push(pair)
    else if (pair.state === 'asked' && !mine) view.incoming.push(pair)
    else if ((pair.state === 'asked' || pair.state === 'declined') && mine) view.sent.push(pair)
    else if (pair.state === 'withdrawn' && mine) view.withdrawn.push(pair)
  }
  return view
}

/** How `uid` relates to you. Your withdrawn pair reads 'none' (see askAgainAt); one they declined or withdrew too. */
export function relationOf(view: FriendsView, me: UID, uid: UID): FriendRelation {
  if (uid === me) return 'me'
  if (view.friends.some((p) => p.uid === uid)) return 'friend'
  if (view.incoming.some((p) => p.uid === uid)) return 'incoming'
  if (view.sent.some((p) => p.uid === uid)) return 'sent'
  return 'none'
}

/**
 * When you can ask `uid` again after canceling your request: its `at` + ASK_AGAIN_DAYS, while that hasn't passed
 * (the rules need the server's time to be after it); else null (ask away).
 */
export function askAgainAt(view: FriendsView, uid: UID, nowMs: number): number | null {
  const pair = view.withdrawn.find((p) => p.uid === uid)
  if (!pair) return null
  const at = pair.at + ASK_AGAIN_DAYS * DAY
  return nowMs <= at ? at : null
}

/** The text carries a space invite (`join=`), e.g. a space link pasted into Add Friend. */
export function isSpaceInviteLink(input: string): boolean {
  return hasCodeParam(input, 'join')
}

/**
 * A friend code from what was typed or pasted: the code with or without its dash or spaces, any case, or a link
 * carrying `friend=`. null for anything else, a space invite link (`join=`) included.
 */
export function normalizeFriendCode(input: string): string | null {
  if (!hasCodeParam(input, FRIEND_PARAM) && isSpaceInviteLink(input)) return null
  return normalizeCodeParam(input, FRIEND_PARAM)
}

/** The Friends tab's badge: incoming requests + open shared-goal invitations (not to finished or ended goals). */
export function friendsBadge(view: FriendsView | undefined, shared: SharedGoalsView | undefined, nowMs: number): number {
  return (view?.incoming.length ?? 0) + (shared ? openInvites(shared, nowMs).length : 0)
}
