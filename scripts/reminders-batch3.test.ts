// Batch 3 in the reminders planner (SPEC §11.10): the scores writer's pure parts and the shared goals' `checkin` push.
// The windows are swept over 2026–2027 for every pair (goal zone, member zone) of the 8 test zones; the existing
// windows are untouched (reminders-oracle.test.ts and the batch-2/2.5 planner tests still pass unchanged).
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import type { MemberMonthResult } from '../src/domain/scoring.ts'
import { momentAt, utcOffsetMinutes, WEEK_MINUTES } from '../src/domain/time.ts'
import type { Checkin, SharedGoal, Space, Week } from '../src/domain/types.ts'
import {
  CHECKIN_LEAD_MS,
  checkinCandidates,
  checkinGateOpen,
  checkinKey,
  checkinWindow,
  memberZone,
  planShared,
  scoreEntries,
  SCORES_PER_RUN,
  SCORES_PER_SPACE,
  scoresKey,
  scoresTarget,
  statsKey,
} from './reminders-plan.ts'

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
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const HALF_HOUR = 30 * MINUTE
const at = (iso: string) => Date.parse(iso)

function goalIn(timezone: string, extra: Partial<SharedGoal> = {}): SharedGoal {
  return {
    id: 'g1',
    name: 'Run 100 km',
    unit: 'km',
    target: 100,
    endsOn: null,
    timezone,
    utcOffsetMin: Math.round(utcOffsetMinutes(timezone, at('2026-10-01T00:00:00Z'))),
    zones: {},
    ownerId: 'a',
    createdBy: 'a',
    memberIds: ['a'],
    invited: [],
    joinedAt: { a: 0 },
    leftAt: {},
    totals: {},
    total: 0,
    last: null,
    reachedAt: null,
    archivedAt: null,
    createdAt: 0,
    ...extra,
  }
}

/** Every Monday of 2026 and 2027. */
function mondays(): string[] {
  const out: string[] = []
  for (let d = DateTime.utc(2026, 1, 5); d.year < 2028; d = d.plus({ weeks: 1 })) out.push(d.toISODate()!)
  return out
}

/** The wall clock of `ms` in `zone`, in ms since 1970 on a clock without DST (so a difference is wall time). */
function wallMs(ms: number, zone: string): number {
  const d = DateTime.fromMillis(ms, { zone })
  return Date.UTC(d.year, d.month - 1, d.day, d.hour, d.minute, d.second, d.millisecond)
}

/** How long [opensAt, closesAt) is on the wall clock, in minutes, up to its last instant (so a window that ends where
 *  midnight is skipped, at 01:00, still reads as ending at 24:00). */
function wallLength(opensAt: number, closesAt: number, zone: string): number {
  return Math.round((wallMs(closesAt - 1, zone) + 1 - wallMs(opensAt, zone)) / MINUTE)
}

/** Goal weeks (Mondays) in which one of the zones changes its offset, between the Monday and the next Monday noon. */
function dstWeeks(zones: string[]): string[] {
  return mondays().filter((monday) => {
    const from = at(`${monday}T00:00:00Z`) - 14 * HOUR
    const to = from + 7 * 24 * HOUR + 26 * HOUR
    return zones.some((zone) => utcOffsetMinutes(zone, from) !== utcOffsetMinutes(zone, to))
  })
}

