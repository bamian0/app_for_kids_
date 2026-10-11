// Money (SPEC §6.3): balance, revenue tasks, money moves and goals. Private: it all lives under
// users/{uid}, which only that user can read or write; friends never see any of it.
import { useSyncExternalStore } from 'react'
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromCache,
  getDocs,
  getDocsFromCache,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type DocumentReference,
  type DocumentSnapshot,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'
import { defaultCurrency, earningId, MAX_AMOUNT, nextGoalOrder, roundMoney } from '../domain/money.ts'
import type { CurrencyCode, Earning, Goal, MoneyMove, MoneyState, Space, Task, UID, WeekId } from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import type { Live } from './api.ts'
import { toEarning, toGoal, toMoneyState, toMove } from './convert.ts'
import { humanError, isDenied, MSG } from './errors.ts'
import { authState, requireUser, startAuth } from './session.ts'
import { peek, useLive, type Start } from './store.ts'
import { oneLine, TASK_ID } from './tasks.ts'

const MAX_NOTE = 80
const MAX_GOAL_NAME = 60
/** Writes per batch when deleting everything (Firestore allows 500). */
const BATCH_SIZE = 400
/** Updating a doc that is gone is refused by the rules (they read its fields) rather than "not found". */
const GONE = 'This no longer exists.'

// ---------- References and store keys ----------

function userCol(uid: UID, name: 'money' | 'earnings' | 'moves' | 'goals') {
  return collection(getFirebase().db, 'users', uid, name)
}

function stateRef(uid: UID) {
  return doc(userCol(uid, 'money'), 'state')
}

export function earningRef(uid: UID, id: string) {
  return doc(userCol(uid, 'earnings'), id)
}

// Prefixed by the uid like every store key, so another account never sees these.
export const moneyKeys = {
  state: (uid: UID) => `${uid}|money|state`,
  earnings: (uid: UID) => `${uid}|money|earnings`,
  moves: (uid: UID) => `${uid}|money|moves`,
  goals: (uid: UID) => `${uid}|money|goals`,
}

// ---------- Live data ----------

const denied = (error: unknown) => ({ data: undefined, loading: false, error: humanError(error, MSG.noAccess) })

export function startMoneyState(uid: UID): Start<MoneyState | null> {
  return (emit) =>
    onSnapshot(
      stateRef(uid),
      (snap) => emit({ data: snap.exists() ? toMoneyState(snap) : null, loading: false, error: null }),
      (error) => emit(denied(error)),
    )
}

function startList<T>(uid: UID, name: 'earnings' | 'moves' | 'goals', convert: (docs: QueryDocumentSnapshot[]) => T[]): Start<T[]> {
  return (emit) =>
    onSnapshot(
      userCol(uid, name),
      (snap) => emit({ data: convert(snap.docs), loading: false, error: null }),
      (error) => emit(denied(error)),
    )
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export const startEarnings = (uid: UID): Start<Earning[]> => startList(uid, 'earnings', (docs) => docs.map(toEarning))

/**
 * Newest first. Moves are never edited, so one still on its way to the server was just added: it goes
 * on top, since its time is only the SDK's estimate until then (whole seconds, so it can tie or trail).
 */
export const startMoves = (uid: UID): Start<MoneyMove[]> =>
  startList(uid, 'moves', (docs) =>
    docs
      .map((d) => ({ move: toMove(d), pending: d.metadata.hasPendingWrites }))
      .sort((a, b) => Number(b.pending) - Number(a.pending) || b.move.at - a.move.at || byId(a.move, b.move))
      .map(({ move }) => move),
  )

/** The order money fills them: by order, then createdAt. */
export const startGoals = (uid: UID): Start<Goal[]> =>
  startList(uid, 'goals', (docs) => docs.map(toGoal).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || byId(a, b)))

function subscribeAuth(onChange: () => void): () => void {
  startAuth()
  return authState.subscribe(onChange)
}

const currentUid = () => authState.get().uid

/** Only the uid: money hooks don't re-render when the profile changes. */
function useUid(): UID | null {
  return useSyncExternalStore(subscribeAuth, currentUid, currentUid)
}

export function useMoneyState(): Live<MoneyState | null> {
  const uid = useUid()
  return useLive(uid ? moneyKeys.state(uid) : null, (emit) => startMoneyState(uid as UID)(emit))
}

