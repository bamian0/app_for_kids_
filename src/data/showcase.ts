// Profile showcase, rings and stats (batch 3, SPEC §11.7, §11.8). The showcase holds copies of what its owner switched
// on; switches change only on the server's copy (a transaction), and the background sync sends item fields only, so a
// stale device can't switch an item back on. Rings and stats are written by the reminders job; a refused read (not
// friends, stats hidden) reads as null. Pure logic lives in domain/showcase.ts.
import { useEffect, useSyncExternalStore } from 'react'
import {
  deleteDoc,
  doc,
  getDocsFromCache,
  collection,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  waitForPendingWrites,
  type DocumentData,
} from 'firebase/firestore'
import { now } from '../domain/clock.ts'
import { defaultCurrency } from '../domain/money.ts'
import { showcaseItems, showcasePatch, showOf, switchShowcase } from '../domain/showcase.ts'
import type {
  AchievedGoal,
  Earning,
  Goal,
  MoneyMove,
  MoneyState,
  Ring,
  ShowcaseDoc,
  ShowcaseItems,
  Showcase,
  ShowKey,
  ShownEarnings,
  ShownGoal,
  UID,
  UserStats,
} from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import type { Live } from './api.ts'
import { toRing, toShowcase, toStats } from './convert.ts'
import { humanError, isDenied, MSG } from './errors.ts'
import { moneyKeys, startEarnings, startGoals, startMoneyState, startMoves } from './money.ts'
import { authState, requireUser, startAuth } from './session.ts'
import { deviceTimeZone, requireServer } from './spaces.ts'
import { forget, peek, watch, type Start } from './store.ts'

/** The background sync waits this long after the last change before writing. */
export const SYNC_DEBOUNCE_MS = 2_000
const HOUR = 3_600_000
const SHOW_KEYS: readonly ShowKey[] = ['stats', 'achieved', 'goals', 'earnings']
type ItemKey = 'achieved' | 'goals' | 'earnings'
const ITEM_KEYS: readonly ItemKey[] = ['achieved', 'goals', 'earnings']

function db() {
  return getFirebase().db
}

export function showcaseRef(uid: UID) {
  return doc(db(), 'showcases', uid)
}

export const showcaseKey = (me: UID, who: UID) => `${me}|showcase|${who}`
export const ringKey = (me: UID, who: UID) => `${me}|ring|${who}`
export const statsKey = (me: UID, who: UID) => `${me}|stats|${who}`

// ---------- Live data ----------

/**
 * showcases/{who}, readable by anyone signed in; null without a doc. When its stats switch turns on, a stats read that
 * was refused before (stats hidden) is looked up again: Firestore never resumes a refused listener.
 */
export function startShowcase(me: UID, who: UID): Start<Showcase | null> {
  return (emit) => {
    let shown: boolean | null = null
    return onSnapshot(
      showcaseRef(who),
      (snap) => {
        const showcase = toShowcase(snap)
        const stats = showOf(showcase).stats
        if (shown === false && stats) setTimeout(() => forget(statsKey(me, who)), 0)
        shown = stats
        emit({ data: showcase, loading: false, error: null })
      },
      (error) => emit({ data: undefined, loading: false, error: humanError(error, MSG.noAccess) }),
    )
  }
}

/** A refusal is not an error here: it means "not yours to see", which reads as nothing. */
function refusedAsNull<T>(error: unknown): Live<T | null> {
  return isDenied(error) ? { data: null, loading: false, error: null } : { data: undefined, loading: false, error: humanError(error, MSG.noAccess) }
}

/** rings/{who}: yours or a friend's (the job writes them); null without one, or when you may not read it. */
export function startRing(who: UID): Start<Ring | null> {
  return (emit) =>
    onSnapshot(
      doc(db(), 'rings', who),
      (snap) => emit({ data: toRing(snap), loading: false, error: null }),
      (error) => emit(refusedAsNull<Ring>(error)),
    )
}

/** stats/{who}: yours, or anyone's whose showcase shows stats; null without one, or when hidden. */
export function startStats(who: UID): Start<UserStats | null> {
  return (emit) =>
    onSnapshot(
      doc(db(), 'stats', who),
      (snap) => emit({ data: toStats(snap), loading: false, error: null }),
      (error) => emit(refusedAsNull<UserStats>(error)),
    )
}

