// Shared goals (batch 3, SPEC §11.3, §11.8): one team target that friends fill together, week by week. Every write is a
// transaction on the goal doc that writes exactly one of the rules' update branches (§11.5), and fails at once
// offline. Amounts are stored as ints in hundredths; the domain (domain/shared.ts) does the arithmetic the rules check,
// and the data layer reads the stored ints straight from the doc rather than converting the decoded units back.
import {
  collection,
  deleteField,
  doc,
  FieldPath,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  where,
  writeBatch,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type QueryDocumentSnapshot,
  type Transaction,
} from 'firebase/firestore'
import { now } from '../domain/clock.ts'
import { pairId } from '../domain/friends.ts'
import { isUid } from '../domain/ids.ts'
import {
  amountProblemText,
  applyCheckin,
  checkinClosesAt,
  checkinId,
  cleanNote,
  goalEndsAt,
  goalProblem,
  goalProblemText,
  goalWeek,
  isGoalId,
  MAX_GOAL_AMOUNT,
  nextOwner,
  noteProblem,
  noteProblemText,
  SHARED_MAX_PEOPLE,
  toHundredths,
} from '../domain/shared.ts'
import { utcOffsetMinutes } from '../domain/time.ts'
import type { Checkin, CheckinResult, NewSharedGoalInput, SharedGoal, SharedGoalPatch, SharedGoalsView, UID, WeekId } from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import { toCheckin, toSharedGoal } from './convert.ts'
import { humanError, isDenied, MSG } from './errors.ts'
import { requireUser } from './session.ts'
import { deviceTimeZone, requireServer } from './spaces.ts'
import { forgetWhere, type Start } from './store.ts'
import { oneLine } from './tasks.ts'

const MINUTE = 60_000
/** The sheet refuses a week this close to its end (the rules' upper bound, checkinClosesAt). */
const WEEK_SLACK_MS = 2 * MINUTE
/** A refused check-in this close to its week's end (by this device's clock) is that week ending. */
const WEEK_EDGE_MS = 15 * MINUTE
const DATE = /^\d{4}-\d{2}-\d{2}$/

export const SHARED_MSG = {
  onlyFriends: 'You can only invite friends.',
  full: 'A shared goal has room for 8 people.',
  ended: 'This goal has ended.',
  finished: 'This goal is finished.',
  notIn: 'You’re not in this goal anymore.',
  inviteGone: 'This invitation is no longer there.',
  weekEnded: 'That week just ended. Check in for this week instead.',
  checkinFailed: 'Couldn’t check in. Try again.',
  failed: 'Couldn’t do that. Try again.',
}

function db() {
  return getFirebase().db
}

function goalRef(goalId: string): DocumentReference {
  return doc(db(), 'sharedGoals', goalId)
}

function checkinsOf(goalId: string) {
  return collection(db(), 'sharedGoals', goalId, 'checkins')
}

export const sharedKeys = {
  goals: (me: UID) => `${me}|shared`,
  goal: (me: UID, goalId: string) => `${me}|sharedGoal|${goalId}`,
  checkins: (me: UID, goalId: string, weekId: WeekId) => `${me}|checkins|${goalId}|${weekId}`,
}

/** Forgets the check-ins of a goal (a listener refused before you joined never resumes on its own). */
function forgetCheckins(me: UID, goalIds: string[]): void {
  const prefixes = goalIds.map((id) => `${me}|checkins|${id}|`)
  forgetWhere((key) => prefixes.some((p) => key.startsWith(p)))
}

const nonNull = <T>(x: T | null): x is T => x !== null
const byCreated = (a: SharedGoal, b: SharedGoal) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// ---------- Live data ----------

/** Your goals (finished ones included) and your invitations: two queries, `memberIds` and `invited` array-contains you. */
export function startSharedGoals(me: UID): Start<SharedGoalsView> {
  return (emit) => {
    let goals: SharedGoal[] | undefined
    let invites: SharedGoal[] | undefined
    let member: Set<string> | null = null
    const send = () => {
      if (goals && invites) emit({ data: { goals, invites }, loading: false, error: null })
    }
    const fail = (error: unknown) => emit({ data: undefined, loading: false, error: humanError(error, MSG.noAccess) })
    const decode = (docs: QueryDocumentSnapshot[]) => docs.map(toSharedGoal).filter(nonNull).sort(byCreated)
    const col = collection(db(), 'sharedGoals')
    const stopGoals = onSnapshot(
      query(col, where('memberIds', 'array-contains', me)),
      (snap) => {
        goals = decode(snap.docs)
        const ids = new Set(goals.map((g) => g.id))
        // Joined (here or on another device): check-ins refused while invited are read again.
        const joined = member ? [...ids].filter((id) => !member!.has(id)) : []
        member = ids
        if (joined.length > 0) setTimeout(() => forgetCheckins(me, joined), 0)
        send()
      },
      fail,
    )
    const stopInvites = onSnapshot(
      query(col, where('invited', 'array-contains', me)),
      (snap) => {
        invites = decode(snap.docs).filter((g) => !g.memberIds.includes(me))
        send()
      },
      fail,
    )
    return () => {
      stopGoals()
      stopInvites()
    }
  }
}

