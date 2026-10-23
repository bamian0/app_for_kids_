// Firestore documents -> domain types. Timestamps become epoch ms; a pending serverTimestamp()
// reads as the SDK's local estimate, so optimistic writes render immediately.
import { Timestamp, type DocumentData, type DocumentSnapshot, type QueryDocumentSnapshot } from 'firebase/firestore'
import {
  decodeCheckin,
  decodeDeal,
  decodeFriendship,
  decodeMemberStakes,
  decodeMonthResults,
  decodeRing,
  decodeSharedGoal,
  decodeShowcase,
  decodeSpaceExtras,
  decodeStats,
  decodeWeekExtras,
  isReviewMark,
} from '../domain/decode.ts'
import type {
  Checkin,
  Deal,
  Earning,
  Friendship,
  Goal,
  Invite,
  Mark,
  MemberStakes,
  MoneyMove,
  MoneyState,
  MonthlyList,
  MonthResults,
  MonthStakes,
  Plan,
  Progress,
  Review,
  ReviewMark,
  Ring,
  Settlement,
  SharedGoal,
  Showcase,
  Space,
  UID,
  UserProfile,
  UserStats,
  Week,
} from '../domain/types.ts'
import { decodeTasks } from './tasks.ts'

type Snap = DocumentSnapshot | QueryDocumentSnapshot

export function ms(value: unknown): number {
  return value instanceof Timestamp ? value.toMillis() : typeof value === 'number' ? value : 0
}

