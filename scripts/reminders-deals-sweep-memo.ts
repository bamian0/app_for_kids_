// Test-only speed-ups for the pre-deals oracle sweep (scripts/reminders-deals-sweep-*.test.ts). It has no runtime
// imports, so a `vi.mock` factory of src/domain/time.ts can load it without importing the module it replaces.
import type * as Time from '../src/domain/time.ts'

/**
 * src/domain/time.ts with its pure functions of a week and a zone (`momentAt`, `weekBounds`) memoized: the oracle and
 * the planner both import them, and the sweep asks for the same weeks every hour. Bounds are copied out, so nothing can
 * change a cached one.
 */
export function memoTime(mod: typeof Time): typeof Time {
  const moments = new Map<string, number>()
  const bounds = new Map<string, ReturnType<typeof Time.weekBounds>>()
  return {
    ...mod,
    momentAt(weekId, tz, minutes) {
      const key = `${weekId}|${tz}|${minutes}`
      let v = moments.get(key)
      if (v === undefined) moments.set(key, (v = mod.momentAt(weekId, tz, minutes)))
      return v
    },
    weekBounds(weekId, tz, schedule) {
      const key = `${weekId}|${tz}|${JSON.stringify(schedule ?? null)}`
      let v = bounds.get(key)
      if (v === undefined) bounds.set(key, (v = mod.weekBounds(weekId, tz, schedule)))
      return { ...v }
    },
  }
}

/**
 * Intl.DateTimeFormat#formatToParts memoized per formatter and instant (a pure function of both; luxon calls it for
 * every zone offset). Each call gets its own copy of the parts. Returns the function that puts the original back.
 */
export function memoizeFormatToParts(): () => void {
  const proto = Intl.DateTimeFormat.prototype
  const original = proto.formatToParts
  const memo = new WeakMap<Intl.DateTimeFormat, Map<number, Intl.DateTimeFormatPart[]>>()
  proto.formatToParts = function (this: Intl.DateTimeFormat, date?: Date | number) {
    const ms = date === undefined ? Date.now() : +date
    let byMs = memo.get(this)
    if (!byMs) memo.set(this, (byMs = new Map()))
    let parts = byMs.get(ms)
    if (!parts) byMs.set(ms, (parts = original.call(this, date)))
    return parts.map((p) => ({ ...p }))
  }
  return () => {
    proto.formatToParts = original
  }
}
