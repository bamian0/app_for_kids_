// Firestore documents -> domain types. Timestamps become epoch ms; a pending serverTimestamp()
// reads as the SDK's local estimate, so optimistic writes render immediately.
import { Timestamp, type DocumentData, type DocumentSnapshot, type QueryDocumentSnapshot } from 'firebase/firestore'
import type { Invite, Mark, MonthStakes, Plan, Progress, Review, Settlement, Space, Task, UID, UserProfile, Week } from '../domain/types.ts'

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

export function toProfile(snap: Snap): UserProfile {
  const d = data(snap)
  return { uid: snap.id, name: str(d.name), color: str(d.color), createdAt: ms(d.createdAt) }
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
  return space
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
  return {
    id: snap.id,
    spaceId,
    startAt: ms(d.startAt),
    lockAt: ms(d.lockAt),
    reviewOpenAt: ms(d.reviewOpenAt),
    deadlineAt: ms(d.deadlineAt),
    members: strings(d.members),
    submittedBy: strings(d.submittedBy),
  }
}

export function toPlan(snap: Snap): Plan {
  const d = data(snap)
  const tasks: Task[] = Array.isArray(d.tasks)
    ? d.tasks.map((t: unknown) => ({ id: str(record(t).id), title: str(record(t).title) })).filter((t: Task) => t.id !== '')
    : []
  return { uid: snap.id, tasks, updatedAt: ms(d.updatedAt) }
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

export function toReview(snap: Snap): Review {
  const d = data(snap)
  const marks: Record<string, Mark> = {}
  for (const [taskId, value] of Object.entries(record(d.marks))) if (isMark(value)) marks[taskId] = value
  return { id: snap.id, reviewerId: str(d.reviewerId), revieweeId: str(d.revieweeId), marks, submittedAt: ms(d.submittedAt) }
}

export function toSettlement(snap: Snap): Settlement {
  const d = data(snap)
  return {
    id: snap.id,
    monthId: str(d.monthId),
    uid: str(d.uid),
    settled: d.settled === true,
    settledBy: str(d.settledBy),
    settledAt: ms(d.settledAt),
  }
}

/** A frozen month (spaces/{id}/months/{monthId}). */
export function toMonthStakes(snap: Snap): MonthStakes {
  const d = data(snap)
  return { reward: str(d.reward), penalty: str(d.penalty), frozen: true }
}