/** One goal; null when missing, not a goal id, or not readable (you left, or your invitation went). */
export function startSharedGoal(goalId: string): Start<SharedGoal | null> {
  return (emit) => {
    if (!isGoalId(goalId)) {
      emit({ data: null, loading: false, error: null })
      return () => {}
    }
    return onSnapshot(
      goalRef(goalId),
      (snap) => emit({ data: toSharedGoal(snap), loading: false, error: null }),
      (error) => emit(isDenied(error) ? { data: null, loading: false, error: null } : { data: undefined, loading: false, error: humanError(error, MSG.noAccess) }),
    )
  }
}

/** One week's check-ins (one query); members only, so a refusal reads as none. */
export function startCheckins(goalId: string, weekId: WeekId): Start<Checkin[]> {
  return (emit) => {
    if (!isGoalId(goalId) || !DATE.test(weekId)) {
      emit({ data: [], loading: false, error: null })
      return () => {}
    }
    return onSnapshot(
      query(checkinsOf(goalId), where('weekId', '==', weekId)),
      (snap) => {
        const list = snap.docs.map(toCheckin).filter(nonNull)
        list.sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))
        emit({ data: list, loading: false, error: null })
      },
      (error) => emit(isDenied(error) ? { data: [], loading: false, error: null } : { data: undefined, loading: false, error: humanError(error, MSG.noAccess) }),
    )
  }
}

// ---------- Reading inside a transaction ----------

interface Read {
  snap: DocumentSnapshot
  goal: SharedGoal
  raw: DocumentData
}

/** The goal as the server has it; a refusal (not a member or invitee any more) throws `denied`. null when malformed. */
async function readGoal(tx: Transaction, goalId: string, denied: string): Promise<Read | null> {
  let snap: DocumentSnapshot
  try {
    snap = await tx.get(goalRef(goalId))
  } catch (e) {
    if (isDenied(e)) throw new Error(denied)
    throw e
  }
  const goal = snap.exists() ? toSharedGoal(snap) : null
  return goal ? { snap, goal, raw: snap.data() ?? {} } : null
}

/** A stored uid list exactly as stored (the rules compare whole lists). */
function rawUids(v: unknown): UID[] {
  return Array.isArray(v) ? v.filter((x): x is UID => typeof x === 'string') : []
}

function rawInt(v: unknown): number {
  return Number.isInteger(v) ? (v as number) : 0
}

function rawInts(v: unknown): Record<UID, number> {
  const out: Record<UID, number> = {}
  if (v && typeof v === 'object') for (const [uid, n] of Object.entries(v as Record<string, unknown>)) if (Number.isInteger(n)) out[uid] = n as number
  return out
}

/** A member of a goal that isn't finished; `owner`: and its owner. */
function needMember(goal: SharedGoal, me: UID, owner = false): void {
  if (!goal.memberIds.includes(me)) throw new Error(SHARED_MSG.notIn)
  if (goal.archivedAt !== null) throw new Error(SHARED_MSG.finished)
  if (owner && goal.ownerId !== me) throw new Error(SHARED_MSG.failed)
}

function isEnded(goal: SharedGoal, nowMs: number): boolean {
  const endsAt = goalEndsAt(goal)
  return endsAt !== null && nowMs >= endsAt
}

/** A real 'YYYY-MM-DD' day, or null. */
function cleanEndsOn(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null
  if (!DATE.test(v)) throw new Error(SHARED_MSG.failed)
  const [y, m, d] = v.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) throw new Error(SHARED_MSG.failed)
  return v
}