export function useEarnings(): Live<Earning[]> {
  const uid = useUid()
  return useLive(uid ? moneyKeys.earnings(uid) : null, (emit) => startEarnings(uid as UID)(emit))
}

export function useMoves(): Live<MoneyMove[]> {
  const uid = useUid()
  return useLive(uid ? moneyKeys.moves(uid) : null, (emit) => startMoves(uid as UID)(emit))
}

export function useGoals(): Live<Goal[]> {
  const uid = useUid()
  return useLive(uid ? moneyKeys.goals(uid) : null, (emit) => startGoals(uid as UID)(emit))
}

let deviceCurrency: CurrencyCode | null = null

/** The device locale's currency; the locale doesn't change while the app runs. */
function fallbackCurrency(): CurrencyCode {
  deviceCurrency ??= defaultCurrency()
  return deviceCurrency
}

export function useCurrency(): CurrencyCode {
  return useMoneyState().data?.currency || fallbackCurrency()
}

// ---------- Helpers ----------

/** What this device has (pending writes included), else the server's; null when neither answers. */
async function read(ref: DocumentReference): Promise<DocumentSnapshot | null> {
  try {
    return await getDocFromCache(ref)
  } catch {
    return getDoc(ref).catch(() => null)
  }
}

/** Amounts as the rules take them: finite, rounded to cents, within MAX_AMOUNT (more than 0 for `positive`). */
function checkAmount(value: number, opts: { positive?: boolean; negative?: boolean } = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Enter an amount.')
  const rounded = roundMoney(value)
  if (opts.positive && rounded <= 0) throw new Error('Enter an amount greater than 0.')
  if (!opts.negative && rounded < 0) throw new Error('Enter an amount.')
  if (Math.abs(rounded) > MAX_AMOUNT) throw new Error('That amount is too large.')
  return rounded
}

/** The task title an earning keeps (1–120 characters, one line). */
function earningTitle(title: string): string {
  return oneLine(title).slice(0, 120)
}

const chains = new Map<string, Promise<void>>()

/**
 * Runs best-effort work after whatever is already queued under `key`, so background fixes land in the
 * order they were asked for. It never rejects: a failure is simply left for the next change.
 */
export function inBackground(key: string, work: () => Promise<void>): Promise<void> {
  const next = (chains.get(key) ?? Promise.resolve()).then(work).catch(() => {})
  chains.set(key, next)
  void next.then(() => {
    if (chains.get(key) === next) chains.delete(key)
  })
  return next
}

// ---------- Balance and currency ----------

/** Creates money/state with the device's currency when it is missing; otherwise changes only `patch`. */
async function writeState(patch: { currency?: CurrencyCode; baseline?: number }): Promise<void> {
  const ref = stateRef(requireUser().uid)
  const changes: Record<string, unknown> = { updatedAt: serverTimestamp() }
  if (patch.currency !== undefined) changes.currency = patch.currency
  // "I have this much now": earnings and moves until now are in it (SPEC §6.3).
  if (patch.baseline !== undefined) Object.assign(changes, { baseline: patch.baseline, baselineAt: serverTimestamp() })
  try {
    const snap = await read(ref)
    if (!snap) throw new Error(MSG.offline)
    if (snap.exists()) await updateDoc(ref, changes)
    else await setDoc(ref, { currency: fallbackCurrency(), baseline: null, baselineAt: null, ...changes })
  } catch (e) {
    throw humanError(e, MSG.generic)
  }
}

/** Relabels every amount; nothing is converted. */
export async function setCurrency(code: CurrencyCode): Promise<void> {
  const currency = code.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(MSG.generic)
  await writeState({ currency })
}

/** "I have this much now". May be negative. */
export async function setBaseline(amount: number): Promise<void> {
  await writeState({ baseline: checkAmount(amount, { negative: true }) })
}

// ---------- Revenue tasks ----------

/**
 * Switches a task's "generates revenue" on (with `amount`, 0 for no amount yet) or off (null). Any
 * week, before or after the lock. `done` is whether the task is done now: a done task keeps the
 * time it was earned, or is earned now.
 */