// ---------- Writes ----------

/** An item as stored: times as Timestamps (the rules compare `at` with request.time). */
function storedItem(key: ItemKey, value: AchievedGoal[] | ShownGoal[] | ShownEarnings): unknown {
  if (key === 'achieved') return (value as AchievedGoal[]).map((g) => ({ name: g.name, at: Timestamp.fromMillis(g.at) }))
  if (key === 'goals') return (value as ShownGoal[]).map((g) => ({ name: g.name, pct: g.pct }))
  const e = value as ShownEarnings
  return { monthId: e.monthId, amount: e.amount, currency: e.currency }
}

function sameItem(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * What the transaction writes: the switches, `updatedAt`, and the switched-on items. An item kept as stored is written
 * back exactly as stored, so the rules see that list unchanged and don't check it again (SPEC §11.5's budget).
 */
function showcaseData(next: ShowcaseDoc, stored: Showcase | null, raw: DocumentData, key: ShowKey): DocumentData {
  const out: DocumentData = { show: { ...next.show }, updatedAt: serverTimestamp() }
  for (const k of ITEM_KEYS) {
    const value = next[k]
    if (value === undefined) continue
    const kept = k !== key && stored?.[k] !== undefined && raw[k] !== undefined && sameItem(stored[k], value)
    out[k] = kept ? raw[k] : storedItem(k, value)
  }
  return out
}

/**
 * Turns one switch on or off: a transaction on the server's copy (switchShowcase), so another device's stale cache
 * can't undo it; `items` supplies the item of a switch turned on. Fails at once offline: a switch, especially one
 * turned off, is never left queued while strangers still see the item.
 */
export async function setShowcaseSwitch(key: ShowKey, on: boolean, items: ShowcaseItems): Promise<void> {
  if (!SHOW_KEYS.includes(key) || typeof on !== 'boolean') throw new Error(MSG.generic)
  const me = requireUser().uid
  await requireServer(me)
  try {
    await runTransaction(db(), async (tx) => {
      const ref = showcaseRef(me)
      const snap = await tx.get(ref)
      const stored = toShowcase(snap)
      const raw = snap.exists() ? snap.data() : {}
      tx.set(ref, showcaseData(switchShowcase(stored, key, on, items), stored, raw, key))
    })
  } catch (e) {
    throw humanError(e, MSG.generic)
  }
}

type SyncOutcome = 'done' | 'pending' | 'refused'

/**
 * Writes the sync's patch: each changed list in its own update with `updatedAt` (each stays within the rules'
 * budget for one list), never `show`, never a create. Achieved goals wait while a money move is still on its way to
 * the server: its time is the device's estimate until then, and the rules refuse a time after their own.
 */
async function writePatch(me: UID, patch: Partial<Pick<ShowcaseDoc, ItemKey>>): Promise<SyncOutcome> {
  if (patch.achieved) {
    const local = await getDocsFromCache(collection(db(), 'users', me, 'moves')).catch(() => null)
    if (local?.metadata.hasPendingWrites) {
      await waitForPendingWrites(db()).catch(() => {})
      return 'pending'
    }
  }
  const ref = showcaseRef(me)
  const writes = ITEM_KEYS.flatMap((k) => {
    const value = patch[k]
    return value === undefined ? [] : [updateDoc(ref, { [k]: storedItem(k, value), updatedAt: serverTimestamp() })]
  })
  const results = await Promise.allSettled(writes)
  // A refusal: the switch went off meanwhile (or the doc is gone). Ignored, and not tried again for the same patch.
  return results.some((r) => r.status === 'rejected') ? 'refused' : 'done'
}

function subscribeAuth(onChange: () => void): () => void {
  startAuth()
  return authState.subscribe(onChange)
}

const currentUid = () => authState.get().uid

/** Patches the sync gave up on, by user: a refused one isn't sent again until something changes. */
const refused = new Map<UID, string>()

function moneyOn(showcase: Showcase | null | undefined): boolean {
  const show = showOf(showcase ?? null)
  return showcase !== null && showcase !== undefined && (show.achieved || show.goals || show.earnings)
}

