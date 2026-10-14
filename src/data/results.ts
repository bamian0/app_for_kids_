// Month results and streaks (SPEC §9.8): written once per month by the reminders job (admin), read only here.
import { collection, doc, limit, onSnapshot, orderBy, query } from 'firebase/firestore'
import type { MonthId, MonthResults } from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import { toMonthResults } from './convert.ts'
import { humanError, MSG } from './errors.ts'
import type { Start } from './store.ts'

function resultsCollection(spaceId: string) {
  return collection(getFirebase().db, 'spaces', spaceId, 'results')
}

/** spaces/{id}/results/{monthId}; null until the job has written it. */
export function startResults(spaceId: string, monthId: MonthId): Start<MonthResults | null> {
  return (emit) =>
    onSnapshot(
      doc(resultsCollection(spaceId), monthId),
      (snap) => emit({ data: toMonthResults(snap), loading: false, error: null }),
      (error) => emit({ data: undefined, loading: false, error: humanError(error, MSG.noAccess) }),
    )
}

/** The newest results doc of a space (orderBy monthId desc, limit 1); null when there is none. */
export function startLatestResults(spaceId: string): Start<MonthResults | null> {
  return (emit) =>
    onSnapshot(
      query(resultsCollection(spaceId), orderBy('monthId', 'desc'), limit(1)),
      (snap) => emit({ data: snap.docs.length > 0 ? toMonthResults(snap.docs[0]) : null, loading: false, error: null }),
      (error) => emit({ data: undefined, loading: false, error: humanError(error, MSG.noAccess) }),
    )
}