describe('the check-in window (SPEC §11.10)', () => {
  it('one window per member per week, 4–6 hours of their clock, never in their night, at the end of the goal’s week: every pair of zones, 2026–2027', () => {
    const started = performance.now()
    const failures: string[] = []
    let windows = 0
    let steps = 0
    let maxLead = 0
    for (const goalZone of ZONES) {
      const goal = goalIn(goalZone)
      for (const zone of ZONES) {
        let previous = -Infinity
        for (const weekId of mondays()) {
          const tag = `goal ${goalZone}, member ${zone}, week ${weekId}`
          const start = momentAt(weekId, goalZone, 0)
          const end = momentAt(weekId, goalZone, WEEK_MINUTES)
          const w = checkinWindow(goal, weekId, zone)
          if (!w) {
            failures.push(`${tag}: no window`)
            continue
          }
          windows += 1
          // Inside the goal's week, within its last 18 hours, and after last week's (so one per week).
          if (w.opensAt < start || w.closesAt > end || w.opensAt <= previous) failures.push(`${tag}: outside its week`)
          previous = w.closesAt
          maxLead = Math.max(maxLead, end - w.opensAt)
          if (end - w.opensAt > CHECKIN_LEAD_MS) failures.push(`${tag}: opens ${(end - w.opensAt) / HOUR} h before the week ends`)
          // 4–6 hours of their wall clock.
          const wall = wallLength(w.opensAt, w.closesAt, zone)
          if (wall < 240 || wall > 360) failures.push(`${tag}: ${wall} minutes on their clock`)
          // Never inside their 00:00–08:00: its first instant and every half hour in it.
          for (let t = w.opensAt; t < w.closesAt; t = Math.floor(t / HALF_HOUR) * HALF_HOUR + HALF_HOUR) {
            steps += 1
            if (DateTime.fromMillis(t, { zone }).hour < 8) failures.push(`${tag}: open at ${DateTime.fromMillis(t, { zone }).toISO()}`)
          }
          // In the goal's zone: Sunday 18:00 → Monday 00:00, as the other evening nudges.
          if (zone === goalZone) {
            const o = DateTime.fromMillis(w.opensAt, { zone })
            if (o.weekday !== 7 || o.hour !== 18 || o.minute !== 0 || w.closesAt !== end) failures.push(`${tag}: ${o.toISO()} → ${new Date(w.closesAt).toISOString()}`)
          }
          // The job's UTC gate is open for all of it.
          if (!checkinGateOpen(w.opensAt) || !checkinGateOpen(w.closesAt - 1)) failures.push(`${tag}: outside the UTC gate`)
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([])
    expect(windows).toBe(ZONES.length * ZONES.length * mondays().length)
    expect(steps).toBeGreaterThan(50_000)
    expect(maxLead).toBeLessThanOrEqual(CHECKIN_LEAD_MS)
    // Recorded so a slow-down shows.
    expect(performance.now() - started).toBeLessThan(20_000)
  }, 60_000)

  it('the members whose window is open, at every half hour of each week’s last 20 hours, around every DST change of 2026–2027', () => {
    const uids = ZONES.map((_, i) => `m${i}`)
    const zones = Object.fromEntries(uids.map((uid, i) => [uid, ZONES[i]]))
    const weeks = dstWeeks(ZONES)
    expect(weeks.length).toBeGreaterThan(10)
    const failures: string[] = []
    let probes = 0
    for (const goalZone of ZONES) {
      const goal = goalIn(goalZone, { memberIds: uids, zones, joinedAt: Object.fromEntries(uids.map((u) => [u, 0])) })
      for (const weekId of weeks) {
        const end = momentAt(weekId, goalZone, WEEK_MINUTES)
        const windows = uids.map((uid) => checkinWindow(goal, weekId, zones[uid])!)
        const times = new Set<number>()
        for (let t = end - 20 * HOUR; t <= end + HALF_HOUR; t += HALF_HOUR) times.add(t)
        for (const w of windows) for (const t of [w.opensAt - 1, w.opensAt, w.closesAt - 1, w.closesAt]) times.add(t)
        for (const t of [...times].sort((a, b) => a - b)) {
          probes += 1
          const got = checkinCandidates(goal, t)
          const want = uids.filter((_, i) => t < end && windows[i].opensAt <= t && t < windows[i].closesAt)
          const tag = `goal ${goalZone}, week ${weekId}, ${new Date(t).toISOString()}`
          if (JSON.stringify(got.map((c) => c.uid)) !== JSON.stringify(want)) failures.push(`${tag}: ${got.map((c) => c.uid)} ≠ ${want}`)
          for (const c of got) {
            const w = windows[uids.indexOf(c.uid)]
            if (c.weekId !== weekId || c.key !== checkinKey('g1', weekId, c.uid) || c.opensAt !== w.opensAt || c.closesAt !== w.closesAt) failures.push(`${tag}: ${JSON.stringify(c)}`)
          }
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([])
    expect(probes).toBeGreaterThan(5_000)
  }, 120_000)

  it('the UTC gate (Saturday 15:00 → Monday 13:00) holds every window, even at the ends of the world’s zones', () => {
    expect(checkinGateOpen(at('2026-10-17T14:59:59Z'))).toBe(false)
    expect(checkinGateOpen(at('2026-10-17T15:00:00Z'))).toBe(true)
    expect(checkinGateOpen(at('2026-10-18T23:59:00Z'))).toBe(true)
    expect(checkinGateOpen(at('2026-10-19T12:59:59Z'))).toBe(true)
    expect(checkinGateOpen(at('2026-10-19T13:00:00Z'))).toBe(false)
    expect(checkinGateOpen(at('2026-10-21T12:00:00Z'))).toBe(false)
    // −12 to +14, with 45-minute and DST offsets, on the weeks where one of them changes.
    const edges = ['Etc/GMT+12', 'Pacific/Pago_Pago', 'Pacific/Chatham', 'Pacific/Kiritimati', 'Pacific/Tongatapu', 'Asia/Kathmandu', 'America/St_Johns', 'Europe/London']
    const failures: string[] = []
    for (const goalZone of edges) {
      for (const weekId of [...dstWeeks(edges), '2026-06-15', '2027-01-11']) {
        for (const zone of edges) {
          const w = checkinWindow(goalIn(goalZone), weekId, zone)
          if (!w || !checkinGateOpen(w.opensAt) || !checkinGateOpen(w.closesAt - 1)) failures.push(`${goalZone} ${zone} ${weekId}: ${JSON.stringify(w)}`)
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([])
  }, 60_000)

  it('cut by the end date; none for a finished or reached goal', () => {
    const berlin = goalIn('Europe/Berlin')
    const week = '2026-10-12'
    const full = checkinWindow(berlin, week, 'Europe/Berlin')!
    expect([full.opensAt, full.closesAt]).toEqual([at('2026-10-18T16:00:00Z'), at('2026-10-18T22:00:00Z')])
    // Ending on the Sunday: the whole window; ending on the Saturday: nothing left that week.
    expect(checkinWindow({ ...berlin, endsOn: '2026-10-18' }, week, 'Europe/Berlin')).toEqual(full)
    expect(checkinWindow({ ...berlin, endsOn: '2026-10-17' }, week, 'Europe/Berlin')).toBeNull()
    // A member whose evening is before the goal's Sunday ends, cut where the goal ends.
    expect(checkinWindow({ ...berlin, endsOn: '2026-10-17' }, week, 'Asia/Tokyo')).toBeNull()
    expect(checkinWindow({ ...berlin, endsOn: '2026-10-18' }, week, 'Asia/Tokyo')).toEqual({ opensAt: at('2026-10-18T09:00:00Z'), closesAt: at('2026-10-18T15:00:00Z') })
    // An end date in a later week changes nothing.
    expect(checkinWindow({ ...berlin, endsOn: '2026-12-31' }, week, 'America/New_York')).toEqual({ opensAt: at('2026-10-18T16:00:00Z'), closesAt: at('2026-10-18T22:00:00Z') })
    expect(checkinWindow({ ...berlin, archivedAt: at('2026-10-15T10:00:00Z') }, week, 'Europe/Berlin')).toBeNull()
    expect(checkinWindow({ ...berlin, reachedAt: at('2026-10-15T10:00:00Z') }, week, 'Europe/Berlin')).toBeNull()
    expect(checkinCandidates({ ...berlin, reachedAt: at('2026-10-15T10:00:00Z') }, at('2026-10-18T17:00:00Z'))).toEqual([])
    expect(checkinCandidates({ ...berlin, archivedAt: at('2026-10-15T10:00:00Z') }, at('2026-10-18T17:00:00Z'))).toEqual([])
    expect(checkinCandidates({ ...berlin, endsOn: '2026-10-10' }, at('2026-10-18T17:00:00Z'))).toEqual([])
    // Keep Going (a higher target clears reachedAt): back.
    expect(checkinCandidates(berlin, at('2026-10-18T17:00:00Z')).map((c) => c.uid)).toEqual(['a'])
  })

  it('members elsewhere: Tokyo gets Sunday evening, New York Sunday midday, both inside the Berlin week', () => {
    const berlin = goalIn('Europe/Berlin')
    // The week of Oct 12 ends Monday Oct 19, 00:00 in Berlin (22:00 UTC), which is 07:00 in Tokyo and 18:00 in New York.
    expect(checkinWindow(berlin, '2026-10-12', 'Asia/Tokyo')).toEqual({ opensAt: at('2026-10-18T09:00:00Z'), closesAt: at('2026-10-18T15:00:00Z') })
    expect(checkinWindow(berlin, '2026-10-12', 'America/New_York')).toEqual({ opensAt: at('2026-10-18T16:00:00Z'), closesAt: at('2026-10-18T22:00:00Z') })
    // Noon on their clock: 08:00 → 12:00 (4 hours); 13:00: 08:00 → 13:00.
    expect(checkinWindow(goalIn('UTC'), '2026-10-12', 'Etc/GMT-12')).toEqual({ opensAt: at('2026-10-18T20:00:00Z'), closesAt: at('2026-10-19T00:00:00Z') })
    expect(checkinWindow(goalIn('UTC'), '2026-10-12', 'Etc/GMT-13')).toEqual({ opensAt: at('2026-10-18T19:00:00Z'), closesAt: at('2026-10-19T00:00:00Z') })
    // 11:00 on their clock: the evening before, 18:00 → 24:00.
    expect(checkinWindow(goalIn('UTC'), '2026-10-12', 'Etc/GMT-11')).toEqual({ opensAt: at('2026-10-18T07:00:00Z'), closesAt: at('2026-10-18T13:00:00Z') })
  })
})

describe('who gets the check-in push (SPEC §11.10)', () => {
  // A Berlin goal in the week of Oct 12; it ends Sunday Oct 18, 22:00 UTC.
  const goal = goalIn('Europe/Berlin', {
    name: 'Run 100 km',
    total: 64,
    totals: { ana: 40, ben: 24 },
    memberIds: ['ana', 'ben', 'cleo', 'dan', 'eli'],
    invited: ['fay'],
    leftAt: { gus: at('2026-10-14T10:00:00Z') },
    zones: { ana: 'Europe/Berlin', ben: 'Asia/Tokyo', cleo: 'Not/AZone', dan: 'America/New_York', gus: 'Europe/Berlin' },
    joinedAt: { ana: at('2026-10-01T10:00:00Z'), ben: at('2026-10-01T10:00:00Z'), cleo: at('2026-10-01T10:00:00Z'), dan: at('2026-10-18T16:10:00Z'), eli: at('2026-10-02T10:00:00Z') },
  })
  const evening = at('2026-10-18T17:17:00Z')
  const checkin = (uid: string, weekId = '2026-10-12'): Checkin => ({ id: `${weekId}_${uid}`, uid, weekId, amount: 12, note: '', at: at('2026-10-15T10:00:00Z') })

  it('to members who haven’t checked in; checked in is final; joined after their window opened: nothing', () => {
    const plan = planShared({ goal, checkins: [checkin('ana'), checkin('eli', '2026-10-05')] }, new Set(), evening)
    // ana checked in (final); cleo (unknown zone: the goal's) and eli (last week's check-in doesn't count) are due;
    // ben's Tokyo evening is over; dan joined after his window opened; fay is invited, gus left.
    expect(plan.skipped).toEqual(['g1_2026-10-12_checkin_ana'])
    expect(plan.send.map((r) => r.uid)).toEqual(['cleo', 'eli'])
    expect(plan.send[0]).toEqual({
      key: 'g1_2026-10-12_checkin_cleo',
      kind: 'checkin',
      spaceId: '',
      goalId: 'g1',
      uid: 'cleo',
      title: 'Time to check in',
      body: 'Add your part to Run 100 km for this week. The team is at 64 of 100 km.',
      url: './?goal=g1',
      tag: 'checkin-g1',
      expiresAt: at('2026-10-18T22:00:00Z'),
    })
  })

  it('once each: keys already in the sent log are left alone; before the check-ins load, nothing is decided', () => {
    expect(planShared({ goal, checkins: [] }, new Set(['g1_2026-10-12_checkin_cleo', 'g1_2026-10-12_checkin_eli', 'g1_2026-10-12_checkin_ana']), evening)).toEqual({ send: [], skipped: [] })
    expect(planShared({ goal }, new Set(), evening)).toEqual({ send: [], skipped: [] })
  })

  it('Tokyo’s window is their Sunday evening; outside every window nobody is due', () => {
    expect(planShared({ goal, checkins: [] }, new Set(), at('2026-10-18T10:00:00Z')).send.map((r) => r.uid)).toEqual(['ben'])
    expect(planShared({ goal, checkins: [] }, new Set(), at('2026-10-18T08:59:00Z')).send).toEqual([])
    expect(planShared({ goal, checkins: [] }, new Set(), at('2026-10-18T22:00:00Z')).send).toEqual([])
    expect(planShared({ goal, checkins: [] }, new Set(), at('2026-10-14T18:00:00Z')).send).toEqual([])
  })

  it('an unknown member zone follows the goal’s; a bad goal id is skipped', () => {
    expect(memberZone(goal, 'cleo')).toBe('Europe/Berlin')
    expect(memberZone(goal, 'nobody')).toBe('Europe/Berlin')
    expect(memberZone(goal, 'ben')).toBe('Asia/Tokyo')
    expect(checkinCandidates({ ...goal, id: 'bad_id' }, evening)).toEqual([])
    expect(checkinCandidates({ ...goal, id: 'x'.repeat(41) }, evening)).toEqual([])
  })

  it('money goals read in their currency; ids are encoded in the link', () => {
    const money = goalIn('Europe/Berlin', { id: 'Ab12', name: 'Trip fund', unit: 'USD', target: 5000, total: 4200 })
    const [push] = planShared({ goal: money, checkins: [] }, new Set(), evening).send
    expect(push).toMatchObject({ body: 'Add your part to Trip fund for this week. The team is at $4,200 of $5,000.', url: './?goal=Ab12', tag: 'checkin-Ab12' })
  })
})

describe('the scores writer’s pure parts (SPEC §11.10)', () => {
  const space = (extra: Partial<Space> = {}): Space => ({
    id: 's1', name: 'Film Club', reward: 'r', penalty: 'p', ownerId: 'a', memberIds: ['a', 'b'], joinedAt: {}, timezone: 'UTC',
    inviteCode: 'ABCD2345', threshold: 90, latePenalty: 5, createdAt: at('2026-09-01T00:00:00Z'), ...extra,
  })

  it('markers and caps', () => {
    expect(scoresKey('s1', '2026-10-12')).toBe('s1_2026-10-12_scores')
    expect(statsKey('s1', '2026-10')).toBe('s1_2026-10_stats')
    expect(checkinKey('g1', '2026-10-12', 'ana')).toBe('g1_2026-10-12_checkin_ana')
    expect([SCORES_PER_SPACE, SCORES_PER_RUN]).toEqual([2, 8])
  })

  it('W is the newest of last and this week whose deadline has passed; nothing before October 2026 or the space’s first month', () => {
    // Deadlines on the usual times: Saturday 00:00.
    expect(scoresTarget(space(), at('2026-10-14T12:00:00Z'))).toEqual({ weekId: '2026-10-05', monthId: '2026-10', floor: '2026-10' })
    expect(scoresTarget(space(), at('2026-10-17T00:00:00Z'))).toEqual({ weekId: '2026-10-12', monthId: '2026-10', floor: '2026-10' })
    // The week of Sep 28 is October's (its Thursday is Oct 1); the week before is September's: none.
    expect(scoresTarget(space(), at('2026-10-03T08:00:00Z'))).toMatchObject({ weekId: '2026-09-28', monthId: '2026-10' })
    expect(scoresTarget(space(), at('2026-09-30T08:00:00Z'))).toBeNull()
    // A space created in November starts there.
    const late = space({ createdAt: at('2026-11-10T00:00:00Z') })
    expect(scoresTarget(late, at('2026-11-05T12:00:00Z'))).toBeNull()
    expect(scoresTarget(late, at('2026-11-20T12:00:00Z'))).toEqual({ weekId: '2026-11-09', monthId: '2026-11', floor: '2026-11' })
    // A stored week whose deadline is later than computed (new times) isn't W yet.
    const stored: Week = {
      id: '2026-10-12', spaceId: 's1', startAt: at('2026-10-12T00:00:00Z'), lockAt: at('2026-10-12T00:00:00Z'), reviewOpenAt: at('2026-10-17T00:00:00Z'),
      deadlineAt: at('2026-10-18T00:00:00Z'), members: ['a'], submittedBy: [],
    }
    expect(scoresTarget(space(), at('2026-10-17T12:00:00Z'), { weeks: { '2026-10-12': stored } })).toMatchObject({ weekId: '2026-10-05' })
    expect(scoresTarget(space(), at('2026-10-18T00:00:00Z'), { weeks: { '2026-10-12': stored } })).toMatchObject({ weekId: '2026-10-12' })
  })

  it('entries: the month’s final score so far, the weeks played, final once complete; nobody without a score', () => {
    const base = { monthId: '2026-10', former: false, others: [], missedReviews: 0, penaltyPoints: 0, passed: null }
    const month: Record<string, MemberMonthResult> = {
      a: {
        ...base, uid: 'a', average: 92, finalScore: 92, complete: false,
        weeks: [
          { weekId: '2026-10-05', score: 100, closed: true },
          { weekId: '2026-10-12', score: null, closed: true, paused: true },
          { weekId: '2026-10-19', score: 84, closed: true },
          { weekId: '2026-10-26', score: null, closed: false },
        ],
      },
      // Only judged: no score, no entry.
      j: { ...base, uid: 'j', average: null, finalScore: null, complete: false, weeks: [], judged: ['2026-10-05'] },
      // Joined after the lock: no score, no entry.
      n: { ...base, uid: 'n', average: null, finalScore: null, complete: false, weeks: [] },
      // A skipped week (every task excused) isn't played.
      s: { ...base, uid: 's', average: 50, finalScore: 45, complete: true, missedReviews: 1, penaltyPoints: 5, weeks: [{ weekId: '2026-10-05', score: null, closed: true, skipped: true }, { weekId: '2026-10-12', score: 50, closed: true }] },
    }
    expect(scoreEntries(month)).toEqual({
      a: { score: 92, weeks: ['2026-10-05', '2026-10-19'], final: false },
      s: { score: 45, weeks: ['2026-10-12'], final: true },
    })
  })
})
