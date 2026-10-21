// Seeding for the batch-3 shared-goals e2e (SPEC §11.3), with admin rights: friend pairs (the app's invites need
// them), goals as createSharedGoal and joining leave them, and check-ins as the check-in batch writes them.
// Amounts go through toHundredths, as everywhere (a float total100 would make every later check-in fail the rules).
import { pairId } from '../../src/domain/friends.ts'
import { toHundredths } from '../../src/domain/shared.ts'
import { utcOffsetMinutes } from '../../src/domain/time.ts'
import { db, ts } from './emulator.ts'

/** Two people who are friends since `at`. */
export async function befriend(a: string, b: string, at: number): Promise<void> {
  await db.doc(`friends/${pairId(a, b)}`).set({ users: [a, b].sort(), by: a, state: 'friends', at: ts(at) })
}

export interface SeedGoal {
  name: string
  unit: string
  target: number
  /** The first is the owner (and creator, unless `createdBy`). */
  members: string[]
  invited?: string[]
  timezone: string
  /** The last day, 'YYYY-MM-DD'. */
  endsOn?: string | null
  /** Everyone's part so far (members and former members). */
  totals?: Record<string, number>
  /** When each member joined (default `createdAt`, one second apart in `members` order). */
  joinedAt?: Record<string, number>
  leftAt?: Record<string, number>
  createdBy?: string
  reachedAt?: number | null
  archivedAt?: number | null
  createdAt: number
}

/** sharedGoals/{goalId}, with the 19 keys of SPEC §11.3. */
export async function setGoal(goalId: string, g: SeedGoal): Promise<void> {
  const totals100 = Object.fromEntries(Object.entries(g.totals ?? {}).map(([uid, x]) => [uid, toHundredths(x)]))
  const total100 = Object.values(totals100).reduce((s, n) => s + n, 0)
  await db.doc(`sharedGoals/${goalId}`).set({
    name: g.name,
    unit: g.unit,
    target100: toHundredths(g.target),
    endsOn: g.endsOn ?? null,
    timezone: g.timezone,
    utcOffsetMin: utcOffsetMinutes(g.timezone, g.createdAt),
    zones: Object.fromEntries(g.members.map((uid) => [uid, g.timezone])),
    ownerId: g.members[0],
    createdBy: g.createdBy ?? g.members[0],
    memberIds: g.members,
    invited: g.invited ?? [],
    joinedAt: Object.fromEntries(g.members.map((uid, i) => [uid, ts(g.joinedAt?.[uid] ?? g.createdAt + i * 1000)])),
    leftAt: Object.fromEntries(Object.entries(g.leftAt ?? {}).map(([uid, at]) => [uid, ts(at)])),
    totals100,
    total100,
    last: null,
    reachedAt: g.reachedAt == null ? null : ts(g.reachedAt),
    archivedAt: g.archivedAt == null ? null : ts(g.archivedAt),
    createdAt: ts(g.createdAt),
  })
}

/** sharedGoals/{goalId}/checkins/{weekId}_{uid}. (Seed the goal's totals to match.) */
export async function setCheckin(goalId: string, weekId: string, uid: string, c: { amount: number; note?: string; at: number }): Promise<void> {
  await db.doc(`sharedGoals/${goalId}/checkins/${weekId}_${uid}`).set({
    uid,
    weekId,
    amount100: toHundredths(c.amount),
    note: c.note ?? '',
    at: ts(c.at),
  })
}

export interface StoredGoal {
  ownerId: string
  memberIds: string[]
  invited: string[]
  totals100: Record<string, number>
  total100: number
  target100: number
  reached: boolean
  archived: boolean
  zones: Record<string, string>
}

/** The goal as stored. */
export async function readGoal(goalId: string): Promise<StoredGoal | null> {
  const snap = await db.doc(`sharedGoals/${goalId}`).get()
  if (!snap.exists) return null
  return {
    ownerId: snap.get('ownerId') as string,
    memberIds: snap.get('memberIds') as string[],
    invited: snap.get('invited') as string[],
    totals100: snap.get('totals100') as Record<string, number>,
    total100: snap.get('total100') as number,
    target100: snap.get('target100') as number,
    reached: snap.get('reachedAt') != null,
    archived: snap.get('archivedAt') != null,
    zones: snap.get('zones') as Record<string, string>,
  }
}

/** The ids of the goals with `name` (the app makes auto ids). */
export async function goalIdsNamed(name: string): Promise<string[]> {
  const snap = await db.collection('sharedGoals').where('name', '==', name).get()
  return snap.docs.map((d) => d.id)
}

/** Whether someone's check-in for a week is stored. */
export async function hasCheckin(goalId: string, weekId: string, uid: string): Promise<boolean> {
  return (await db.doc(`sharedGoals/${goalId}/checkins/${weekId}_${uid}`).get()).exists
}