export async function setTaskRevenue(space: Space, weekId: WeekId, task: Pick<Task, 'id' | 'title'>, amount: number | null, done: boolean): Promise<void> {
  const uid = requireUser().uid
  if (!TASK_ID.test(task.id)) throw new Error(MSG.generic)
  const ref = earningRef(uid, earningId(space.id, weekId, task.id))
  try {
    if (amount === null) {
      await deleteDoc(ref)
      return
    }
    const value = checkAmount(amount)
    const title = earningTitle(task.title)
    if (!title) throw new Error('Give the task a title first.')
    const write = (earnedAt: unknown) =>
      setDoc(ref, { spaceId: space.id, weekId, taskId: task.id, title, amount: value, earnedAt, updatedAt: serverTimestamp() })
    let earnedAt: unknown = null
    if (done) {
      // A Timestamp from the stored doc is kept as it is (the rules allow it unchanged); a pending one reads as null.
      const before: unknown = (await read(ref))?.get('earnedAt')
      earnedAt = before instanceof Timestamp ? before : serverTimestamp()
    }
    await write(earnedAt).catch((e: unknown) => {
      // This device's copy was out of date (changed on another device): then it is earned now.
      if (!(earnedAt instanceof Timestamp && isDenied(e))) throw e
      return write(serverTimestamp())
    })
  } catch (e) {
    throw humanError(e, MSG.generic)
  }
}

/** An earning as this device knows it: whether it is earned, null when there is none, undefined when it can't tell. */
export async function knownEarning(uid: UID, id: string): Promise<{ earned: boolean } | null | undefined> {
  try {
    const snap = await getDocFromCache(earningRef(uid, id))
    return snap.exists() ? { earned: snap.get('earnedAt', { serverTimestamps: 'estimate' }) != null } : null
  } catch {
    // Not cached as a doc; a live list of every earning still tells.
    const list = peek<Earning[]>(moneyKeys.earnings(uid)).data
    if (!list) return undefined
    const found = list.find((e) => e.id === id)
    return found ? { earned: found.earnedAt !== null } : null
  }
}

/** The earnedAt change that keeps an earning in step with its task: undefined when there is none. */
export function earnedAtChange(earned: boolean, done: boolean): { earnedAt: unknown; updatedAt: unknown } | undefined {
  if (earned === done) return undefined
  return { earnedAt: done ? serverTimestamp() : null, updatedAt: serverTimestamp() }
}

/** Server-side version of the above, for when the device couldn't tell at tick time. */
export async function settleEarning(uid: UID, id: string, done: boolean): Promise<void> {
  const snap = await getDoc(earningRef(uid, id))
  if (!snap.exists()) return
  const change = earnedAtChange(snap.get('earnedAt') != null, done)
  if (change) await updateDoc(snap.ref, change)
}

/**
 * After a plan save (before the lock): earnings take their tasks' new titles, and go with tasks that
 * were deleted. `removed` is what this save deleted; null when the previous list wasn't known, and
 * then every earning of the week whose task isn't on the list goes. Best effort, never rejects.
 */
export function syncPlanEarnings(uid: UID, spaceId: string, weekId: WeekId, tasks: Task[], removed: ReadonlySet<string> | null): Promise<void> {
  return inBackground(`${uid}|plan|${spaceId}|${weekId}`, async () => {
    const live = peek<Earning[]>(moneyKeys.earnings(uid)).data
    const earnings = live
      ? live.filter((e) => e.spaceId === spaceId && e.weekId === weekId)
      : (await getDocs(query(userCol(uid, 'earnings'), where('spaceId', '==', spaceId), where('weekId', '==', weekId)))).docs.map(toEarning)
    const titles = new Map(tasks.map((t) => [t.id, earningTitle(t.title)]))
    const batch = writeBatch(getFirebase().db)
    let writes = 0
    for (const earning of earnings) {
      const ref = earningRef(uid, earning.id)
      const title = titles.get(earning.taskId)
      if (title === undefined) {
        if (removed && !removed.has(earning.taskId)) continue
        batch.delete(ref)
      } else if (title && title !== earning.title) {
        batch.update(ref, { title, updatedAt: serverTimestamp() })
      } else {
        continue
      }
      writes++
    }
    if (writes > 0) await batch.commit()
  })
}

// ---------- Money moves ----------

