// A space's own times (SPEC §9.2) against the emulators: the owner's change, the weeks and monthly lists it
// moves with a day's notice, and the upkeep that creates and heals weeks on the space's schedule.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { disableNetwork, enableNetwork } from 'firebase/firestore'
import { addTaskAfterLock, ensureSpace, setSchedule, submitReviews } from '../../src/data/api.ts'
import { ensureMonthly } from '../../src/data/monthly.ts'
import { startWeek } from '../../src/data/weeks.ts'
import { now } from '../../src/domain/clock.ts'
import { addMonths, addWeeks, DEFAULT_SCHEDULE, monthlyBounds, monthlyWeeks, utcOffsetMinutes, weekBounds, weekIdFor } from '../../src/domain/time.ts'
import type { Space, WeekSchedule } from '../../src/domain/types.ts'
import { getFirebase } from '../../src/firebase/app.ts'
import {
  adminGet,
  adminSpace,
  as,
  boundsDoc,
  createUser,
  DAY,
  HOUR,
  observe,
  rejectsWith,
  resetClock,
  seed,
  setupEmulators,
  spaceDoc,
  teardownEmulators,
  travelBack,
  travelTo,
  ts,
  weekDoc,
  type TestUser,
} from './helpers.ts'

const OFFLINE = 'You’re offline. Check your connection and try again.'
/** Lists lock Tuesday at 10:00 AM, reviews open Thursday at midnight, due Saturday at noon. */
const TUESDAY_LATE: WeekSchedule = { lock: 2040, reviewOpen: 5760, deadline: 7920 }

let lena: TestUser
let sam: TestUser

const ms = (v: { toMillis(): number } | undefined) => v?.toMillis()
const weekPath = (spaceId: string, weekId: string) => `spaces/${spaceId}/weeks/${weekId}`

async function freshSpace(id: string, extra: Record<string, unknown> = {}, opts: { timezone?: string; utcOffsetMin?: number } = {}): Promise<Space> {
  await seed({ [`spaces/${id}`]: spaceDoc({ ownerId: lena.uid, memberIds: [lena.uid, sam.uid], inviteCode: 'TIMES234', extra, ...opts }) })
  return adminSpace(id)
}

beforeAll(async () => {
  await setupEmulators()
  resetClock()
  lena = await createUser('Lena')
  sam = await createUser('Sam')
})
afterAll(teardownEmulators)

