// Deals: stakes with a length (SPEC §12.9). spaces/{id}/deals/{uid}_{seq}: the person proposes, each friend agrees
// (agreed.{me}), the person may withdraw it while it waits, everyone in it may tap Call Off (off.{me}), and anyone
// marks Settled (settled.{friend}). Only the reminders job writes agreedAt, start, track, checkedAt and an end other
// than a withdrawal. Every write but settleDeal fails at once offline (requireServer, then a transaction).
import {
  collection,
  doc,
  FieldPath,
  getDoc,
  getDocFromServer,
  getDocs,
  getDocsFromServer,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
  type DocumentSnapshot,
  type Query,
} from 'firebase/firestore'
import { now } from '../domain/clock.ts'
import {
  cleanDeal,
  DEAL_MAX_SEQ,
  DEAL_RECENT_DAYS,
  DEALS_FROM_MONTH,
  dealClock,
  dealFriends,
  dealId,
  dealProblem,
  dealProblemText,
  dealState,
  parseDealId,
} from '../domain/deals.ts'
import { spaceJudges } from '../domain/scoring.ts'
import type { Deal, DealInput, DealsView, MonthId, Space, UID } from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import type { Live } from './api.ts'
import { toDeal, toSpace } from './convert.ts'
import { humanError, isDenied, MSG } from './errors.ts'
import { profileRef, requireServer, requireUser } from './session.ts'
import { combine, forget, type Start } from './store.ts'

// ---------- Messages (SPEC §12.9; thrown as given) ----------

export const DEAL_MSG = {
  judging: 'You’re judging, so there’s no deal to make. Turn off Only Rate Friends to play.',
  lastNotOver: 'Your last deal isn’t over yet. You can make a new one once its result is in.',
  everyoneAgreed: 'Everyone agreed, so it can’t be withdrawn. Ask everyone to call it off.',
  notWithYou: 'This deal isn’t with you.',
  withdrawn: 'This deal was withdrawn.',
  ended: 'This deal has ended.',
  started: 'This deal already started without you.',
  notInDeal: 'You’re not in this deal.',
  noLonger: 'You’re no longer in this space.',
  proposeFailed: 'Couldn’t propose the deal. Try again.',
  withdrawFailed: 'Couldn’t withdraw it. Try again.',
  agreeFailed: 'Couldn’t agree. Try again.',
  callOffFailed: 'Couldn’t call it off. Try again.',
} as const

/** "{Lena} has left, so this deal won’t start." ("Its person" without a profile). */
export function personLeftText(name: string | null): string {
  return `${name?.trim() || 'Its person'} has left, so this deal won’t start.`
}

const DAY_MS = 24 * 3_600_000

// ---------- Refs and keys ----------

function dealsRef(spaceId: string) {
  return collection(getFirebase().db, 'spaces', spaceId, 'deals')
}

function dealRef(spaceId: string, id: string) {
  return doc(getFirebase().db, 'spaces', spaceId, 'deals', id)
}

function spaceRef(spaceId: string) {
  return doc(getFirebase().db, 'spaces', spaceId)
}

/** useDeals' store key (its two listeners are `…|open` and `…|ended|${since}`). */
export function dealsKey(uid: UID, spaceId: string): string {
  return `${uid}|deals|${spaceId}`
}

/** useDealHistory's store key. */
export function dealHistoryKey(uid: UID, spaceId: string): string {
  return `${uid}|dealHistory|${spaceId}`
}

/** useDealsFrom's store key (one read of public/config per session; not per user: it's the app's config). */
export const DEALS_FROM_KEY = 'config|dealsFrom'

// ---------- Hooks' sources ----------