export interface SyncOptions {
  debounceMs?: number
}

/**
 * The background sync, outside React (useShowcaseSync runs it while signed in): it watches your showcase and, while a
 * money switch is on, the money docs (the same store entries, and so the same listeners, as Overview and Goals); on
 * each change it computes showcasePatch(stored, showcaseItems(…)) and, debounced, writes it. Nothing while no money
 * switch is on. Returns the function that stops it.
 */
export function startShowcaseSync(me: UID, opts: SyncOptions = {}): () => void {
  const debounceMs = opts.debounceMs ?? SYNC_DEBOUNCE_MS
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  /** The patch the timer will write ('' for none). */
  let scheduled: string | null = null
  let money: (() => void)[] | null = null
  const check = () => {
    if (stopped) return
    const stored = peek<Showcase | null>(showcaseKey(me, me)).data
    const on = moneyOn(stored)
    if (on && !money) {
      money = [
        watch(moneyKeys.moves(me), startMoves(me), check),
        watch(moneyKeys.goals(me), startGoals(me), check),
        watch(moneyKeys.earnings(me), startEarnings(me), check),
        watch(moneyKeys.state(me), startMoneyState(me), check),
      ]
    } else if (!on && money) {
      for (const release of money) release()
      money = null
    }
    const moves = peek<MoneyMove[]>(moneyKeys.moves(me)).data
    const goals = peek<Goal[]>(moneyKeys.goals(me)).data
    const earnings = peek<Earning[]>(moneyKeys.earnings(me)).data
    const state = peek<MoneyState | null>(moneyKeys.state(me)).data
    let patch: Partial<Pick<ShowcaseDoc, ItemKey>> | null = null
    if (on && stored && moves && goals && earnings && state !== undefined) {
      const items = showcaseItems({ moves, goals, earnings, state, currency: state?.currency || defaultCurrency() }, now(), deviceTimeZone())
      patch = showcasePatch(stored, items)
    }
    const signature = patch ? JSON.stringify(patch) : ''
    if (signature === scheduled) return
    clearTimeout(timer)
    scheduled = signature
    if (!patch || refused.get(me) === signature) return
    const write = patch
    timer = setTimeout(() => {
      void writePatch(me, write).then((outcome) => {
        if (outcome === 'refused') refused.set(me, signature)
        if (outcome === 'pending') {
          // The moves reached the server: look again with their server times.
          scheduled = null
          check()
        }
      })
    }, debounceMs)
  }
  const release = watch(showcaseKey(me, me), startShowcase(me, me), check)
  // Last month's earnings move on at the month's turn without any change: look again every hour.
  const hourly = setInterval(() => {
    scheduled = null
    check()
  }, HOUR)
  check()
  return () => {
    stopped = true
    clearTimeout(timer)
    clearInterval(hourly)
    release()
    if (money) for (const r of money) r()
  }
}

/**
 * Mounted once by the signed-in app: keeps your showcase's money copies in step with your money (startShowcaseSync),
 * debounced, only on change, while the stored showcase has a money switch on. Adds no listeners while none is on.
 */
export function useShowcaseSync(): void {
  const uid = useSyncExternalStore(subscribeAuth, currentUid, currentUid)
  useEffect(() => (uid ? startShowcaseSync(uid) : undefined), [uid])
}

// ---------- Account deletion (SPEC §11.12) ----------

/** Step 1: every switch off and no items, so strangers see nothing (stats included) even if deletion stops here. */
export async function hideShowcase(me: UID): Promise<void> {
  await setDoc(showcaseRef(me), { show: { stats: false, achieved: false, goals: false, earnings: false }, updatedAt: serverTimestamp() })
}

/** Step 5 (after the profile): the job's docs about you. Deleting a missing doc is fine. */
export async function deleteScoreDocs(me: UID): Promise<void> {
  await Promise.all(['rings', 'stats', 'scores'].map((name) => deleteDoc(doc(db(), name, me))))
}

/** Step 6, last. */
export async function deleteShowcase(me: UID): Promise<void> {
  await deleteDoc(showcaseRef(me))
}