describe('setSchedule', () => {
  const id = 'times'
  const thisWeek = () => weekIdFor(now(), 'UTC')
  const nextWeek = () => addWeeks(thisWeek(), 1)

  it('checks the times and who changes them before writing', async () => {
    await freshSpace(id)
    await as(lena)
    await rejectsWith(setSchedule(id, { lock: 5760, reviewOpen: 5760, deadline: 7200 }), 'Lists have to lock before reviews open. Midnight is the end of the day you pick.')
    await rejectsWith(setSchedule(id, { lock: 1440, reviewOpen: 5760, deadline: 5820 }), 'Give reviews at least 3 hours. Midnight is the end of the day you pick.')
    await rejectsWith(setSchedule(id, { lock: 1440, reviewOpen: 5760, deadline: 10110 }), 'Reviews have to be due by Sunday at midnight.')
    await rejectsWith(setSchedule(id, { lock: -30, reviewOpen: 5760, deadline: 7200 }), 'Those times don’t work. Pick them again.')
    await as(sam)
    await rejectsWith(setSchedule(id, TUESDAY_LATE), 'Only the owner can change the times.')
    const stored = await adminGet(`spaces/${id}`)
    expect(stored?.schedule).toBeUndefined()
    expect(stored?.scheduleNote).toBeUndefined()
  })

  it('moves the weeks that lock at least a day away on both times, and writes the note', async () => {
    await as(lena)
    // This week's lists lock Tuesday at midnight on the usual times: never a day away once the week has begun.
    const { fromWeek } = await setSchedule(id, TUESDAY_LATE)
    expect(fromWeek).toBe(nextWeek())
    const stored = await adminGet(`spaces/${id}`)
    expect(stored?.schedule).toEqual(TUESDAY_LATE)
    expect(stored?.scheduleNote).toMatchObject({ by: lena.uid, fromWeek: nextWeek(), before: DEFAULT_SCHEDULE })
    expect(ms(stored?.scheduleNote.at)).toBeGreaterThan(Date.now() - 60_000)
    const next = await adminGet(weekPath(id, nextWeek()))
    const moved = weekBounds(nextWeek(), 'UTC', TUESDAY_LATE)
    expect(next?.schedule).toEqual(TUESDAY_LATE)
    expect([ms(next?.startAt), ms(next?.lockAt), ms(next?.reviewOpenAt), ms(next?.deadlineAt)]).toEqual([moved.startAt, moved.lockAt, moved.reviewOpenAt, moved.deadlineAt])
    const current = await adminGet(weekPath(id, thisWeek()))
    if (current) {
      expect(current.schedule).toBeUndefined()
      expect(ms(current.lockAt)).toBe(weekBounds(thisWeek(), 'UTC').lockAt)
    }
  })

  it('the same times again write nothing', async () => {
    const before = ms((await adminGet(`spaces/${id}`))?.scheduleNote.at)
    expect((await setSchedule(id, { ...TUESDAY_LATE })).fromWeek).toBe(nextWeek())
    expect(ms((await adminGet(`spaces/${id}`))?.scheduleNote.at)).toBe(before)
  })

  it('the usual times delete the fields, on the space and on the weeks it moves back', async () => {
    expect((await setSchedule(id, null)).fromWeek).toBe(nextWeek())
    const stored = await adminGet(`spaces/${id}`)
    expect(stored?.schedule).toBeUndefined()
    expect(stored?.scheduleNote).toMatchObject({ before: TUESDAY_LATE, fromWeek: nextWeek() })
    const next = await adminGet(weekPath(id, nextWeek()))
    expect(next?.schedule).toBeUndefined()
    expect(ms(next?.lockAt)).toBe(weekBounds(nextWeek(), 'UTC').lockAt)
  })

  it('refuses when a week can’t be made on the old times first', async () => {
    // A note from the future: no week can lock within a day of it, so neither week can be created.
    await freshSpace('stuck', { scheduleNote: { by: lena.uid, at: ts(Date.now() + 9 * DAY), fromWeek: nextWeek(), before: DEFAULT_SCHEDULE } })
    await rejectsWith(setSchedule('stuck', TUESDAY_LATE), 'Something went wrong. Try again.')
    expect((await adminGet('spaces/stuck'))?.schedule).toBeUndefined()
  })

  it('fails at once offline, and nothing is queued', async () => {
    await freshSpace('offline')
    const { db } = getFirebase()
    await disableNetwork(db)
    try {
      await rejectsWith(setSchedule('offline', TUESDAY_LATE), OFFLINE)
    } finally {
      await enableNetwork(db)
    }
    expect((await adminGet('spaces/offline'))?.schedule).toBeUndefined()
  })

  /** A zone whose local week has room for a lock more than a day away this week (else null: the case is skipped). */
  function roomyZone(): { tz: string; minute: number } | null {
    for (const tz of ['UTC', 'Etc/GMT+12', 'Pacific/Kiritimati']) {
      const minute = Math.floor((Date.now() - weekBounds(weekIdFor(Date.now(), tz), tz).startAt) / 60_000)
      if (minute + 1440 + 120 + 30 + 60 + 180 <= 10080) return { tz, minute }
    }
    return null
  }
  const zone = roomyZone()

  it.skipIf(zone === null)('starts this week when its lists lock at least a day away on both times', async () => {
    const { tz, minute } = zone as { tz: string; minute: number }
    const lock = Math.ceil((minute + 1440 + 120) / 30) * 30
    const before: WeekSchedule = { lock, reviewOpen: lock + 60, deadline: lock + 60 + 180 }
    const after: WeekSchedule = { lock: lock + 30, reviewOpen: lock + 90, deadline: lock + 90 + 180 }
    const space = await freshSpace('early', { schedule: before }, { timezone: tz, utcOffsetMin: Math.round(utcOffsetMinutes(tz, Date.now())) })
    const week = weekIdFor(Date.now(), tz)
    await as(lena)
    await ensureSpace(space)
    expect((await adminGet(weekPath('early', week)))?.schedule).toEqual(before)
    expect((await setSchedule('early', after)).fromWeek).toBe(week)
    for (const w of [week, addWeeks(week, 1)]) {
      const stored = await adminGet(weekPath('early', w))
      expect(stored?.schedule).toEqual(after)
      expect(ms(stored?.lockAt)).toBe(weekBounds(w, tz, after).lockAt)
    }
  })
})

