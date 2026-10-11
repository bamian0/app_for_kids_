// Data layer API used by the screens. Signatures are the contract (docs/SPEC.md §2).
// Writes live in sibling modules; this file holds the React hooks and re-exports everything.
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { weekIdsInMonth } from '../domain/time.ts'
import type { MonthId, MonthStakes, Settlement, Space, UID, UserProfile, WeekData, WeekId } from '../domain/types.ts'
import { mergeProfiles, startProfile } from './auth.ts'
import { ensureSpace, startMonthStakes } from './months.ts'
import { authState, startAuth } from './session.ts'
import { startSettlements } from './settlements.ts'
import { startMySpaces, startSpace } from './spaces.ts'
import { combine, useLive } from './store.ts'
import { mergeWeeks, startWeek, weekKey } from './weeks.ts'

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

/** Runs ensureSpace for each space when it first loads and when its members change (cheap when nothing to do). */
function useEnsure(spaces: (Space | null | undefined)[]): void {
  const signature = spaces.map((s) => (s ? `${s.id}:${s.memberIds.join(',')}:${s.timezone}` : '')).join('|')
  useEffect(() => {
    for (const space of spaces) if (space) void ensureSpace(space)
    // `signature` covers what ensureSpace reads.
  }, [signature])
}

/** The user's spaces. Opening the app also keeps each space's weeks and stakes up to date (see ensureSpace). */
export function useMySpaces(): Live<Space[]> {
  const { uid } = useAuth()
  const live = useLive<Space[]>(uid ? `${uid}|spaces` : null, (emit) => startMySpaces(uid as UID)(emit))
  useEnsure(live.data ?? [])
  return live
}

export function useSpace(spaceId: string): Live<Space | null> {
  const { uid } = useAuth()
  const live = useLive<Space | null>(uid && spaceId ? `${uid}|space|${spaceId}` : null, (emit) => startSpace(spaceId)(emit))
  useEnsure([live.data])
  return live
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

export { createSpace, lookupInvite, joinSpace, leaveSpace, updateSpace, inviteLink, removeMember, resetInviteCode } from './spaces.ts'

// ---------- Weeks ----------

/**
 * Live data for one week. Every space member before lockAt takes part, whether or not they open
 * it: opening any space (here, useSpace or useMySpaces) makes sure this week and next week exist and
 * hold every current member. `data.boundsMismatch` flags a week whose stored timeline doesn't match
 * the space's zone.
 */
export function useWeek(space: Space, weekId: WeekId): Live<WeekData> {
  const { uid } = useAuth()
  useEnsure([space])
  return useLive(uid ? weekKey(uid, space.id, weekId) : null, (emit) => startWeek(space.id, weekId, uid as UID)(emit))
}

export { savePlan, setTaskDone, submitReviews, joinWeek, ensureWeek } from './weeks.ts'
export { ensureSpace } from './months.ts'

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

/**
 * The stakes for a month: frozen once its first task lists locked (`frozen: true`), else the space's
 * current text (`frozen: false`, so an edit now still applies to this month).
 */
export function useMonthStakes(space: Space, monthId: MonthId): Live<MonthStakes> {
  const { uid } = useAuth()
  const live = useLive<MonthStakes | null>(uid ? `${uid}|months|${space.id}|${monthId}` : null, (emit) => startMonthStakes(space.id, monthId)(emit))
  return useMemo(() => {
    if (live.data) return { data: live.data, loading: false, error: live.error }
    if (live.loading) return { data: undefined, loading: true, error: null }
    return { data: { reward: space.reward, penalty: space.penalty, frozen: false }, loading: false, error: live.error }
  }, [live, space.reward, space.penalty])
}

export function useSettlements(spaceId: string): Live<Settlement[]> {
  const { uid } = useAuth()
  return useLive(uid && spaceId ? `${uid}|settlements|${spaceId}` : null, (emit) => startSettlements(spaceId)(emit))
}

export { setSettled } from './settlements.ts'
export { forget, forgetWhere } from './store.ts'
