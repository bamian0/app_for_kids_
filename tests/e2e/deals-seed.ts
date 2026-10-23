// Seeding deals for the end-to-end specs (SPEC §12.4): the exact shape proposeDeal writes, plus the fields only
// the reminders job writes (agreedAt, start, track, ended won/lost/off, checkedAt), with admin rights. Times are
// milliseconds here and Timestamps in the doc, as the job writes them.
import { db, ts } from './emulator.ts'

export interface SeedDealMark {
  settled: boolean
  by: string
  at: number
}

export interface SeedPeriod {
  id: string
  result: 'pass' | 'miss' | 'skip'
  score: number | null
  missed?: number
  why?: string
}

export interface SeedDeal {
  uid: string
  seq: number
  unit: 'week' | 'month'
  count: number
  rewardMode?: 'group' | 'each'
  penaltyMode?: 'group' | 'each'
  reward?: string
  penalty?: string
  per?: Record<string, { reward: string; penalty: string }>
  /** Every member but `uid` who doesn't judge, when proposed. */
  friends: string[]
  agreed?: Record<string, number>
  off?: Record<string, number>
  settled?: Record<string, SeedDealMark>
  createdAt: number
  ended?:
    | null
    | { outcome: 'withdrawn'; at: number; by: string }
    | { outcome: 'won' | 'lost' | 'off'; at: number; period?: string; score?: number | null; reason?: 'called-off' | 'alone' }
  // The reminders job's fields.
  agreedAt?: number
  start?: string
  track?: SeedPeriod[]
  checkedAt?: number
}

export const dealDocId = (uid: string, seq: number) => `${uid}_${seq}`
export const dealDoc = (spaceId: string, id: string) => db.doc(`spaces/${spaceId}/deals/${id}`)

const times = (m: Record<string, number> | undefined) => Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k, ts(v)]))

/** Writes spaces/{spaceId}/deals/{uid}_{seq} and marks the space `hasDeals`, as the first proposal does. */
export async function setDeal(spaceId: string, d: SeedDeal): Promise<string> {
  const id = dealDocId(d.uid, d.seq)
  const rewardMode = d.rewardMode ?? 'group'
  const penaltyMode = d.penaltyMode ?? 'group'
  const doc: Record<string, unknown> = {
    uid: d.uid,
    seq: d.seq,
    unit: d.unit,
    count: d.count,
    rewardMode,
    penaltyMode,
    reward: d.reward ?? '',
    penalty: d.penalty ?? '',
    per: d.per ?? {},
    friends: d.friends,
    agreed: times(d.agreed),
    off: times(d.off),
    settled: Object.fromEntries(Object.entries(d.settled ?? {}).map(([k, m]) => [k, { settled: m.settled, by: m.by, at: ts(m.at) }])),
    createdAt: ts(d.createdAt),
    ended: d.ended ? { ...d.ended, at: ts(d.ended.at) } : null,
  }
  if (d.agreedAt !== undefined) doc.agreedAt = ts(d.agreedAt)
  if (d.start !== undefined) doc.start = d.start
  if (d.track !== undefined) doc.track = d.track
  if (d.checkedAt !== undefined) doc.checkedAt = ts(d.checkedAt)
  await dealDoc(spaceId, id).set(doc)
  await db.doc(`spaces/${spaceId}`).update({ hasDeals: true })
  return id
}

/** A deal doc as stored (null when missing). */
export async function readDeal(spaceId: string, id: string): Promise<Record<string, unknown> | null> {
  const snap = await dealDoc(spaceId, id).get()
  return snap.exists ? (snap.data() ?? null) : null
}

/** The cutover month the reminders job records (public/config.dealsFrom, SPEC §12.3). */
export async function setDealsFrom(monthId: string | null): Promise<void> {
  const ref = db.doc('public/config')
  if (monthId === null) await ref.set({}, { merge: false })
  else await ref.set({ dealsFrom: monthId }, { merge: true })
}