describe('weeks on the space’s times', () => {
  it('creates weeks on the space’s schedule, storing it; another member’s upkeep heals a stale week, then adds members', async () => {
    const space = await freshSpace('custom', { schedule: TUESDAY_LATE })
    const next = addWeeks(weekIdFor(Date.now(), 'UTC'), 1)
    // A week still on the usual times, made before the change, and missing Sam.
    await seed({ [weekPath('custom', next)]: boundsDoc(weekBounds(next, 'UTC'), [lena.uid]) })
    await as(sam)
    await ensureSpace(space)
    const stored = await adminGet(weekPath('custom', next))
    expect(stored?.schedule).toEqual(TUESDAY_LATE)
    expect(ms(stored?.lockAt)).toBe(weekBounds(next, 'UTC', TUESDAY_LATE).lockAt)
    expect(stored?.members).toEqual([lena.uid, sam.uid])
  })

  it('a week on its own times isn’t flagged; one two hours off them is', async () => {
    const next = addWeeks(weekIdFor(Date.now(), 'UTC'), 1)
    await as(lena)
    const live = observe(startWeek('custom', next, lena.uid))
    expect((await live.until((l) => l.data?.week != null)).data?.boundsMismatch).toBe(false)
    live.stop()
    const skewed = weekBounds('2026-08-03', 'UTC', TUESDAY_LATE)
    await seed({ [weekPath('custom', '2026-08-03')]: boundsDoc({ ...skewed, lockAt: skewed.lockAt + 2 * HOUR }, [lena.uid, sam.uid], { schedule: TUESDAY_LATE }) })
    const old = observe(startWeek('custom', '2026-08-03', lena.uid))
    expect((await old.until((l) => l.data?.week != null)).data?.boundsMismatch).toBe(true)
    old.stop()
  })

  it('messages don’t name days that may not be the space’s', async () => {
    const space = await adminSpace('custom')
    await seed({
      [weekPath('custom', '2026-07-06')]: weekDoc('review', [lena.uid, sam.uid]),
      [weekPath('custom', '2026-07-13')]: weekDoc('active', [lena.uid, sam.uid]),
    })
    await as(lena)
    await rejectsWith(addTaskAfterLock(space, '2026-07-06', { title: 'Late' }), 'Adding tasks closed when reviews opened.')
    await rejectsWith(submitReviews(space, '2026-07-13', [{ revieweeId: sam.uid, marks: {} }]), 'Reviews haven’t opened yet.')
  })
})

describe('monthly lists follow a change of times', () => {
  // The emulator's clock is real, so this runs the real rules on a moved clock (travelTo): a month three
  // months ahead, in its first week, when its list can be made and moved.
  const id = 'monthlytimes'
  const month = addMonths(new Date().toISOString().slice(0, 7), 3)
  const { first, lock, last } = monthlyWeeks(month)
  const at = (weekId: string, minutes: number) => weekBounds(weekId, 'UTC').startAt + minutes * 60_000

  afterAll(travelBack)

  it('moves the list’s lock and review window with its weeks', async () => {
    // Wednesday of the month's first week.
    await travelTo(at(first, 2 * 1440 + 600))
    await seed({ [`spaces/${id}`]: spaceDoc({ ownerId: lena.uid, memberIds: [lena.uid, sam.uid], inviteCode: 'TIMES234', createdAt: now() - 3 * DAY, joinedAt: now() - 3 * DAY }) })
    const space = await adminSpace(id)
    await as(lena)
    await ensureSpace(space)
    await ensureMonthly(space, month)
    const created = await adminGet(`spaces/${id}/monthly/${month}`)
    const usual = monthlyBounds(month, (w) => weekBounds(w, 'UTC'))
    expect([ms(created?.lockAt), ms(created?.reviewOpenAt), ms(created?.deadlineAt)]).toEqual([usual.lockAt, usual.reviewOpenAt, usual.deadlineAt])

    expect((await setSchedule(id, TUESDAY_LATE)).fromWeek).toBe(lock)
    const moved = await adminGet(`spaces/${id}/monthly/${month}`)
    const week = await adminGet(weekPath(id, lock))
    expect(ms(moved?.lockAt)).toBe(ms(week?.lockAt))
    expect(ms(moved?.lockAt)).toBe(weekBounds(lock, 'UTC', TUESDAY_LATE).lockAt)
    expect(ms(moved?.deadlineAt)).toBe(weekBounds(last, 'UTC', TUESDAY_LATE).deadlineAt)
  })

  it('moves only the review window once the lock is less than a day away', async () => {
    // Monday of the second week: the list locks with that week's lists, Tuesday at 10:00 AM.
    await travelTo(at(lock, 720))
    const later: WeekSchedule = { lock: 2100, reviewOpen: 5700, deadline: 7920 }
    const before = await adminGet(`spaces/${id}/monthly/${month}`)
    expect((await setSchedule(id, later)).fromWeek).toBe(addWeeks(lock, 1))
    const after = await adminGet(`spaces/${id}/monthly/${month}`)
    expect(ms(after?.lockAt)).toBe(ms(before?.lockAt))
    expect(ms(after?.reviewOpenAt)).toBe(weekBounds(last, 'UTC', later).reviewOpenAt)
    expect(ms(after?.deadlineAt)).toBe(weekBounds(last, 'UTC', later).deadlineAt)
  })
})