/** Every uid in `uids` is a friend of `me` (one read each). */
async function needFriends(tx: Transaction, me: UID, uids: UID[]): Promise<void> {
  for (const uid of uids) {
    const pair = await tx.get(doc(db(), 'friends', pairId(me, uid)))
    if (!pair.exists() || pair.get('state') !== 'friends') throw new Error(SHARED_MSG.onlyFriends)
  }
}

/** Transactions fail at once offline; our own messages pass through, anything else reads as `fallback`. */
async function write<T>(me: UID, fallback: string, work: () => Promise<T>): Promise<T> {
  await requireServer(me)
  try {
    return await work()
  } catch (e) {
    throw humanError(e, fallback)
  }
}

// ---------- Creating and inviting ----------

/** Creating the same goal twice at once (a double tap) returns the first attempt. */
const creating = new Map<string, Promise<string>>()

/**
 * Creates a goal (auto id) in this device's zone and its offset today (as createSpace), with you as owner and only
 * member (`zones: { you: zone }`), inviting up to 7 friends (each checked in the same transaction). Resolves with
 * its id. Fails at once offline.
 */
export function createSharedGoal(input: NewSharedGoalInput): Promise<string> {
  let me: UID
  let doc0: { name: string; unit: string; target100: number; endsOn: string | null; invite: UID[] }
  try {
    me = requireUser().uid
    const name = oneLine(input.name)
    const unit = oneLine(input.unit)
    const problem = goalProblem({ name, unit, target: input.target })
    if (problem) throw new Error(goalProblemText(problem))
    const invite = [...new Set(input.invite)].filter((uid) => uid !== me)
    if (invite.some((uid) => !isUid(uid))) throw new Error(SHARED_MSG.onlyFriends)
    if (invite.length > SHARED_MAX_PEOPLE - 1) throw new Error(SHARED_MSG.full)
    doc0 = { name, unit, target100: toHundredths(input.target), endsOn: cleanEndsOn(input.endsOn), invite }
  } catch (e) {
    return Promise.reject(e)
  }
  const key = JSON.stringify([me, doc0])
  let pending = creating.get(key)
  if (!pending) {
    pending = writeGoal(me, doc0).finally(() => creating.delete(key))
    creating.set(key, pending)
  }
  return pending
}

function writeGoal(me: UID, d: { name: string; unit: string; target100: number; endsOn: string | null; invite: UID[] }): Promise<string> {
  const ref = doc(collection(db(), 'sharedGoals'))
  const timezone = deviceTimeZone()
  // The zone's offset today: the rules anchor every week to it (±1h covers DST).
  const utcOffsetMin = Math.round(utcOffsetMinutes(timezone, Date.now()))
  return write(me, SHARED_MSG.failed, async () => {
    await runTransaction(db(), async (tx) => {
      await needFriends(tx, me, d.invite)
      tx.set(ref, {
        name: d.name,
        unit: d.unit,
        target100: d.target100,
        endsOn: d.endsOn,
        timezone,
        utcOffsetMin,
        zones: { [me]: timezone },
        ownerId: me,
        createdBy: me,
        memberIds: [me],
        invited: d.invite,
        joinedAt: { [me]: serverTimestamp() },
        leftAt: {},
        totals100: {},
        total100: 0,
        last: null,
        reachedAt: null,
        archivedAt: null,
        createdAt: serverTimestamp(),
      })
    })
    return ref.id
  })
}

/** The owner invites more friends (members + invited ≤ 8); people already in or invited are skipped. */
export async function inviteToSharedGoal(goalId: string, uids: UID[]): Promise<void> {
  const me = requireUser().uid
  if (!isGoalId(goalId)) throw new Error(SHARED_MSG.notIn)
  if (uids.some((uid) => !isUid(uid))) throw new Error(SHARED_MSG.onlyFriends)
  await write(me, SHARED_MSG.failed, () =>
    runTransaction(db(), async (tx) => {
      const read = await readGoal(tx, goalId, SHARED_MSG.notIn)
      if (!read) throw new Error(SHARED_MSG.notIn)
      const { goal, raw } = read
      needMember(goal, me, true)
      if (isEnded(goal, now())) throw new Error(SHARED_MSG.ended)
      const members = rawUids(raw.memberIds)
      const invited = rawUids(raw.invited)
      const added = [...new Set(uids)].filter((uid) => uid !== me && !members.includes(uid) && !invited.includes(uid))
      if (added.length === 0) return
      if (members.length + invited.length + added.length > SHARED_MAX_PEOPLE) throw new Error(SHARED_MSG.full)
      await needFriends(tx, me, added)
      tx.update(goalRef(goalId), { invited: [...invited, ...added] })
    }),
  )
}

