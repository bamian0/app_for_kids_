// Per-person stakes (SPEC §9.7): each member's own terms in spaces/{id}/stakes/{uid}, and each friend's
// Agree inside that doc (agreed.{friend}), which only that friend writes.
import { collection, doc, FieldPath, getDocFromServer, onSnapshot, runTransaction, serverTimestamp, type DocumentSnapshot } from 'firebase/firestore'
import { MAX_TIER_MONTHS, MAX_TIERS, MIN_TIER_MONTHS, nextAgreement, pairTerms, sameTerms } from '../domain/stakes.ts'
import type { MemberStakes, PairTerms, Space, StakesMode, StreakTier, UID } from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import { toMemberStakes, toSpace } from './convert.ts'
import { humanError, isDenied, MSG } from './errors.ts'
import { requireUser } from './session.ts'
import { requireServer } from './spaces.ts'
import type { Start } from './store.ts'

/** What the stakes editor saves: your terms, never anyone's agreements. Each line has its own mode. */
export interface StakesInput {
  rewardMode: StakesMode
  penaltyMode: StakesMode
  reward: string
  penalty: string
  per: Record<UID, { reward: string; penalty: string }>
  tiers: StreakTier[]
}

const MAX_TEXT = 120
const FILL_GROUP = 'Fill in what they owe you and what you owe them.'
const FILL_REWARD_EACH = 'Fill in what each friend owes you, or make it the same for everyone.'
const FILL_PENALTY_EACH = 'Fill in what you owe each friend, or make it the same for everyone.'
const FILL_TIER = 'Fill in each streak reward.'
const TOO_LONG = 'Keep each one under 120 characters.'
const TOO_MANY_TIERS = 'Up to 5 streak rewards.'
const SAME_TIER = 'Each streak length can only be used once.'
const TIER_RANGE = 'A streak is 2 to 36 months.'
const NOTHING_TO_AGREE = 'There’s nothing to agree to yet.'
const CHANGED = 'These stakes just changed. Take another look.'

function stakesRef(spaceId: string, uid: UID) {
  return doc(getFirebase().db, 'spaces', spaceId, 'stakes', uid)
}

function spaceRef(spaceId: string) {
  return doc(getFirebase().db, 'spaces', spaceId)
}

/** Live stakes docs of a space by uid, former members' included. One listener per space. */
export function startStakes(spaceId: string): Start<Record<UID, MemberStakes>> {
  return (emit) =>
    onSnapshot(
      collection(getFirebase().db, 'spaces', spaceId, 'stakes'),
      (snap) => emit({ data: Object.fromEntries(snap.docs.map((d) => [d.id, toMemberStakes(d)])), loading: false, error: null }),
      (error) => emit({ data: undefined, loading: false, error: humanError(error, MSG.noAccess) }),
    )
}

/** The doc's terms as saveMyStakes writes them (no `agreed`, no `updatedAt`). */
type StoredTerms = Omit<MemberStakes, 'uid' | 'agreed' | 'updatedAt'>

function text(v: string): string {
  const t = v.trim()
  if (t.length > MAX_TEXT) throw new Error(TOO_LONG)
  return t
}

/**
 * The terms exactly as the rules take them, for a space whose current members are `memberIds`: texts trimmed,
 * per-friend entries only for current members other than `me` (both texts in each, '' for a line that isn't
 * per friend; none at all while neither line is), tiers sorted by months. Throws the editor's messages.
 */
export function cleanStakes(input: StakesInput, me: UID, memberIds: UID[]): StoredTerms {
  const rewardMode: StakesMode = input.rewardMode === 'each' ? 'each' : 'group'
  const penaltyMode: StakesMode = input.penaltyMode === 'each' ? 'each' : 'group'
  const reward = text(input.reward)
  const penalty = text(input.penalty)
  if ((rewardMode === 'group' && reward === '') || (penaltyMode === 'group' && penalty === '')) throw new Error(FILL_GROUP)
  const per: StoredTerms['per'] = {}
  if (rewardMode === 'each' || penaltyMode === 'each') {
    for (const [friend, entry] of Object.entries(input.per)) {
      if (friend === me || !memberIds.includes(friend)) continue
      const r = rewardMode === 'each' ? text(entry.reward) : ''
      const p = penaltyMode === 'each' ? text(entry.penalty) : ''
      if (rewardMode === 'each' && r === '') throw new Error(FILL_REWARD_EACH)
      if (penaltyMode === 'each' && p === '') throw new Error(FILL_PENALTY_EACH)
      per[friend] = { reward: r, penalty: p }
    }
  }
  if (input.tiers.length > MAX_TIERS) throw new Error(TOO_MANY_TIERS)
  const tiers = input.tiers.map((t) => {
    if (!Number.isInteger(t.months) || t.months < MIN_TIER_MONTHS || t.months > MAX_TIER_MONTHS) throw new Error(TIER_RANGE)
    const reward = text(t.reward)
    if (reward === '') throw new Error(FILL_TIER)
    return { months: t.months, reward }
  })
  if (new Set(tiers.map((t) => t.months)).size !== tiers.length) throw new Error(SAME_TIER)
  tiers.sort((a, b) => a.months - b.months)
  return { rewardMode, penaltyMode, reward, penalty, per, tiers }
}