export async function addMove(kind: 'add' | 'spend', amount: number, note: string): Promise<void> {
  if (kind !== 'add' && kind !== 'spend') throw new Error(MSG.generic)
  const value = checkAmount(amount, { positive: true })
  const text = oneLine(note)
  if (text.length > MAX_NOTE) throw new Error(`Keep the note under ${MAX_NOTE} characters.`)
  const uid = requireUser().uid
  try {
    await setDoc(doc(userCol(uid, 'moves')), { kind, amount: value, note: text, at: serverTimestamp() })
  } catch (e) {
    throw humanError(e, MSG.generic)
  }
}

/** Undo. Moves are never edited. */
export async function deleteMove(id: string): Promise<void> {
  const uid = requireUser().uid
  try {
    await deleteDoc(doc(userCol(uid, 'moves'), id))
  } catch (e) {
    throw humanError(e, MSG.generic)
  }
}

// ---------- Goals ----------

/** The goals as the live list has them, else as stored. */
async function currentGoals(uid: UID): Promise<Goal[]> {
  const live = peek<Goal[]>(moneyKeys.goals(uid)).data
  if (live) return live
  const col = userCol(uid, 'goals')
  const snap = await getDocs(col).catch(() => getDocsFromCache(col))
  return snap.docs.map(toGoal)
}

/** Creates a goal at the bottom of the list, or changes a goal's name and cost. Resolves with its id. */
export async function saveGoal(goal: { id?: string; name: string; cost: number }): Promise<string> {
  const name = oneLine(goal.name)
  if (!name) throw new Error('Give the goal a name.')
  if (name.length > MAX_GOAL_NAME) throw new Error(`Keep the name under ${MAX_GOAL_NAME} characters.`)
  const cost = checkAmount(goal.cost, { positive: true })
  const uid = requireUser().uid
  const col = userCol(uid, 'goals')
  try {
    if (goal.id) {
      // Deleted on another device, perhaps.
      await updateDoc(doc(col, goal.id), { name, cost }).catch((e: unknown) => {
        throw humanError(e, GONE)
      })
      return goal.id
    }
    const order = nextGoalOrder(await currentGoals(uid))
    const ref = doc(col)
    await setDoc(ref, { name, cost, order, createdAt: serverTimestamp() })
    return ref.id
  } catch (e) {
    throw humanError(e, MSG.generic)
  }
}

export async function deleteGoal(id: string): Promise<void> {
  const uid = requireUser().uid
  try {
    await deleteDoc(doc(userCol(uid, 'goals'), id))
  } catch (e) {
    throw humanError(e, MSG.generic)
  }
}

/** `ids` top first: the order money fills them. One batch. */
export async function reorderGoals(ids: string[]): Promise<void> {
  const uid = requireUser().uid
  const col = userCol(uid, 'goals')
  const batch = writeBatch(getFirebase().db)
  for (const [index, id] of [...new Set(ids)].entries()) batch.update(doc(col, id), { order: index })
  try {
    await batch.commit()
  } catch (e) {
    throw humanError(e, GONE)
  }
}

/** Spends the goal's cost (noted with its name) and removes the goal, in one batch. */
export async function markGoalBought(goal: Goal): Promise<void> {
  const cost = checkAmount(goal.cost, { positive: true })
  const uid = requireUser().uid
  const batch = writeBatch(getFirebase().db)
  batch.set(doc(userCol(uid, 'moves')), { kind: 'spend', amount: cost, note: oneLine(goal.name).slice(0, MAX_NOTE), at: serverTimestamp() })
  batch.delete(doc(userCol(uid, 'goals'), goal.id))
  try {
    await batch.commit()
  } catch (e) {
    throw humanError(e, MSG.generic)
  }
}

// ---------- Account deletion ----------

/** Deletes money/state and every earning, move and goal of the user. */
export async function deleteAllMoney(uid: UID): Promise<void> {
  const { db } = getFirebase()
  const names = ['money', 'earnings', 'moves', 'goals'] as const
  const snaps = await Promise.all(names.map((name) => getDocs(userCol(uid, name))))
  const refs = snaps.flatMap((snap) => snap.docs.map((d) => d.ref))
  for (let i = 0; i < refs.length; i += BATCH_SIZE) {
    const batch = writeBatch(db)
    for (const ref of refs.slice(i, i + BATCH_SIZE)) batch.delete(ref)
    await batch.commit()
  }
}
