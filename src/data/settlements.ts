// Honor-system "Settled" toggles: per pair since batch 2 (SPEC §9.7), per member per month before.
import { collection, doc, onSnapshot, query, serverTimestamp, where, writeBatch } from 'firebase/firestore'
import { settlementDocId } from '../domain/ids.ts'
import type { MonthId, Settlement, SettlementKey } from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import { toSettlement } from './convert.ts'
import { humanError, MSG } from './errors.ts'
import { requireUser } from './session.ts'
import type { Start } from './store.ts'

/** One month's settlements: old per-member docs and per-pair docs. */
export function startSettlements(spaceId: string, monthId: MonthId): Start<Settlement[]> {
  const month = query(collection(getFirebase().db, 'spaces', spaceId, 'settlements'), where('monthId', '==', monthId))
  return (emit) =>
    onSnapshot(
      month,
      (snap) => emit({ data: snap.docs.map(toSettlement), loading: false, error: null }),
      (error) => emit({ data: undefined, loading: false, error: humanError(error, MSG.noAccess) }),
    )
}

/**
 * Marks every pair of one debt line settled (or not) in one batch: a group line is one tap. Each doc is
 * { monthId, uid, other, settled, settledBy: me, settledAt } plus `tier` for a streak reward, at
 * settlementDocId(monthId, uid, other, tier). Queues offline like any batch (the toggle shows at once).
 */
export async function settlePairs(spaceId: string, monthId: MonthId, keys: SettlementKey[], settled: boolean): Promise<void> {
  const me = requireUser().uid
  if (keys.length === 0) return
  const { db } = getFirebase()
  const batch = writeBatch(db)
  for (const { uid, other, tier } of keys) {
    const data: Record<string, unknown> = { monthId, uid, other, settled, settledBy: me, settledAt: serverTimestamp() }
    if (tier !== undefined) data.tier = tier
    batch.set(doc(db, 'spaces', spaceId, 'settlements', settlementDocId(monthId, uid, other, tier)), data)
  }
  try {
    await batch.commit()
  } catch (e) {
    throw humanError(e, MSG.noAccess)
  }
}