function sameStored(a: StoredTerms, b: StoredTerms): boolean {
  const perKeys = (p: StoredTerms['per']) => Object.keys(p).sort()
  return (
    a.rewardMode === b.rewardMode &&
    a.penaltyMode === b.penaltyMode &&
    a.reward === b.reward &&
    a.penalty === b.penalty &&
    JSON.stringify(perKeys(a.per)) === JSON.stringify(perKeys(b.per)) &&
    Object.keys(a.per).every((f) => a.per[f].reward === b.per[f]?.reward && a.per[f].penalty === b.per[f]?.penalty) &&
    a.tiers.length === b.tiers.length &&
    a.tiers.every((t, i) => t.months === b.tiers[i].months && t.reward === b.tiers[i].reward)
  )
}

/**
 * Saves your own stakes. Texts trimmed; per-friend entries for people no longer in the space dropped (both
 * texts kept in each entry, '' for a line that isn't per friend); tiers sorted by months. Creates the doc
 * ({…, agreed: {}}) or updates only the terms, never `agreed`; saving the terms already stored writes
 * nothing. A transaction: fails at once offline. What it means for each friend (who has to agree before it
 * counts) comes from waitingFor in domain/stakes.ts.
 */
export async function saveMyStakes(space: Space, input: StakesInput): Promise<void> {
  const me = requireUser().uid
  // The editor's messages come before anything else (the friends' list is checked again in the transaction).
  cleanStakes(input, me, space.memberIds)
  await requireServer(me)
  try {
    await runTransaction(getFirebase().db, async (tx) => {
      const spaceSnap = await tx.get(spaceRef(space.id))
      if (!spaceSnap.exists()) throw new Error(MSG.noAccess)
      const fresh = toSpace(spaceSnap)
      if (!fresh.memberIds.includes(me)) throw new Error(MSG.noAccess)
      const terms = cleanStakes(input, me, fresh.memberIds)
      const ref = stakesRef(space.id, me)
      const snap = await tx.get(ref)
      if (!snap.exists()) {
        tx.set(ref, { ...terms, agreed: {}, updatedAt: serverTimestamp() })
        return
      }
      if (sameStored(toMemberStakes(snap), terms)) return
      tx.update(ref, { ...terms, updatedAt: serverTimestamp() })
    })
  } catch (e) {
    throw humanError(e, MSG.noAccess)
  }
}

/** One agreement's fields exactly as stored (the rules compare earlier agreements and their times exactly). */
interface RawAgreement {
  at: unknown
  past: (PairTerms & { at: unknown })[]
}

function rawAgreement(snap: DocumentSnapshot, me: UID): RawAgreement | null {
  const a: unknown = snap.get(new FieldPath('agreed', me))
  if (!a || typeof a !== 'object') return null
  const { at, past } = a as { at?: unknown; past?: unknown }
  return { at, past: Array.isArray(past) ? (past as RawAgreement['past']) : [] }
}

/**
 * Agrees to `owner`'s current terms for you, exactly as you saw them (`seen`): one transaction that writes
 * `agreed.{me}` = { at: serverTimestamp(), terms, past } (nextAgreement in domain/stakes.ts; the previous
 * agreement moves into `past` with its time). It counts at once for the month in progress (SPEC §9.7);
 * agreeOutcome in domain/stakes.ts says whether it already counts or waits for others. Refused with "These
 * stakes just changed. Take another look." when the terms differ from `seen`; resolves without writing when
 * you already agreed to exactly these. Fails at once offline.
 */
export async function agreeToStakes(space: Space, owner: UID, seen: PairTerms): Promise<void> {
  const me = requireUser().uid
  if (owner === me) throw new Error(MSG.noAccess)
  await requireServer(me)
  const ref = stakesRef(space.id, owner)
  try {
    await runTransaction(getFirebase().db, async (tx) => {
      const spaceSnap = await tx.get(spaceRef(space.id))
      if (!spaceSnap.exists() || !toSpace(spaceSnap).memberIds.includes(me)) throw new Error(MSG.noAccess)
      const snap = await tx.get(ref)
      if (!snap.exists()) throw new Error(NOTHING_TO_AGREE)
      const stakes = toMemberStakes(snap)
      const terms = pairTerms(stakes, me)
      if (!terms) throw new Error(NOTHING_TO_AGREE)
      if (!sameTerms(terms, seen)) throw new Error(CHANGED)
      const current = stakes.agreed[me]
      const raw = rawAgreement(snap, me)
      // Earlier agreements go back exactly as stored: their server times have more precision than ms.
      const prev = current && raw ? { at: raw.at, terms: current.terms, past: raw.past } : null
      const next = nextAgreement<unknown>(prev, terms)
      if (!next) return
      tx.update(ref, new FieldPath('agreed', me), { at: serverTimestamp(), terms: next.terms, past: next.past })
    })
  } catch (e) {
    if (isDenied(e)) {
      // Refused because the terms changed a moment before the write: say so.
      const fresh = await getDocFromServer(ref).catch(() => null)
      const terms = fresh?.exists() ? pairTerms(toMemberStakes(fresh), me) : null
      if (!terms || !sameTerms(terms, seen)) throw new Error(CHANGED, { cause: e })
    }
    throw humanError(e, MSG.noAccess)
  }
}
