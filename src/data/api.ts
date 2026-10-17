// Data layer API used by the screens. Signatures are the contract (docs/SPEC.md §2).
// Writes live in sibling modules; this file holds the React hooks and re-exports everything.
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { now } from '../domain/clock.ts'
import type {
  MemberStakes,
  MonthData,
  MonthId,
  MonthlyData,
  MonthResults,
  MonthStakes,
  Period,
  Settlement,
  Space,
  Task,
  UID,
  UserProfile,
  WeekData,
  WeekId,
} from '../domain/types.ts'
import { mergeProfiles, startProfile } from './auth.ts'
import { monthDataKey, monthListCounts, monthlyKey, startMonthData, startMonthly } from './monthly.ts'
import { ensureSpace, startMonthStakes } from './months.ts'
import { startLatestResults, startResults } from './results.ts'
import { authState, startAuth } from './session.ts'
import { startSettlements } from './settlements.ts'
import { startMySpaces, startSpace } from './spaces.ts'
import { startStakes } from './stakes.ts'
import { combine, useLive } from './store.ts'
import { startWeek, weekKey } from './weeks.ts'
import type { NewTaskInput } from './weeks.ts'

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
export { signUp, signIn, sendPasswordReset, signOut, updateMyName, updateMyPhoto, deleteMyAccount } from './auth.ts'

// ---------- Spaces ----------

/** What ensureSpace reads from a space: a change to any of it (members, zone, times, judges, the pause request,
 *  the owner) re-runs the upkeep (retimes, judge snapshots, finalizing a pause). */
function upkeepSignature(s: Space): string {
  const schedule = s.schedule ? `${s.schedule.lock}/${s.schedule.reviewOpen}/${s.schedule.deadline}` : ''
  const pause = s.pause ? `${s.pause.weekId}/${s.pause.oks.join(',')}/${s.pause.declinedBy ?? ''}` : ''
  return [s.id, s.memberIds.join(','), s.timezone, schedule, (s.judges ?? []).join(','), pause, s.ownerId].join(':')
}

