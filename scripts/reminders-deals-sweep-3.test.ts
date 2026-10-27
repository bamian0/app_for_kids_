// The pre-deals oracle sweep (SPEC §12.15), zones 5–6 of 8: see scripts/reminders-deals-sweep.ts (split over four
// files so they run in parallel).
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { memoizeFormatToParts } from './reminders-deals-sweep-memo.ts'
import { sweepOctober, SWEEP_ZONES } from './reminders-deals-sweep.ts'

// A speed-up only: the oracle and the planner both use these pure time functions, memoized.
vi.mock(import('../src/domain/time.ts'), async (importOriginal) => (await import('./reminders-deals-sweep-memo.ts')).memoTime(await importOriginal()))

let restore = () => {}
beforeAll(() => {
  restore = memoizeFormatToParts()
})
afterAll(() => restore())

const zones = SWEEP_ZONES.slice(4, 6)

it(`decides what the pre-deals planner decided, every hour of October 2026: ${zones.join(', ')}`, () => {
  const { mismatches, checks, decided, dealEntries } = sweepOctober(zones)
  expect(mismatches.slice(0, 5)).toEqual([])
  expect(checks).toBe(zones.length * (744 * 3 + 186 * 3))
  expect(decided).toBeGreaterThan(500)
  expect(dealEntries).toBeGreaterThan(0)
}, 180_000)
