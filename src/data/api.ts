// Data layer API used by the screens. Signatures are the contract (docs/SPEC.md §2);
// STUB: the data agent implements every body (Firestore onSnapshot hooks + writes) and may
// split code into sibling files, but the exports below must stay as declared.
import type { Invite, Mark, MonthId, Settlement, Space, Task, UID, UserProfile, WeekData, WeekId } from '../domain/types.ts'

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

export function useAuth(): AuthState {
  throw new Error('not implemented')
}

/** Creates the auth user and users/{uid} profile. Errors are thrown as `Error` with a human-readable message. */
export function signUp(name: string, email: string, password: string): Promise<void> {
  throw new Error(`not implemented ${name} ${email} ${password}`)
}

export function signIn(email: string, password: string): Promise<void> {
  throw new Error(`not implemented ${email} ${password}`)
}

export function sendPasswordReset(email: string): Promise<void> {
  throw new Error(`not implemented ${email}`)
}

export function signOut(): Promise<void> {
  throw new Error('not implemented')
}

export function updateMyName(name: string): Promise<void> {
  throw new Error(`not implemented ${name}`)
}

/** Re-authenticates, leaves all spaces, deletes the user's docs and the auth user. */
export function deleteMyAccount(password: string): Promise<void> {
  throw new Error(`not implemented ${password}`)
}

// ---------- Spaces ----------

export function useMySpaces(): Live<Space[]> {
  throw new Error('not implemented')
}

export function useSpace(spaceId: string): Live<Space | null> {
  throw new Error(`not implemented ${spaceId}`)
}

/** Live profiles for the given uids; missing ones are simply absent from the record. */
export function useProfiles(uids: UID[]): Record<UID, UserProfile> {
  throw new Error(`not implemented ${uids}`)
}

/** Creates the space (timezone = this device's IANA zone) and its invite doc. */
export function createSpace(input: { name: string; reward: string; penalty: string }): Promise<Space> {
  throw new Error(`not implemented ${input}`)
}

/** Accepts a code or invite link; null if unknown. */
export function lookupInvite(codeOrLink: string): Promise<Invite | null> {
  throw new Error(`not implemented ${codeOrLink}`)
}

/** Joins via code or link and returns the spaceId. No-op if already a member. */
export function joinSpace(codeOrLink: string): Promise<string> {
  throw new Error(`not implemented ${codeOrLink}`)
}

export function leaveSpace(spaceId: string): Promise<void> {
  throw new Error(`not implemented ${spaceId}`)
}

export function updateSpace(spaceId: string, patch: Partial<Pick<Space, 'name' | 'reward' | 'penalty'>>): Promise<void> {
  throw new Error(`not implemented ${spaceId} ${patch}`)
}

/** `<app url>?join=CODE` for sharing. */
export function inviteLink(space: Space): string {
  throw new Error(`not implemented ${space}`)
}

// ---------- Weeks ----------

/** Live data for one week. While the week is still before lockAt it also creates the week doc
 *  or adds the current user to `members` (so opening a week = taking part in it). */
export function useWeek(space: Space, weekId: WeekId): Live<WeekData> {
  throw new Error(`not implemented ${space} ${weekId}`)
}

/** Replaces the current user's task list (only before lockAt). */
export function savePlan(space: Space, weekId: WeekId, tasks: Task[]): Promise<void> {
  throw new Error(`not implemented ${space} ${weekId} ${tasks}`)
}

/** Self check-off (until deadlineAt). */
export function setTaskDone(space: Space, weekId: WeekId, taskId: string, done: boolean): Promise<void> {
  throw new Error(`not implemented ${space} ${weekId} ${taskId} ${done}`)
}

/** Writes all of the current user's reviews and marks them submitted, in one batch. Final. */
export function submitReviews(space: Space, weekId: WeekId, reviews: { revieweeId: UID; marks: Record<string, Mark> }[]): Promise<void> {
  throw new Error(`not implemented ${space} ${weekId} ${reviews}`)
}

// ---------- Months ----------

/** Live WeekData for every week of the month (weekIdsInMonth). Does not create week docs. */
export function useMonth(space: Space, monthId: MonthId): Live<WeekData[]> {
  throw new Error(`not implemented ${space} ${monthId}`)
}

export function useSettlements(spaceId: string): Live<Settlement[]> {
  throw new Error(`not implemented ${spaceId}`)
}

export function setSettled(spaceId: string, monthId: MonthId, uid: UID, settled: boolean): Promise<void> {
  throw new Error(`not implemented ${spaceId} ${monthId} ${uid} ${settled}`)
}