/** Runs ensureSpace for each space when it first loads and whenever what the upkeep reads changes (cheap when nothing to do). */
function useEnsure(spaces: (Space | null | undefined)[]): void {
  const signature = spaces.map((s) => (s ? upkeepSignature(s) : '')).join('|')
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

/**
 * createSpace({ name, reward, penalty, judge? }) and joinSpace(code, { judge? }): `judge` makes you a
 * judge from the start (SPEC §9.4). Without it they write exactly what they wrote before batch 2 (no
 * `judges`), so creating and joining keep working on the old rules. updateSpace: since batch 2 only the
 * owner changes the house stakes (reward, penalty); anyone renames the space ("Only the owner can change
 * the house stakes."). A house-stakes change counts at once for the month in progress: one transaction
 * first freezes each month of houseFreezeMonths (the UTC month and the one before, as the rules check) that
 * is complete and has no binding freeze (months/{monthId} with the old stakes: a create, or the re-freeze of
 * the previous app's early freeze), then writes the new stakes with `stakesNote` and the invite's copy; the
 * rules refuse the change while a complete month is unfrozen. It fails at once offline. leaveSpace, removeMember and deleteMyAccount also take the user out of
 * this month's and next week's month's monthly lists that haven't locked.
 */
export { createSpace, lookupInvite, joinSpace, leaveSpace, updateSpace, inviteLink, removeMember, resetInviteCode } from './spaces.ts'

/**
 * setJudge(spaceId, judge): you only rate (true) or play again (false), from the next week and monthly
 * list that haven't locked; locked ones keep your old role. Fails at once offline.
 */
export { setJudge } from './spaces.ts'

/**
 * setSchedule(spaceId, schedule | null) → { fromWeek }: the owner sets the space's times (null = the
 * usual ones). A change needs a day's notice: weeks (and monthly lists) whose lists lock at least 24 hours
 * away on both the old and the new times move in the same transaction; earlier ones keep their times, so
 * `fromWeek` is this week, next week or the week after. Everyone else sees the notice (space.scheduleNote).
 * Fails at once offline.
 */
export { setSchedule } from './schedule.ts'

/**
 * Pausing a week (SPEC §9.3), all on the space doc (read it with useSpace; pauseView in domain/pause.ts
 * says what to show). Each fails at once offline and throws plain messages.
 * askToPause(space, weekId) → 'asked' | 'paused' (nobody else in the week to ask: paused at once).
 * answerPause(space, 'ok' | 'not-now') → 'waiting' | 'paused' | 'declined'.
 * withdrawPause(space): the asker cancels the request; it stays, marked as cancelled (declinedBy = the
 * asker), so the 12-hour wait before asking again still holds.
 */
export { askToPause, answerPause, withdrawPause } from './pause.ts'

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

/**
 * savePlan(space, weekId, tasks): replaces your list, only before lockAt. Tasks may carry `subtasks`
 * (≤ 8); `addedAt` is ignored. Also, best effort: renames and deletes your earnings to match.
 * addTaskAfterLock(space, weekId, { title, subtasks }): appends one task while lockAt ≤ now <
 * reviewOpenAt (SPEC §6.2). Final: it can't be edited or removed. Resolves with the stored task.
 * setTaskDone(space, weekId, id, done): `id` is a task id or a step (subtask) id. Also keeps your
 * earning for that task in step (earnedAt set when the task becomes done, cleared when it isn't).
 */
export { savePlan, addTaskAfterLock, setTaskDone, submitReviews, joinWeek, ensureWeek } from './weeks.ts'
export type { NewTaskInput } from './weeks.ts'
export { ensureSpace } from './months.ts'

// ---------- Months ----------

/**
 * The month's weeks and, from the computed start of the month's last week on (before that it can't
 * count yet), its monthly list: what computeMonth(space, monthId, data.weeks, nowMs, data.monthly)
 * needs. Space cards and Overview use this; MonthView passes useMonthly's list instead, to show it all
 * month. Store key `${uid}|month|${spaceId}|${monthId}|m` with the list, `…|w` before it can count (weeks
 * shared with useWeek, the list with useMonthly). Does not create docs.
 */
export function useMonthData(space: Space, monthId: MonthId): Live<MonthData> {
  const { uid } = useAuth()
  // Before the month's last week starts, the list can't count yet: only the weeks are loaded.
  const withList = monthListCounts(space, monthId, now())
  return useLive(uid ? monthDataKey(uid, space.id, monthId, withList) : null, (emit) => startMonthData(space.id, monthId, uid as UID, withList)(emit))
}

/**
 * Live data of one month's list (SPEC §9.5), like useWeek: the doc, plans, progress and reviews (blind
 * until revealed). `monthly: null` until a member opens the app in its creation window. null monthId:
 * nothing to watch (data undefined, not loading). Opening it also runs the space's upkeep, which creates
 * and fills the list while it can.
 */
export function useMonthly(space: Space, monthId: MonthId | null): Live<MonthlyData> {
  const { uid } = useAuth()
  useEnsure([space])
  const live = useLive<MonthlyData>(uid && monthId ? monthlyKey(uid, space.id, monthId) : null, (emit) => startMonthly(space.id, monthId as MonthId, uid as UID)(emit))
  return monthId === null ? NOTHING : live
}

const NOTHING: Live<never> = Object.freeze({ data: undefined, loading: false, error: null })

/**
 * Monthly list writes (SPEC §9.5); messages as savePlan / setTaskDone / submitReviews, plus the judge
 * and "not in this month's list" ones.
 * saveMonthlyPlan(space, monthId, tasks): replaces your list, only before its lock (no `addedAt`, no revenue).
 * setMonthlyTaskDone(space, monthId, id, done): a task or step id, until the list's deadline.
 * submitMonthlyReviews(space, monthId, reviews): one batch with the list's submittedBy, in its review
 * window (the month's last week's). The review sheet submits the week's batch first, then this one.
 */
export { saveMonthlyPlan, setMonthlyTaskDone, submitMonthlyReviews, ensureMonthly } from './monthly.ts'

/**
 * The house stakes for a month: its months/{monthId} doc (`frozen: true`, with `createdAt`), else the
 * space's current text (`frozen: false`). Since batch 2 a month is frozen once it is complete (ensureSpace,
 * the owner's edit, or the reminders job), so an owner's edit counts at once for the month in progress.
 * Whether a freeze binds is monthHouse's call (domain/stakes.ts): the previous app's early freeze (at the
 * first lock) of a month from FIRST_RESULTS_MONTH on doesn't, and is replaced when the month completes;
 * older months keep what they froze. They count between two people who haven't agreed on their own stakes
 * (SPEC §9.7). The Space screen's stakes card doesn't need it (the month whose terms count now is never
 * complete, so its house stakes are the space's).
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

/** One month's settlements: old per-member docs and per-pair docs (SPEC §9.7). */
export function useSettlements(spaceId: string, monthId: MonthId): Live<Settlement[]> {
  const { uid } = useAuth()
  return useLive<Settlement[]>(uid && spaceId ? `${uid}|settlements|${spaceId}|${monthId}` : null, (emit) => startSettlements(spaceId, monthId)(emit))
}

/**
 * settlePairs(spaceId, monthId, keys, settled): marks every pair of a debt line in one batch (a group
 * line is one tap). New clients never write the per-member shape from before batch 2; old docs still count.
 */
export { settlePairs } from './settlements.ts'

// ---------- Per-person stakes and streaks (SPEC §9.7, §9.8) ----------

/** Every member's own stakes (former members' too) and their friends' agreements, by uid. A member
 *  without a doc uses the house stakes with everyone. Store key `${uid}|stakes|${spaceId}`. */
export function useStakes(space: Space): Live<Record<UID, MemberStakes>> {
  const { uid } = useAuth()
  return useLive<Record<UID, MemberStakes>>(uid ? `${uid}|stakes|${space.id}` : null, (emit) => startStakes(space.id)(emit))
}

/** The month's results, streaks, streak-reward runs and its stored terms once the reminders job has written
 *  them (null until then; never before FIRST_RESULTS_MONTH). Store key `${uid}|results|${spaceId}|${monthId}`. */
export function useResults(space: Space, monthId: MonthId): Live<MonthResults | null> {
  const { uid } = useAuth()
  return useLive<MonthResults | null>(uid ? `${uid}|results|${space.id}|${monthId}` : null, (emit) => startResults(space.id, monthId)(emit))
}

/** The newest results doc: everyone's current streak. Store key `${uid}|results|${spaceId}|latest`. */
export function useLatestResults(space: Space): Live<MonthResults | null> {
  const { uid } = useAuth()
  return useLive<MonthResults | null>(uid ? `${uid}|results|${space.id}|latest` : null, (emit) => startLatestResults(space.id)(emit))
}

/**
 * saveMyStakes(space, input): saves your own terms (never anyone's agreement); each line (reward, penalty)
 * is Same for everyone or Different per friend. Fails at once offline.
 * agreeToStakes(space, owner, seen): agrees to `owner`'s current terms as you saw them, stamped with the
 * server time; "These stakes just changed. Take another look." when they changed since; resolves without
 * writing when you already agreed to exactly these. Fails at once offline.
 * An agreement counts at once for the month in progress; a month's terms are what was agreed before it was
 * complete, so a finished month never changes. A Same-for-everyone line and the streak rewards wait for
 * every friend; a per-friend line counts with that friend's own Agree (memberTerms in domain/stakes.ts).
 */
export { saveMyStakes, agreeToStakes } from './stakes.ts'
export type { StakesInput } from './stakes.ts'

// ---------- Batch 2.5: monthly adds and crossed-out tasks (SPEC §10) ----------

/**
 * addMonthlyTaskAfterLock(space, monthId, { id?, title, subtasks }): appends one task (with its steps) to your
 * monthly list while its lockAt ≤ now < reviewOpenAt, exactly like addTaskAfterLock for a week (SPEC §10.2): final
 * (never edited or removed), at most 25 in all, `added[id]` = server time, `cancels` left as stored. Only a list
 * that had ≥ 1 task at its lock grows. Pass the sheet's `id` so a retry can't add it twice (an existing id
 * resolves without writing). Resolves with the task (`addedAt` the device's estimate until the snapshot).
 * Fails at once offline (a transaction). Messages in SPEC §10.6.
 */
export async function addMonthlyTaskAfterLock(space: Space, monthId: MonthId, input: NewTaskInput): Promise<Task> {
  void [space, monthId, input]
  throw new Error('batch2.5: TODO') // batch2.5: TODO: implement in src/data/monthly.ts and re-export here
}

/**
 * crossOutTask(space, period, taskId, why): crosses out one of your own tasks of a locked week or monthly list,
 * until its reviews open (SPEC §10.3): one transaction re-reads the period and your plan and appends the next
 * entry of the task's `cancels` log (`${n}:${taskId}` → { at: serverTimestamp(), why }), with `updatedAt`.
 * `why` is trimmed and made one line (1–120 characters). Already crossed out: resolves without writing (a lost
 * answer or a retry). After the 2nd undo the cross-out is final. Fails at once offline. Messages in SPEC §10.6.
 */
export async function crossOutTask(space: Space, period: Period, taskId: string, why: string): Promise<void> {
  void [space, period, taskId, why]
  throw new Error('batch2.5: TODO') // batch2.5: TODO: implement in src/data/cancel.ts and re-export here
}

/**
 * undoCrossOut(space, period, taskId): restores a crossed-out task (the next, even entry `${n}:${taskId}` → { at })
 * while undos are left (at most 2 per task) and reviews haven't opened. Not crossed out: resolves without
 * writing. Fails at once offline. Messages in SPEC §10.6.
 */
export async function undoCrossOut(space: Space, period: Period, taskId: string): Promise<void> {
  void [space, period, taskId]
  throw new Error('batch2.5: TODO') // batch2.5: TODO: implement in src/data/cancel.ts and re-export here
}

// Also batch 2.5 (SPEC §10.6), in the existing writes: submitReviews / submitMonthlyReviews take
// `marks: Record<string, ReviewMark>` ('fair' on a crossed-out task); setTaskDone / setMonthlyTaskDone refuse a
// crossed-out task or one of its steps; addTaskAfterLock keeps the plan's `cancels` (an update, not a set).
// batch2.5: TODO

// ---------- Money (private, SPEC §6.3) ----------
// Hooks, all live and scoped to the signed-in user (data undefined while signed out):
//   useMoneyState(): Live<MoneyState | null>   null until the user sets a currency or balance
//   useEarnings():   Live<Earning[]>           every revenue task of the user, any space or week
//   useMoves():      Live<MoneyMove[]>         newest first
//   useGoals():      Live<Goal[]>              by order, lowest first
//   useCurrency():   CurrencyCode              the state's currency, else defaultCurrency()
// Writes (throw Error with a human-readable message):
//   setCurrency(code), setBaseline(amount)
//   setTaskRevenue(space, weekId, task, amount | null, done)   null switches revenue off (deletes)
//   addMove('add' | 'spend', amount, note), deleteMove(id)
//   saveGoal({ id?, name, cost }) → id, deleteGoal(id), reorderGoals(ids), markGoalBought(goal)
export { useMoneyState, useEarnings, useMoves, useGoals, useCurrency } from './money.ts'
export { setCurrency, setBaseline, setTaskRevenue, addMove, deleteMove, saveGoal, deleteGoal, reorderGoals, markGoalBought } from './money.ts'
export { forget, forgetWhere } from './store.ts'