/** The owner withdraws an invitation (a no-op when it's gone). */
export async function cancelSharedInvite(goalId: string, uid: UID): Promise<void> {
  const me = requireUser().uid
  if (!isGoalId(goalId)) throw new Error(SHARED_MSG.notIn)
  await write(me, SHARED_MSG.failed, () =>
    runTransaction(db(), async (tx) => {
      const read = await readGoal(tx, goalId, SHARED_MSG.notIn)
      if (!read) throw new Error(SHARED_MSG.notIn)
      needMember(read.goal, me, true)
      const invited = rawUids(read.raw.invited)
      if (!invited.includes(uid)) return
      tx.update(goalRef(goalId), { invited: invited.filter((u) => u !== uid) })
    }),
  )
}

/** Accepts your invitation, storing this device's zone for the check-in push. Already a member: resolves. */
export async function joinSharedGoal(goalId: string): Promise<void> {
  const me = requireUser().uid
  if (!isGoalId(goalId)) throw new Error(SHARED_MSG.inviteGone)
  const zone = deviceTimeZone()
  await write(me, SHARED_MSG.failed, () =>
    runTransaction(db(), async (tx) => {
      const read = await readGoal(tx, goalId, SHARED_MSG.inviteGone)
      if (!read) throw new Error(SHARED_MSG.inviteGone)
      const { goal, raw } = read
      const members = rawUids(raw.memberIds)
      if (members.includes(me)) return
      const invited = rawUids(raw.invited)
      if (!invited.includes(me)) throw new Error(SHARED_MSG.inviteGone)
      if (goal.archivedAt !== null) throw new Error(SHARED_MSG.finished)
      if (isEnded(goal, now())) throw new Error(SHARED_MSG.ended)
      if (members.length >= SHARED_MAX_PEOPLE) throw new Error(SHARED_MSG.full)
      tx.update(
        goalRef(goalId),
        'invited', invited.filter((u) => u !== me),
        'memberIds', [...members, me],
        new FieldPath('joinedAt', me), serverTimestamp(),
        new FieldPath('zones', me), zone,
      )
    }),
  )
  // Check-ins read while invited were refused; read them again now.
  forgetCheckins(me, [goalId])
}

/** Declines your invitation, silently. Nothing to decline (gone, or not readable any more): resolves. */
export async function declineSharedGoal(goalId: string): Promise<void> {
  const me = requireUser().uid
  if (!isGoalId(goalId)) return
  await write(me, SHARED_MSG.failed, () => runTransaction(db(), (tx) => declineIn(tx, goalId, me)))
}

async function declineIn(tx: Transaction, goalId: string, me: UID): Promise<void> {
  let snap: DocumentSnapshot
  try {
    snap = await tx.get(goalRef(goalId))
  } catch (e) {
    if (isDenied(e)) return
    throw e
  }
  const invited = snap.exists() ? rawUids(snap.get('invited')) : []
  if (!invited.includes(me)) return
  tx.update(goalRef(goalId), { invited: invited.filter((u) => u !== me) })
}

// ---------- Leaving ----------

/** Joined times in microseconds (as the rules compare the stored timestamps), so the next owner is exactly theirs. */
function joinedMicros(raw: DocumentData): Record<UID, number> {
  const out: Record<UID, number> = {}
  const joined = raw.joinedAt
  if (joined && typeof joined === 'object') {
    for (const [uid, t] of Object.entries(joined as Record<string, unknown>)) {
      if (t instanceof Timestamp) out[uid] = t.seconds * 1_000_000 + Math.floor(t.nanoseconds / 1000)
    }
  }
  return out
}

/** Writes in one Firestore batch or transaction, at most. */
const MAX_WRITES = 500

/**
 * Leaves a goal the way every leave does (SPEC §11.8, §11.12): lists your check-in ids while still a member, then
 * - the last member out deletes the goal with those check-ins, in one transaction (nobody could read it again, so
 *   nothing of it is left behind: its name, the zones, everyone's parts);
 * - anyone else leaves in a transaction (your zone goes, your part stays in the totals; an owner hands on to the
 *   earliest-joined member), then deletes those check-ins.
 * Not a member: nothing happens. A last member with more check-ins than a transaction holds (499: nine years of
 * weeks) finishes the goal instead, as the rules also allow, and it stays, unreadable (SPEC §11.15).
 */
