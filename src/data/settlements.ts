// Honor-system "Settled" toggles: per pair since batch 2 (SPEC §9.7), per member per month before.
import { collection, doc, onSnapshot, query, serverTimestamp, setDoc, where } from 'firebase/firestore'
import { settlementDocId } from '../domain/ids.ts'
import type { MonthId, Settlement, SettlementKey, UID } from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import { toSettlement } from './convert.ts'
import { humanError, MSG } from './errors.ts'
import { requireUser } from './session.ts'
import type { Start } from './store.ts'

/** One month's settlements (old per-member docs and per-pair docs), or without `monthId` every one ever written (deprecated). */
export function startSettlements(spaceId: string, monthId?: MonthId): Start<Settlement[]> {
  const all = collection(getFirebase().db, 'spaces', spaceId, 'settlements')
  return (emit) =>
    onSnapshot(
      monthId === undefined ? all : query(all, where('monthId', '==', monthId)),
      (snap) => emit({ data: snap.docs.map(toSettlement), loading: false, error: null }),
      (error) => emit({ data: undefined, loading: false, error: humanError(error, MSG.noAccess) }),
    )
}

/** @deprecated Writes the per-member shape from before batch 2. Use settlePairs. */
export async function setSettled(spaceId: string, monthId: MonthId, uid: UID, settled: boolean): Promise<void> {
  const me = requireUser().uid
  const ref = doc(getFirebase().db, 'spaces', spaceId, 'settlements', settlementDocId(monthId, uid))
  try {
    await setDoc(ref, { monthId, uid, settled, settledBy: me, settledAt: serverTimestamp() })
  } catch (e) {
    throw humanError(e, MSG.noAccess)
  }
}

/**
 * Marks every pair of one debt line settled (or not) in one batch: a group line is one tap. Each doc is
 * { monthId, uid, other, settled, settledBy: me, settledAt } plus `tier` for a streak reward, at
 * settlementDocId(monthId, uid, other, tier). Queues offline like any batch (the toggle shows at once).
 */
export async function settlePairs(spaceId: string, monthId: MonthId, keys: SettlementKey[], settled: boolean): Promise<void> {
  void spaceId
  void monthId
  void keys
  void settled
  // batch2: TODO
  throw new Error('not implemented: settlePairs')
}