/** The start of the local day DEAL_RECENT_DAYS before `nowMs`: the ended query's bound, the same all day long. */
export function recentSince(nowMs: number): number {
  const d = new Date(nowMs - DEAL_RECENT_DAYS * DAY_MS)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function listen(q: Query, spaceId: string): Start<Deal[]> {
  return (emit) =>
    onSnapshot(
      q,
      (snap) => emit({ data: snap.docs.flatMap((d) => toDeal(d, spaceId) ?? []), loading: false, error: null }),
      (error) => emit({ data: undefined, loading: false, error: humanError(error, MSG.noAccess) }),
    )
}

/**
 * The two lists as the screens want them (SPEC §12.9): each person's deal in play by uid (two for one person, which
 * the rules prevent, keep the higher seq; a deal the ended query already has as ended is left out, since the open
 * listener may not have caught up), and the deals that ended won, lost or off, newest end first.
 */
export function dealsView(open: Deal[], ended: Deal[]): DealsView {
  const over = new Set(ended.filter((d) => d.ended).map((d) => d.id))
  const byUid: Record<UID, Deal> = {}
  for (const d of open) {
    if (d.ended || over.has(d.id)) continue
    const had = byUid[d.uid]
    if (!had || d.seq > had.seq) byUid[d.uid] = d
  }
  const done = ended
    .filter((d) => d.ended && d.ended.outcome !== 'withdrawn')
    .sort((a, b) => (b.ended?.at ?? 0) - (a.ended?.at ?? 0) || a.id.localeCompare(b.id))
  return { open: byUid, ended: done }
}

function mergeDeals(states: Live<Deal[]>[]): Live<DealsView> {
  const [open, ended] = states
  const error = open.error ?? ended.error
  if (error) return { data: undefined, loading: false, error }
  if (!open.data || !ended.data) return { data: undefined, loading: true, error: null }
  return { data: dealsView(open.data, ended.data), loading: false, error: null }
}

/** useDeals' listeners (SPEC §12.9): `ended == null` and `ended.at >= the start of the day 60 days ago`. */
export function startDeals(spaceId: string, uid: UID): Start<DealsView> {
  const since = recentSince(now())
  const key = dealsKey(uid, spaceId)
  return combine(
    [
      { key: `${key}|open`, start: listen(query(dealsRef(spaceId), where('ended', '==', null)), spaceId) },
      { key: `${key}|ended|${since}`, start: listen(query(dealsRef(spaceId), where('ended.at', '>=', Timestamp.fromMillis(since))), spaceId) },
    ],
    mergeDeals,
  )
}

/** Every deal of the space (Past Deals), by person then newest seq first. */
export function startDealHistory(spaceId: string): Start<Deal[]> {
  return (emit) =>
    listen(dealsRef(spaceId), spaceId)((next) =>
      emit(next.data ? { ...next, data: [...next.data].sort((a, b) => a.uid.localeCompare(b.uid) || b.seq - a.seq) } : next),
    )
}

const MONTH_ID = /^\d{4}-(0[1-9]|1[0-2])$/

/** public/config.dealsFrom as the app takes it: a valid 'YYYY-MM' at or after DEALS_FROM_MONTH, else the constant. */
export function cleanDealsFrom(v: unknown): MonthId {
  return typeof v === 'string' && MONTH_ID.test(v) && v >= DEALS_FROM_MONTH ? v : DEALS_FROM_MONTH
}

/** The session's one read of public/config (kept once it answered; tried again on the next use after an error). */
let dealsFromRead: Promise<MonthId> | null = null

function readDealsFrom(): Promise<MonthId> {
  if (!dealsFromRead) {
    const pending = getDoc(doc(getFirebase().db, 'public', 'config')).then((snap) => cleanDealsFrom(snap.get('dealsFrom')))
    dealsFromRead = pending
    pending.catch(() => {
      if (dealsFromRead === pending) dealsFromRead = null
    })
  }
  return dealsFromRead
}

/** useDealsFrom's source: the cutover month once read; DEALS_FROM_MONTH on an error (offline without a cached copy). */
export const startDealsFrom: Start<MonthId> = (emit) => {
  let live = true
  readDealsFrom().then(
    (month) => live && emit({ data: month, loading: false, error: null }),
    () => live && emit({ data: DEALS_FROM_MONTH, loading: false, error: null }),
  )
  return () => {
    live = false
  }
}

/** Forgets the session's dealsFrom (tests, and a sign-in on a fresh session). */
export function forgetDealsFrom(): void {
  dealsFromRead = null
  forget(DEALS_FROM_KEY)
}

// ---------- Helpers on the stored doc (as the rules read it) ----------

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const keysOf = (v: unknown): string[] => (v && typeof v === 'object' ? Object.keys(v) : [])

/** A stored deal is in play while its `ended` is null (the rules' chain test). */
function inPlay(snap: DocumentSnapshot): boolean {
  return snap.get('ended') == null
}

/**
 * Whether its person may still withdraw it (the rules' withdrawsDeal): no `start` stamp, and some friend still in the
 * space hasn't agreed, or none is left to agree.
 */
function stillWaits(snap: DocumentSnapshot, memberIds: UID[]): boolean {
  if (snap.get('start') !== undefined) return false
  const agreed = new Set(keysOf(snap.get('agreed')))
  const need = strings(snap.get('friends')).filter((f) => memberIds.includes(f))
  return need.length === 0 || !need.every((f) => agreed.has(f))
}

function withdrawal(me: UID) {
  return { ended: { outcome: 'withdrawn', at: serverTimestamp(), by: me } }
}

function memberIdsOf(snap: DocumentSnapshot): UID[] {
  return snap.exists() ? toSpace(snap).memberIds : []
}

// ---------- Propose ----------

/** Another device created the next deal between the query and the transaction. */
const RACE = new Error('race')

async function proposeOnce(spaceId: string, me: UID, input: DealInput, replace: string | undefined): Promise<Deal> {
  const { db } = getFirebase()
  // Transactions can't query: your latest seq comes from one query on the server first.
  const mine = await getDocsFromServer(query(dealsRef(spaceId), where('uid', '==', me)))
  let last = 0
  for (const d of mine.docs) {
    const id = parseDealId(d.id)
    if (id && id.uid === me && id.seq > last) last = id.seq
  }
  const seq = last + 1
  if (seq > DEAL_MAX_SEQ) throw new Error(DEAL_MSG.proposeFailed)
  return runTransaction(db, async (tx) => {
    const spaceSnap = await tx.get(spaceRef(spaceId))
    if (!spaceSnap.exists()) throw new Error(DEAL_MSG.noLonger)
    const fresh = toSpace(spaceSnap)
    if (!fresh.memberIds.includes(me)) throw new Error(DEAL_MSG.noLonger)
    if (spaceJudges(fresh).includes(me)) throw new Error(DEAL_MSG.judging)
    const friends = dealFriends(fresh, me)
    const problem = dealProblem(input, friends)
    if (problem) throw new Error(dealProblemText(problem))
    const clean = cleanDeal(input, friends)
    const prevRef = last > 0 ? dealRef(spaceId, dealId(me, last)) : null
    const nextRef = dealRef(spaceId, dealId(me, seq))
    const prevSnap = prevRef ? await tx.get(prevRef) : null
    const nextSnap = await tx.get(nextRef)
    if (nextSnap.exists()) throw RACE
    if (prevRef && prevSnap?.exists() && inPlay(prevSnap)) {
      const prev = toDeal(prevSnap, spaceId)
      const waiting =
        prev !== null &&
        prev.start === undefined &&
        stillWaits(prevSnap, fresh.memberIds) &&
        dealState(prev, fresh, now(), dealClock(fresh, prev.unit)).phase === 'waiting'
      if (replace !== prevRef.id || !waiting) throw new Error(DEAL_MSG.lastNotOver)
      // Edit: the waiting deal is withdrawn in the same transaction (the rules check it with getAfter).
      tx.update(prevRef, withdrawal(me))
    }
    tx.set(nextRef, {
      uid: me,
      seq,
      unit: clean.unit,
      count: clean.count,
      rewardMode: clean.rewardMode,
      penaltyMode: clean.penaltyMode,
      reward: clean.reward,
      penalty: clean.penalty,
      per: clean.per,
      friends,
      agreed: {},
      off: {},
      settled: {},
      createdAt: serverTimestamp(),
      ended: null,
    })
    // The space's first deal sets its flag (marksDeals): from then on the app and the job read its deals.
    if (spaceSnap.get('hasDeals') === undefined) tx.update(spaceRef(spaceId), { hasDeals: true })
    const deal: Deal = {
      id: nextRef.id,
      spaceId,
      uid: me,
      seq,
      ...clean,
      friends,
      agreed: {},
      off: {},
      settled: {},
      createdAt: Date.now(),
      ended: null,
    }
    return deal
  })
}

/** After a refusal: your previous deal in play, or you no longer in the space, say so; else the plain failure. */
async function proposeRefusal(spaceId: string, me: UID, cause: unknown): Promise<Error> {
  try {
    const members = memberIdsOf(await getDocFromServer(spaceRef(spaceId)))
    if (!members.includes(me)) return new Error(DEAL_MSG.noLonger, { cause })
    const mine = await getDocsFromServer(query(dealsRef(spaceId), where('uid', '==', me)))
    if (mine.docs.some(inPlay)) return new Error(DEAL_MSG.lastNotOver, { cause })
  } catch (e) {
    if (isDenied(e)) return new Error(DEAL_MSG.noLonger, { cause })
  }
  return new Error(DEAL_MSG.proposeFailed, { cause })
}

/**
 * Proposes your next deal (SPEC §12.9): the editor's checks first (dealProblem, judging, nobody to play with), then
 * one server query for your deals here and a transaction that re-reads the space and your latest two ids, withdraws
 * your waiting deal when it is `replace` (Edit), creates `${me}_${seq + 1}` with `friends` = every other member who
 * doesn't judge, and sets the space's `hasDeals` the first time. Resolves with the deal as written (`createdAt` the
 * device's estimate). Fails at once offline.
 */
export async function proposeDeal(space: Space, input: DealInput, opts: { replace?: string } = {}): Promise<Deal> {
  const me = requireUser().uid
  if (!space.memberIds.includes(me)) throw new Error(DEAL_MSG.noLonger)
  if (spaceJudges(space).includes(me)) throw new Error(DEAL_MSG.judging)
  const problem = dealProblem(input, dealFriends(space, me))
  if (problem) throw new Error(dealProblemText(problem))
  await requireServer(me)
  for (let attempt = 1; ; attempt++) {
    try {
      return await proposeOnce(space.id, me, input, opts.replace)
    } catch (e) {
      if (e === RACE) {
        // Another device was quicker: look again once (its deal is now the one in play).
        if (attempt < 2) continue
        throw new Error(MSG.generic)
      }
      if (isDenied(e)) throw await proposeRefusal(space.id, me, e)
      throw humanError(e, DEAL_MSG.proposeFailed)
    }
  }
}

// ---------- Withdraw ----------

/**
 * Takes back your deal while some friend still in the space has to agree (SPEC §12.2): `ended = { outcome:
 * 'withdrawn', at, by }`. Already ended: resolves (a retry). Once everyone agreed, or the job stamped its start:
 * "Everyone agreed, so it can’t be withdrawn. Ask everyone to call it off." Fails at once offline.
 */
export async function withdrawDeal(space: Space, id: string): Promise<void> {
  const me = requireUser().uid
  if (parseDealId(id)?.uid !== me) throw new Error(DEAL_MSG.withdrawFailed)
  await requireServer(me)
  const ref = dealRef(space.id, id)
  try {
    await runTransaction(getFirebase().db, async (tx) => {
      const members = memberIdsOf(await tx.get(spaceRef(space.id)))
      if (!members.includes(me)) throw new Error(DEAL_MSG.noLonger)
      const snap = await tx.get(ref)
      if (!snap.exists()) throw new Error(DEAL_MSG.withdrawFailed)
      if (!inPlay(snap)) return
      if (!stillWaits(snap, members)) throw new Error(DEAL_MSG.everyoneAgreed)
      tx.update(ref, withdrawal(me))
    })
  } catch (e) {
    throw humanError(e, DEAL_MSG.withdrawFailed)
  }
}

/**
 * Best effort, before you leave a space (SPEC §12.13): your deal there still waiting for agreement is withdrawn. One
 * query (`uid == me`, in play checked on the device), then a transaction per deal in play that re-reads it; an agreed
 * deal is left alone (leaving counts as a miss for it). Callers ignore a failure: the job withdraws it otherwise.
 */
export async function withdrawWaitingDeal(spaceId: string, me: UID): Promise<void> {
  const mine = await getDocs(query(dealsRef(spaceId), where('uid', '==', me)))
  for (const d of mine.docs) {
    if (!inPlay(d)) continue
    await runTransaction(getFirebase().db, async (tx) => {
      const members = memberIdsOf(await tx.get(spaceRef(spaceId)))
      const snap = await tx.get(d.ref)
      if (!snap.exists() || !inPlay(snap) || !members.includes(me) || !stillWaits(snap, members)) return
      tx.update(d.ref, withdrawal(me))
    })
  }
}

/** Account deletion's deal step (SPEC §12.13): in every space with deals, your waiting deal is withdrawn (best effort). */
export async function withdrawAllWaitingDeals(me: UID): Promise<void> {
  const spaces = await getDocs(query(collection(getFirebase().db, 'spaces'), where('memberIds', 'array-contains', me)))
  for (const snap of spaces.docs) {
    if (!toSpace(snap).hasDeals) continue
    await withdrawWaitingDeal(snap.id, me).catch(() => {})
  }
}

// ---------- Agree ----------

/** Why an Agree can't be written, from the stored doc and the members (null: write it; 'done': already agreed). */
function agreeBlock(snap: DocumentSnapshot, me: UID, members: UID[]): string | { personLeft: UID } | 'done' | null {
  if (!snap.exists()) return DEAL_MSG.agreeFailed
  if (!strings(snap.get('friends')).includes(me)) return DEAL_MSG.notWithYou
  const ended: unknown = snap.get('ended')
  if (ended != null) return (ended as { outcome?: unknown }).outcome === 'withdrawn' ? DEAL_MSG.withdrawn : DEAL_MSG.ended
  if (keysOf(snap.get('agreed')).includes(me)) return 'done'
  const person: unknown = snap.get('uid')
  if (typeof person !== 'string' || !members.includes(person)) return { personLeft: typeof person === 'string' ? person : '' }
  if (snap.get('start') !== undefined) return DEAL_MSG.started
  if (!members.includes(me)) return DEAL_MSG.noLonger
  return null
}

async function personLeftError(uid: UID): Promise<Error> {
  let name: string | null = null
  if (uid) {
    const snap = await getDoc(profileRef(getFirebase().db, uid)).catch(() => null)
    const value: unknown = snap?.exists() ? snap.get('name') : null
    name = typeof value === 'string' ? value : null
  }
  return new Error(personLeftText(name))
}

class Blocked extends Error {
  readonly block: string | { personLeft: UID }
  constructor(block: string | { personLeft: UID }) {
    super(typeof block === 'string' ? block : 'person left')
    this.block = block
  }
}

async function blockError(block: string | { personLeft: UID }): Promise<Error> {
  return typeof block === 'string' ? new Error(block) : personLeftError(block.personLeft)
}

/** A refused Agree, read again from the server: why, or null when nothing explains it. */
async function agreeRecheck(spaceId: string, ref: ReturnType<typeof dealRef>, me: UID): Promise<Error | null> {
  let members: UID[]
  try {
    members = memberIdsOf(await getDocFromServer(spaceRef(spaceId)))
  } catch (e) {
    // Members read the space; anyone else is refused.
    return isDenied(e) ? new Error(DEAL_MSG.noLonger) : null
  }
  const block = agreeBlock(await getDocFromServer(ref), me, members)
  return block !== null && block !== 'done' ? blockError(block) : null
}

/**
 * Your Agree to a friend's waiting deal (SPEC §12.9): `agreed.{me}` = server time, in a transaction on the space and
 * the deal. Resolves without writing when you already agreed. Refuses with the deal's state: not with you, withdrawn,
 * ended, its person left ("{Lena} has left, so this deal won’t start."), started without you. A refusal by the rules
 * is re-read once and explained the same way, else "Couldn’t agree. Try again." Fails at once offline.
 */
export async function agreeToDeal(space: Space, id: string): Promise<void> {
  const me = requireUser().uid
  await requireServer(me)
  const ref = dealRef(space.id, id)
  try {
    await runTransaction(getFirebase().db, async (tx) => {
      const members = memberIdsOf(await tx.get(spaceRef(space.id)))
      const block = agreeBlock(await tx.get(ref), me, members)
      if (block === 'done') return
      if (block !== null) throw new Blocked(block)
      tx.update(ref, new FieldPath('agreed', me), serverTimestamp())
    })
  } catch (e) {
    if (e instanceof Blocked) throw await blockError(e.block)
    if (isDenied(e)) throw (await agreeRecheck(space.id, ref, me).catch(() => null)) ?? new Error(DEAL_MSG.agreeFailed, { cause: e })
    throw humanError(e, DEAL_MSG.agreeFailed)
  }
}

// ---------- Call Off ----------

/**
 * Your Call Off tap (SPEC §12.2): its person or one of its parties (dealState's), once it is fully agreed (scheduled
 * or running) and in play; `off.{me}` = server time, never taken back. Already tapped: resolves without writing. Fails
 * at once offline.
 */
export async function callOffDeal(space: Space, id: string): Promise<void> {
  const me = requireUser().uid
  await requireServer(me)
  const ref = dealRef(space.id, id)
  try {
    await runTransaction(getFirebase().db, async (tx) => {
      const spaceSnap = await tx.get(spaceRef(space.id))
      if (!spaceSnap.exists()) throw new Error(DEAL_MSG.callOffFailed)
      const fresh = toSpace(spaceSnap)
      const snap = await tx.get(ref)
      const deal = toDeal(snap, space.id)
      if (!snap.exists() || !deal) throw new Error(DEAL_MSG.callOffFailed)
      if (!inPlay(snap)) throw new Error(DEAL_MSG.ended)
      const state = dealState(deal, fresh, now(), dealClock(fresh, deal.unit))
      if (me !== deal.uid && !state.parties.includes(me)) throw new Error(DEAL_MSG.notInDeal)
      if (state.phase !== 'scheduled' && state.phase !== 'running') throw new Error(DEAL_MSG.callOffFailed)
      if (keysOf(snap.get('off')).includes(me)) return
      tx.update(ref, new FieldPath('off', me), serverTimestamp())
    })
  } catch (e) {
    throw humanError(e, DEAL_MSG.callOffFailed)
  }
}

// ---------- Settle ----------

/**
 * Marks the pairs of one debt line of a won or lost deal settled (or not): one update of `settled.{friend}` =
 * { settled, by: me, at: serverTimestamp() } per friend of the line (a together line is one tap). Queues offline like
 * settlePairs (the check shows at once).
 */
export async function settleDeal(space: Space, id: string, friends: UID[], settled: boolean): Promise<void> {
  const me = requireUser().uid
  if (friends.length === 0) return
  const pairs: unknown[] = []
  for (const f of [...new Set(friends)]) pairs.push(new FieldPath('settled', f), { settled, by: me, at: serverTimestamp() })
  const [first, value, ...rest] = pairs
  try {
    await updateDoc(dealRef(space.id, id), first as FieldPath, value, ...rest)
  } catch (e) {
    throw humanError(e, MSG.noAccess)
  }
}
