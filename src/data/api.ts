// Data layer API used by the screens. Signatures are the contract (docs/SPEC.md §2).
// Writes live in sibling modules; this file holds the React hooks and re-exports everything.
import { useEffect, useSyncExternalStore } from 'react'
import { now } from '../domain/clock.ts'
import { weekBounds, weekIdsInMonth } from '../domain/time.ts'
import type { MonthId, Settlement, Space, UID, UserProfile, WeekData, WeekId } from '../domain/types.ts'
import { mergeProfiles, startProfile } from './auth.ts'
import { authState, startAuth } from './session.ts'
import { startSettlements } from './settlements.ts'
import { startMySpaces, startSpace } from './spaces.ts'
import { combine, useLive } from './store.ts'
import { joinWeek, mergeWeeks, startWeek, weekKey } from './weeks.ts'

export interface Live<T> {
  data: T | undefined
  loading: boolean
  error: Error | null
}

// ---------- Auth & profile ----------

export interface AuthState {
  status: 'loading' | 'signedOut' | 'signedIn'
  uid: UID | null
  email: string | null
  /** null while loading or if the profile doc is missing. */
  profile: UserProfile | null
}

function subscribeAuth(onChange: () => void): () => void {
  startAuth()
  return authState.subscribe(onChange)
}

export function useAuth(): AuthState {
  return useSyncExternalStore(subscribeAuth, authState.get, authState.get)
}

// Errors from these are thrown as `Error` with a human-readable message.
export { signUp, signIn, sendPasswordReset, signOut, updateMyName, deleteMyAccount } from './auth.ts'

// ---------- Spaces ----------

export function useMySpaces(): Live<Space[]> {
  const { uid } = useAuth()
  return useLive(uid ? `${uid}|spaces` : null, (emit) => startMySpaces(uid as UID)(emit))
}

export function useSpace(spaceId: string): Live<Space | null> {
  const { uid } = useAuth()
  return useLive(uid && spaceId ? `${uid}|space|${spaceId}` : null, (emit) => startSpace(spaceId)(emit))
}

const NO_PROFILES: Record<UID, UserProfile> = Object.freeze({}) as Record<UID, UserProfile>

/** Live profiles for the given uids; missing ones are simply absent from the record. */
export function useProfiles(uids: UID[]): Record<UID, UserProfile> {
  const { uid: me } = useAuth()
  const ids = [...new Set(uids)].sort()
  const key = me && ids.length > 0 ? `${me}|profiles|${ids.join(',')}` : null
  const live = useLive<Record<UID, UserProfile>>(key, (emit) =>
    combine(
      ids.map((uid) => ({ key: `${me}|profile|${uid}`, start: startProfile(uid) })),
      mergeProfiles,
    )(emit),
  )
  return live.data ?? NO_PROFILES
}

export { createSpace, lookupInvite, joinSpace, leaveSpace, updateSpace, inviteLink } from './spaces.ts'

// ---------- Weeks ----------

/** Live data for one week. While the week is still before lockAt it also creates the week doc
 *  or adds the current user to `members` (so opening a week = taking part in it). */
export function useWeek(space: Space, weekId: WeekId): Live<WeekData> {
  const { uid } = useAuth()
  const isMember = uid !== null && space.memberIds.includes(uid)
  useEffect(() => {
    if (!isMember) return
    try {
      if (now() >= weekBounds(weekId, space.timezone).lockAt) return
    } catch {
      return
    }
    // Best effort: a failure here only means the user isn't in the week yet; savePlan retries.
    joinWeek(space, weekId).catch(() => {})
    // `space` is only read for id, timezone and membership, which the deps cover.
  }, [uid, isMember, space.id, space.timezone, weekId])
  return useLive(uid ? weekKey(uid, space.id, weekId) : null, (emit) => startWeek(space.id, weekId, uid as UID)(emit))
}

export { savePlan, setTaskDone, submitReviews, joinWeek } from './weeks.ts'

// ---------- Months ----------

/** Live WeekData for every week of the month (weekIdsInMonth). Does not create week docs. */
export function useMonth(space: Space, monthId: MonthId): Live<WeekData[]> {
  const { uid } = useAuth()
  return useLive(uid ? `${uid}|month|${space.id}|${monthId}` : null, (emit) =>
    combine(
      weekIdsInMonth(monthId).map((weekId) => ({ key: weekKey(uid as UID, space.id, weekId), start: startWeek(space.id, weekId, uid as UID) })),
      mergeWeeks,
    )(emit),
  )
}

export function useSettlements(spaceId: string): Live<Settlement[]> {
  const { uid } = useAuth()
  return useLive(uid && spaceId ? `${uid}|settlements|${spaceId}` : null, (emit) => startSettlements(spaceId)(emit))
}

export { setSettled } from './settlements.ts'