function data(snap: Snap): DocumentData {
  return snap.data({ serverTimestamps: 'estimate' }) ?? {}
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

/** The rules' limit for users/{uid}.photo (SPEC §7.3). */
export const MAX_PHOTO_CHARS = 60_000
const PHOTO = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/

/** A profile photo as the rules accept it: a small inline JPEG, never a link that could track viewers. */
export function isProfilePhoto(v: unknown): v is string {
  return typeof v === 'string' && v.length <= MAX_PHOTO_CHARS && PHOTO.test(v)
}

export function toProfile(snap: Snap): UserProfile {
  const d = data(snap)
  const profile: UserProfile = { uid: snap.id, name: str(d.name), color: str(d.color), createdAt: ms(d.createdAt) }
  // Checked here too, so nothing the rules wouldn't take (a doc written before them) reaches an <img>.
  if (isProfilePhoto(d.photo)) profile.photo = d.photo
  return profile
}

function times(v: unknown): Record<UID, number> {
  const out: Record<UID, number> = {}
  for (const [uid, at] of Object.entries(record(v))) out[uid] = ms(at)
  return out
}

export function toSpace(snap: Snap): Space {
  const d = data(snap)
  const space: Space = {
    id: snap.id,
    name: str(d.name),
    reward: str(d.reward),
    penalty: str(d.penalty),
    ownerId: str(d.ownerId),
    memberIds: strings(d.memberIds),
    joinedAt: times(d.joinedAt),
    timezone: str(d.timezone) || 'UTC',
    inviteCode: str(d.inviteCode),
    threshold: typeof d.threshold === 'number' ? d.threshold : 90,
    latePenalty: typeof d.latePenalty === 'number' ? d.latePenalty : 5,
    createdAt: ms(d.createdAt),
  }
  if (typeof d.utcOffsetMin === 'number') space.utcOffsetMin = d.utcOffsetMin
  if (d.leftAt && typeof d.leftAt === 'object') space.leftAt = times(d.leftAt)
  // Batch 2 (SPEC §9.2–§9.7): only the valid fields; a malformed one reads as absent ("as before").
  return Object.assign(space, decodeSpaceExtras(d, msOrNull))
}

export function toInvite(snap: Snap): Invite {
  const d = data(snap)
  return {
    code: snap.id,
    spaceId: str(d.spaceId),
    spaceName: str(d.spaceName),
    reward: str(d.reward),
    penalty: str(d.penalty),
    inviterName: str(d.inviterName),
    createdBy: str(d.createdBy),
    createdAt: ms(d.createdAt),
  }
}

export function toWeek(snap: Snap, spaceId: string): Week {
  const d = data(snap)
  const week: Week = {
    id: snap.id,
    spaceId,
    startAt: ms(d.startAt),
    lockAt: ms(d.lockAt),
    reviewOpenAt: ms(d.reviewOpenAt),
    deadlineAt: ms(d.deadlineAt),
    members: strings(d.members),
    submittedBy: strings(d.submittedBy),
  }
  // Batch 2 (SPEC §9.2, §9.4): the schedule its bounds follow and its judges snapshot, when valid.
  return Object.assign(week, decodeWeekExtras(d))
}

/** spaces/{id}/monthly/{monthId}: a week-shaped doc whose id is the MonthId (SPEC §9.5). */
export function toMonthly(snap: Snap, spaceId: string): MonthlyList {
  const list = toWeek(snap, spaceId)
  // A list never follows a schedule of its own (its bounds are its weeks').
  delete list.schedule
  return list
}

/** A stored time, or null for anything else (a missing earnedAt, a malformed added entry). */
function msOrNull(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : typeof value === 'number' ? value : null
}

/** A plan with its tasks' add times and cross-outs (SPEC §6.2, §10.3); a pending cross-out reads with the SDK's estimate. */
export function toPlan(snap: Snap): Plan {
  const d = data(snap)
  return { uid: snap.id, tasks: decodeTasks(d.tasks, d.added, msOrNull, d.cancels), updatedAt: ms(d.updatedAt) }
}

export function toProgress(snap: Snap): Progress {
  const d = data(snap)
  const done: Record<string, boolean> = {}
  for (const [taskId, value] of Object.entries(record(d.done))) done[taskId] = value === true
  return { uid: snap.id, done, updatedAt: ms(d.updatedAt) }
}

export function isMark(v: unknown): v is Mark {
  return v === 0 || v === 0.5 || v === 1
}

/** A review's marks: Done, Half, Not done and, since batch 2.5, the fair vote ('fair', SPEC §10.4); anything else is dropped. */
export function toReview(snap: Snap): Review {
  const d = data(snap)
  const marks: Record<string, ReviewMark> = {}
  for (const [taskId, value] of Object.entries(record(d.marks))) if (isReviewMark(value)) marks[taskId] = value
  return { id: snap.id, reviewerId: str(d.reviewerId), revieweeId: str(d.revieweeId), marks, submittedAt: ms(d.submittedAt) }
}

export function toSettlement(snap: Snap): Settlement {
  const d = data(snap)
  const settlement: Settlement = {
    id: snap.id,
    monthId: str(d.monthId),
    uid: str(d.uid),
    settled: d.settled === true,
    settledBy: str(d.settledBy),
    settledAt: ms(d.settledAt),
  }
  // The pair and streak shapes (SPEC §9.7); a legacy per-member doc has neither.
  if (typeof d.other === 'string' && d.other !== '') {
    settlement.other = d.other
    if (Number.isInteger(d.tier) && d.tier >= 2 && d.tier <= 36) settlement.tier = d.tier
  }
  return settlement
}

/** A frozen month (spaces/{id}/months/{monthId}), with when it was frozen (monthHouse decides whether it binds). */
export function toMonthStakes(snap: Snap): MonthStakes {
  const d = data(snap)
  const stakes: MonthStakes = { reward: str(d.reward), penalty: str(d.penalty), frozen: true }
  const createdAt = msOrNull(d.createdAt)
  if (createdAt !== null && createdAt > 0) stakes.createdAt = createdAt
  return stakes
}

/** spaces/{id}/stakes/{uid}: a member's own stakes and their friends' agreements (SPEC §9.7). */
export function toMemberStakes(snap: Snap): MemberStakes {
  return decodeMemberStakes(snap.id, data(snap), msOrNull)
}

/** spaces/{id}/results/{monthId} (SPEC §9.8); null when it isn't a valid results doc. */
export function toMonthResults(snap: Snap): MonthResults | null {
  return snap.exists() ? decodeMonthResults(data(snap), msOrNull, snap.id) : null
}

// ---------- Money (users/{uid}/...) ----------

const amount = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function toMoneyState(snap: Snap): MoneyState {
  const d = data(snap)
  return {
    currency: str(d.currency) || 'USD',
    baseline: typeof d.baseline === 'number' && Number.isFinite(d.baseline) ? d.baseline : null,
    baselineAt: msOrNull(d.baselineAt),
    updatedAt: ms(d.updatedAt),
  }
}

export function toEarning(snap: Snap): Earning {
  const d = data(snap)
  return {
    id: snap.id,
    spaceId: str(d.spaceId),
    weekId: str(d.weekId),
    taskId: str(d.taskId),
    title: str(d.title),
    amount: amount(d.amount),
    earnedAt: msOrNull(d.earnedAt),
    updatedAt: ms(d.updatedAt),
  }
}

export function toMove(snap: Snap): MoneyMove {
  const d = data(snap)
  const move: MoneyMove = { id: snap.id, kind: d.kind === 'spend' ? 'spend' : 'add', amount: amount(d.amount), note: str(d.note), at: ms(d.at) }
  if (d.goal === true) move.goal = true
  return move
}

export function toGoal(snap: Snap): Goal {
  const d = data(snap)
  return { id: snap.id, name: str(d.name), cost: amount(d.cost), order: amount(d.order), createdAt: ms(d.createdAt) }
}

// ---------- Batch 3 (SPEC §11.3): through the shared decoders, which drop what the rules would never have written ----------

/** friends/{pairId} as seen by `me`; null when malformed (or not a pair of mine). */
export function toFriendship(snap: Snap, me: UID): Friendship | null {
  return decodeFriendship(snap.id, data(snap), me, msOrNull)
}

/** showcases/{uid}; null without a doc (DEFAULT_SHOW, no items). */
export function toShowcase(snap: Snap): Showcase | null {
  return snap.exists() ? decodeShowcase(snap.id, data(snap), msOrNull) : null
}

/** rings/{uid}; null without a doc. */
export function toRing(snap: Snap): Ring | null {
  return snap.exists() ? decodeRing(snap.id, data(snap), msOrNull) : null
}

/** stats/{uid}; null without a doc. */
export function toStats(snap: Snap): UserStats | null {
  return snap.exists() ? decodeStats(snap.id, data(snap), msOrNull) : null
}

/** sharedGoals/{goalId} in real units; null without a doc or when malformed. */
export function toSharedGoal(snap: Snap): SharedGoal | null {
  return snap.exists() ? decodeSharedGoal(snap.id, data(snap), msOrNull) : null
}

/** sharedGoals/{goalId}/checkins/{weekId}_{uid} in real units; null when malformed. */
export function toCheckin(snap: Snap): Checkin | null {
  return snap.exists() ? decodeCheckin(snap.id, data(snap), msOrNull) : null
}

// ---------- Deals (SPEC §12.4) ----------

/** spaces/{spaceId}/deals/{uid}_{seq}, through the shared decoder (server timestamps as the SDK's estimate); null
 *  when it can't be a deal. */
export function toDeal(snap: Snap, spaceId: string): Deal | null {
  return snap.exists() ? decodeDeal(snap.id, data(snap), spaceId, msOrNull) : null
}
