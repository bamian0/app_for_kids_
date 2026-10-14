// On the usual times the batch-2 windows (SPEC §9.11) must be exactly the windows from before batch 2, in every
// zone: the legacy oracle (scripts/reminders-legacy-oracle.ts, a frozen copy of the old dueWindows) is swept over
// 2026–2027 at 30-minute steps, and a millisecond before each, on sampled weeks of every month.
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import type { Space } from '../src/domain/types.ts'
import { legacyDueWindows, legacyWindowsAround, type LegacyWindow } from './reminders-legacy-oracle.ts'
import { dueWindows, isOpen, windowsAround, type DueWindow } from './reminders-plan.ts'

const ZONES = [
  'Europe/Berlin',
  'America/Los_Angeles',
  'Australia/Sydney',
  'Asia/Kolkata', // +5:30
  'America/Santiago', // midnight skipped at the spring change
  'Asia/Beirut', // DST at midnight
  'Australia/Lord_Howe', // 30-minute DST
  'Pacific/Kiritimati', // +14
]
const HALF_HOUR = 1_800_000

function space(timezone: string): Space {
  return { id: 's1', name: 'Film Club', reward: 'r', penalty: 'p', ownerId: 'a', memberIds: ['a'], joinedAt: {}, timezone, inviteCode: 'ABCD2345', threshold: 90, latePenalty: 5, createdAt: 0 }
}

/** What both describe, without the batch-2 monthly part (`monthIds` names data to load, not a window). */
const shape = (w: DueWindow | LegacyWindow) => ({ kind: w.kind, period: w.period, weekIds: w.weekIds, opensAt: w.opensAt, closesAt: w.closesAt, expiresAt: w.expiresAt })

/** Sampled weeks (their Mondays): the weeks holding the 1st (the verdict, and most DST changes on a first Sunday),
 *  the 10th (the US spring change on a second Sunday) and the month's last day (European and Beirut changes on a
 *  last Sunday), every month of 2026 and 2027. */
function sampledWeeks(): string[] {
  const weeks = new Set<string>()
  for (let m = 0; m < 24; m++) {
    const first = DateTime.utc(2026, 1, 1).plus({ months: m })
    for (const day of [first, first.set({ day: 10 }), first.endOf('month').startOf('day')]) weeks.add(day.minus({ days: day.weekday - 1 }).toISODate()!)
  }
  return [...weeks].sort()
}

describe('legacy oracle sweep', () => {
  it('gives exactly the windows from before batch 2 on the usual times, 2026–2027, in 8 zones', () => {
    const started = performance.now()
    let checks = 0
    const mismatches: string[] = []
    for (const zone of ZONES) {
      const s = space(zone)
      for (const weekId of sampledWeeks()) {
        const monday = DateTime.fromISO(weekId, { zone })
        const start = monday.startOf('day').toMillis()
        const end = monday.plus({ days: 7 }).startOf('day').toMillis()
        // The windows depend on the moment only through its week and its month: compute them once for each month
        // the week touches (the second one starts at `turn`).
        const turn = DateTime.fromMillis(end - 1, { zone }).startOf('month').toMillis()
        const cache = new Map<boolean, { now: DueWindow[]; old: LegacyWindow[] }>()
        const around = (t: number) => {
          const key = t >= turn
          let hit = cache.get(key)
          if (!hit) {
            hit = { now: windowsAround(s, t), old: legacyWindowsAround(zone, t) }
            cache.set(key, hit)
          }
          return hit
        }
        // Every half hour of the week (UTC half hours are local half hours in all of these zones) and 1 ms before.
        for (let t = Math.ceil(start / HALF_HOUR) * HALF_HOUR; t < end; t += HALF_HOUR) {
          for (const probe of [t - 1, t]) {
            if (probe < start) continue
            const { now, old } = around(probe)
            const got = now.filter((w) => isOpen(w, probe)).map(shape)
            const want = old.filter((w) => w.opensAt <= probe && probe < w.closesAt).map(shape)
            checks += 1
            if (JSON.stringify(got) !== JSON.stringify(want)) mismatches.push(`${zone} ${new Date(probe).toISOString()}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`)
          }
        }
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([])
    expect(checks).toBeGreaterThan(200_000)
    // Recorded so a slow-down shows: well under the 5 s the plan allows.
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  it('agrees with the oracle’s own filter at the edges it was written for', () => {
    // dueWindows is windowsAround filtered: spot checks straight through both public functions.
    for (const iso of ['2026-10-12T16:00:00Z', '2026-10-16T07:00:00Z', '2026-10-16T18:00:00Z', '2026-10-17T07:00:00Z', '2026-11-01T09:00:00Z', '2027-01-01T09:30:00Z']) {
      const t = Date.parse(iso)
      expect(dueWindows(space('Europe/Berlin'), t).map(shape)).toEqual(legacyDueWindows('Europe/Berlin', t).map(shape))
    }
  })
})