export async function leaveGoal(me: UID, goalId: string): Promise<boolean> {
  const mine = await getDocs(query(checkinsOf(goalId), where('uid', '==', me))).then(
    (snap) => snap.docs.map((d) => d.ref),
    (e: unknown) => {
      if (isDenied(e)) return []
      throw e
    },
  )
  const outcome = await runTransaction(db(), async (tx): Promise<'none' | 'left' | 'deleted'> => {
    let snap: DocumentSnapshot
    try {
      snap = await tx.get(goalRef(goalId))
    } catch (e) {
      if (isDenied(e)) return 'none'
      throw e
    }
    if (!snap.exists()) return 'none'
    const raw = snap.data()
    const members = rawUids(raw.memberIds)
    if (!members.includes(me)) return 'none'
    const rest = members.filter((u) => u !== me)
    if (rest.length === 0 && mine.length < MAX_WRITES) {
      for (const ref of mine) tx.delete(ref)
      tx.delete(goalRef(goalId))
      return 'deleted'
    }
    const args: unknown[] = [
      new FieldPath('joinedAt', me), deleteField(),
      new FieldPath('leftAt', me), serverTimestamp(),
      new FieldPath('zones', me), deleteField(),
    ]
    if (rest.length === 0) {
      if (raw.archivedAt == null) args.push('archivedAt', serverTimestamp())
      args.push('invited', [])
    } else if (raw.ownerId === me) {
      const goal = toSharedGoal(snap)
      const next = goal ? nextOwner({ ...goal, memberIds: members, joinedAt: joinedMicros(raw) }, me) : rest[0]
      args.push('ownerId', next ?? rest[0])
    }
    tx.update(goalRef(goalId), 'memberIds', rest, ...args)
    return 'left'
  })
  if (outcome === 'none' || outcome === 'left') {
    for (let i = 0; i < mine.length; i += MAX_WRITES) {
      const batch = writeBatch(db())
      for (const ref of mine.slice(i, i + MAX_WRITES)) batch.delete(ref)
      await batch.commit()
    }
  }
  return outcome !== 'none'
}

/** Leaves a goal: your part stays in the total; your check-ins (numbers and notes) go with you. Fails at once offline. */
export async function leaveSharedGoal(goalId: string): Promise<void> {
  const me = requireUser().uid
  if (!isGoalId(goalId)) return
  await write(me, SHARED_MSG.failed, () => leaveGoal(me, goalId))
  forgetWhere((key) => key === sharedKeys.goal(me, goalId) || key.startsWith(`${me}|checkins|${goalId}|`))
}

/** Account deletion step 2 (SPEC §11.12): leaves every goal you're in, then declines every invitation. */
export async function leaveAllSharedGoals(me: UID): Promise<void> {
  const col = collection(db(), 'sharedGoals')
  const goals = await getDocs(query(col, where('memberIds', 'array-contains', me)))
  for (const goal of goals.docs) await leaveGoal(me, goal.id)
  const invites = await getDocs(query(col, where('invited', 'array-contains', me)))
  for (const goal of invites.docs) await runTransaction(db(), (tx) => declineIn(tx, goal.id, me))
}

// ---------- Editing and finishing ----------

/** The owner edits the name, unit, target or end date; reachedAt follows the new target (as the rules' reachesRule). */
export async function editSharedGoal(goalId: string, patch: SharedGoalPatch): Promise<void> {
  const me = requireUser().uid
  if (!isGoalId(goalId)) throw new Error(SHARED_MSG.notIn)
  const endsOn = 'endsOn' in patch ? cleanEndsOn(patch.endsOn) : undefined
  await write(me, SHARED_MSG.failed, () =>
    runTransaction(db(), async (tx) => {
      const read = await readGoal(tx, goalId, SHARED_MSG.notIn)
      if (!read) throw new Error(SHARED_MSG.notIn)
      const { goal, raw } = read
      needMember(goal, me, true)
      const name = patch.name !== undefined ? oneLine(patch.name) : goal.name
      const unit = patch.unit !== undefined ? oneLine(patch.unit) : goal.unit
      const target = patch.target !== undefined ? patch.target : goal.target
      const problem = goalProblem({ name, unit, target })
      if (problem) throw new Error(goalProblemText(problem))
      const target100 = patch.target !== undefined ? toHundredths(patch.target) : rawInt(raw.target100)
      const out: DocumentData = { name, unit, target100, endsOn: endsOn === undefined ? (raw.endsOn ?? null) : endsOn }
      const reached = rawInt(raw.total100) >= target100
      if (reached && raw.reachedAt == null) out.reachedAt = serverTimestamp()
      if (!reached && raw.reachedAt != null) out.reachedAt = null
      tx.update(goalRef(goalId), out)
    }),
  )
}

