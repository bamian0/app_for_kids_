// Honor-system "Settled" toggles, one per member per month.
import { collection, doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore'
import { settlementDocId } from '../domain/ids.ts'
import type { MonthId, Settlement, UID } from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import { toSettlement } from './convert.ts'
import { humanError, MSG } from './errors.ts'
import { requireUser } from './session.ts'
import type { Start } from './store.ts'

export function startSettlements(spaceId: string): Start<Settlement[]> {
  return (emit) =>
    onSnapshot(
      collection(getFirebase().db, 'spaces', spaceId, 'settlements'),
      (snap) => emit({ data: snap.docs.map(toSettlement), loading: false, error: null }),
      (error) => emit({ data: undefined, loading: false, error: humanError(error, MSG.noAccess) }),
    )
}

export async function setSettled(spaceId: string, monthId: MonthId, uid: UID, settled: boolean): Promise<void> {
  const me = requireUser().uid
  const ref = doc(getFirebase().db, 'spaces', spaceId, 'settlements', settlementDocId(monthId, uid))
  try {
    await setDoc(ref, { monthId, uid, settled, settledBy: me, settledAt: serverTimestamp() })
  } catch (e) {
    throw humanError(e, MSG.noAccess)
  }
}
