// The two batch-3 deep links (SPEC §11.2, §11.6), read once at startup and removed from the address bar, like
// ?join= and ?space=:
//   ?friend=CODE   a friend link: opens the Friends tab and Add Friend on that code. Before sign-in it waits in
//                  this tab's session storage (`pendingFriend`), so it survives creating an account or signing in.
//   ?goal=<id>     the check-in push: opens the Friends tab and pushes that shared goal.
// Anything that isn't a friend code (normalizeFriendCode) or a goal id (isGoalId) is dropped.
import { FRIEND_PARAM, GOAL_PARAM, normalizeFriendCode } from '../../domain/friends.ts'
import { isGoalId } from '../../domain/shared.ts'
import { readSession, writeSession } from '../components/storage.ts'

const KEY = 'pendingFriend'

let friend: string | null = null
let goal: string | null = null
let captured = false

/** What the two params carry, validated: a friend code (normalised) and a goal id, else null. Pure. */
export function parseFriendParams(search: string): { friend: string | null; goal: string | null } {
  const params = new URLSearchParams(search)
  const code = params.get(FRIEND_PARAM)
  const id = params.get(GOAL_PARAM)
  return { friend: code === null ? null : normalizeFriendCode(code), goal: id !== null && isGoalId(id) ? id : null }
}

/** Reads ?friend= and ?goal= once and removes both from the URL (other params like ?now= stay). */
export function captureFriendParams(): void {
  if (captured || typeof window === 'undefined') return
  captured = true
  const url = new URL(window.location.href)
  const hasFriend = url.searchParams.has(FRIEND_PARAM)
  const hasGoal = url.searchParams.has(GOAL_PARAM)
  const parsed = parseFriendParams(url.search)
  if (hasFriend) {
    friend = parsed.friend
    writeSession(KEY, friend)
  } else {
    // A reload before sign-in finished: keep the code from this tab's session.
    friend = normalizeFriendCode(readSession(KEY) ?? '')
  }
  goal = parsed.goal
  if (!hasFriend && !hasGoal) return
  url.searchParams.delete(FRIEND_PARAM)
  url.searchParams.delete(GOAL_PARAM)
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

/** A friend link is waiting (the Welcome screen mentions it; the app opens on Friends). */
export function hasPendingFriend(): boolean {
  return friend !== null
}

/** The pending friend code, cleared so Add Friend opens on it only once. */
export function takePendingFriend(): string | null {
  const code = friend
  friend = null
  writeSession(KEY, null)
  return code
}

/** A check-in push is waiting to open its goal. */
export function hasGoalTarget(): boolean {
  return goal !== null
}

/** The goal to open, cleared so it opens only once. */
export function takeGoalTarget(): string | null {
  const id = goal
  goal = null
  return id
}