/** The owner finishes the goal: check-ins stop, invitations go, it moves to Finished. Already finished: resolves. */
export async function finishSharedGoal(goalId: string): Promise<void> {
  const me = requireUser().uid
  if (!isGoalId(goalId)) throw new Error(SHARED_MSG.notIn)
  await write(me, SHARED_MSG.failed, () =>
    runTransaction(db(), async (tx) => {
      const read = await readGoal(tx, goalId, SHARED_MSG.notIn)
      if (!read) throw new Error(SHARED_MSG.notIn)
      const { goal } = read
      if (!goal.memberIds.includes(me)) throw new Error(SHARED_MSG.notIn)
      if (goal.archivedAt !== null) return
      if (goal.ownerId !== me) throw new Error(SHARED_MSG.failed)
      tx.update(goalRef(goalId), { archivedAt: serverTimestamp(), invited: [] })
    }),
  )
}

// ---------- Checking in ----------

/**
 * Saves your part for `weekId` (the week the sheet shows; default this week in the goal's zone), replacing an earlier
 * check-in that week. One transaction reads the goal and your check-in for the week, then writes the check-in and the
 * goal's totals, `last` and reachedAt as applyCheckin says (exactly what the rules' checksIn checks). Once the week is
 * within 2 minutes of the rules' bound (checkinClosesAt) it throws "That week just ended…", as does a refusal near
 * that bound. Fails at once offline.
 */
export async function checkIn(goalId: string, amount: number, note: string, weekId?: WeekId): Promise<CheckinResult> {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new Error(amountProblemText('format'))
  if (amount < 0) throw new Error(amountProblemText('empty'))
  if (amount > MAX_GOAL_AMOUNT) throw new Error(amountProblemText('big'))
  const text = cleanNote(note)
  const long = noteProblem(text)
  if (long) throw new Error(noteProblemText(long))
  const amount100 = toHundredths(amount)
  const me = requireUser().uid
  if (!isGoalId(goalId)) throw new Error(SHARED_MSG.notIn)
  if (weekId !== undefined && !DATE.test(weekId)) throw new Error(SHARED_MSG.weekEnded)
  await requireServer(me)
  /** What the last attempt knew, to tell a refusal at the week's end from any other. */
  let closesAt = Number.NaN
  try {
    return await runTransaction(db(), async (tx): Promise<CheckinResult> => {
      const read = await readGoal(tx, goalId, SHARED_MSG.notIn)
      if (!read) throw new Error(SHARED_MSG.notIn)
      const { goal, raw } = read
      needMember(goal, me)
      const t = now()
      if (isEnded(goal, t)) throw new Error(SHARED_MSG.ended)
      const week = weekId ?? goalWeek(goal, t)
      closesAt = checkinClosesAt(goal, week)
      if (!(t < closesAt - WEEK_SLACK_MS)) throw new Error(SHARED_MSG.weekEnded)
      const ref = doc(checkinsOf(goalId), checkinId(week, me))
      const before = await tx.get(ref)
      const old100 = before.exists() ? rawInt(before.get('amount100')) : 0
      const reachedAt = raw.reachedAt instanceof Timestamp ? raw.reachedAt.toMillis() : null
      const r = applyCheckin({ totals100: rawInts(raw.totals100), total100: rawInt(raw.total100), target100: rawInt(raw.target100), reachedAt }, me, old100, amount100)
      tx.set(ref, { uid: me, weekId: week, amount100, note: text, at: serverTimestamp() })
      const extra: unknown[] = []
      if (r.reached === 'now') extra.push('reachedAt', serverTimestamp())
      if (r.reached === 'none' && raw.reachedAt != null) extra.push('reachedAt', null)
      tx.update(
        goalRef(goalId),
        new FieldPath('totals100', me), r.totals100[me],
        'total100', r.total100,
        'last', { by: me, weekId: week, at: serverTimestamp() },
        ...extra,
      )
      return { total: r.total100 / 100, reached: r.reached === 'now' }
    })
  } catch (e) {
    if (isDenied(e) && now() >= closesAt - WEEK_EDGE_MS) throw new Error(SHARED_MSG.weekEnded)
    throw humanError(e, SHARED_MSG.checkinFailed)
  }
}
