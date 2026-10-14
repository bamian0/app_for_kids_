// Month results and streaks (SPEC §9.8): written once per month by the reminders job (admin), read only here.
import type { MonthId, MonthResults } from '../domain/types.ts'
import type { Start } from './store.ts'

/** spaces/{id}/results/{monthId}; null until the job has written it. */
export function startResults(spaceId: string, monthId: MonthId): Start<MonthResults | null> {
  void spaceId
  void monthId
  // batch2: TODO (until built: no results yet)
  return (emit) => {
    emit({ data: null, loading: false, error: null })
    return () => {}
  }
}

/** The newest results doc of a space (orderBy monthId desc, limit 1); null when there is none. */
export function startLatestResults(spaceId: string): Start<MonthResults | null> {
  void spaceId
  // batch2: TODO (until built: no results yet)
  return (emit) => {
    emit({ data: null, loading: false, error: null })
    return () => {}
  }
}
