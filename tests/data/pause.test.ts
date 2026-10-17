// Pausing a week (SPEC §9.3) against the emulators, in real time: asks are for next week (its reviews always
// open more than a day away) or for seeded weeks whose stored times put them where a case needs them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { disableNetwork, doc, enableNetwork, FieldPath, runTransaction } from 'firebase/firestore'
import { answerPause, askToPause, ensureSpace, leaveSpace, withdrawPause } from '../../src/data/api.ts'
import { finalizePause } from '../../src/data/pause.ts'
import { now } from '../../src/domain/clock.ts'
import { addWeeks, monthIdForWeek, weekIdFor } from '../../src/domain/time.ts'
import type { Space } from '../../src/domain/types.ts'
import { getFirebase } from '../../src/firebase/app.ts'
import {
  adminGet,
  adminSpace,
  as,
  boundsDoc,
  clientFor,
  createUser,
  DAY,
  HOUR,
  rejectsWith,
  resetClock,
  seed,
  setupEmulators,
  spaceDoc,
  teardownEmulators,
  ts,
  type TestUser,
} from './helpers.ts'

const OFFLINE = 'You’re offline. Check your connection and try again.'

let ana: TestUser
let ben: TestUser
let cleo: TestUser

/** A fresh space of the three, seeded by admin (tz UTC). */
async function freshSpace(id: string, extra: Record<string, unknown> = {}): Promise<Space> {
  await seed({ [`spaces/${id}`]: spaceDoc({ ownerId: ana.uid, memberIds: [ana.uid, ben.uid, cleo.uid], inviteCode: `P${id.toUpperCase().padEnd(7, '2')}`.slice(0, 8), extra }) })
  return adminSpace(id)
}

const nextWeek = () => addWeeks(weekIdFor(now(), 'UTC'), 1)
const monthName = (weekId: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(`${monthIdForWeek(weekId)}-15T00:00:00Z`))

beforeAll(async () => {
  await setupEmulators()
  resetClock()
  ana = await createUser('Ana')
  ben = await createUser('Ben')
  cleo = await createUser('Cleo')
})
afterAll(teardownEmulators)

describe('asking and answering', () => {
  let space: Space

  it('asks for next week (creating its doc first), then every OK records the pause', async () => {
    space = await freshSpace('ask')
    await as(ana)
    expect(await askToPause(space, nextWeek())).toBe('asked')
    const stored = await adminGet('spaces/ask')
    expect(stored?.pause).toMatchObject({ weekId: nextWeek(), by: ana.uid, oks: [ana.uid] })
    expect(Object.keys(stored?.pause).sort()).toEqual(['at', 'by', 'oks', 'weekId'])
    expect(stored?.pause.at.toMillis()).toBeGreaterThan(Date.now() - 60_000)
    expect((await adminGet(`spaces/ask/weeks/${nextWeek()}`))?.members).toEqual([ana.uid, ben.uid, cleo.uid])

    await as(ben)
    expect(await answerPause(await adminSpace('ask'), 'ok')).toBe('waiting')
    // Saying OK twice changes nothing.
    expect(await answerPause(await adminSpace('ask'), 'ok')).toBe('waiting')
    await as(cleo)
    expect(await answerPause(await adminSpace('ask'), 'ok')).toBe('paused')
    const after = await adminGet('spaces/ask')
    expect(after?.pause.oks).toEqual([ana.uid, ben.uid, cleo.uid])
    expect(after?.paused).toEqual({ [monthIdForWeek(nextWeek())]: nextWeek() })
  })

  it('one pause a month', async () => {
    await as(ben)
    await rejectsWith(askToPause(await adminSpace('ask'), nextWeek()), `You can pause one week a month, and ${monthName(nextWeek())} already has its pause.`)
  })

  it('Not Now ends the request; someone else can ask again at once, the asker after 12 hours', async () => {
    space = await freshSpace('decline')
    await as(ana)
    await askToPause(space, nextWeek())
    await as(ben)
    expect(await answerPause(await adminSpace('decline'), 'not-now')).toBe('declined')
    expect((await adminGet('spaces/decline'))?.pause).toMatchObject({ by: ana.uid, declinedBy: ben.uid, oks: [ana.uid] })
    await as(ana)
    await rejectsWith(askToPause(await adminSpace('decline'), nextWeek()), 'You asked not long ago. Try again later.')
    await as(cleo)
    expect(await askToPause(await adminSpace('decline'), nextWeek())).toBe('asked')
    // A request is pending now.
    await as(ben)
    await rejectsWith(askToPause(await adminSpace('decline'), nextWeek()), 'There’s already a request to pause a week. Answer it first.')
  })

  it('the asker cancels: the request stays, marked as cancelled, and the 12-hour wait holds', async () => {
    await as(cleo)
    await withdrawPause(await adminSpace('decline'))
    expect((await adminGet('spaces/decline'))?.pause).toMatchObject({ by: cleo.uid, declinedBy: cleo.uid })
    await rejectsWith(askToPause(await adminSpace('decline'), nextWeek()), 'You asked not long ago. Try again later.')
    await as(ben)
    await rejectsWith(answerPause(await adminSpace('decline'), 'ok'), 'This request was cancelled.')
  })

  it('alone in the week, asking pauses at once', async () => {
    await seed({ 'spaces/solo': spaceDoc({ ownerId: ana.uid, memberIds: [ana.uid], inviteCode: 'SOLOSPCE' }) })
    await as(ana)
    expect(await askToPause(await adminSpace('solo'), nextWeek())).toBe('paused')
    expect((await adminGet('spaces/solo'))?.paused).toEqual({ [monthIdForWeek(nextWeek())]: nextWeek() })
  })
})

describe('the week’s own times', () => {
  const thisWeek = () => weekIdFor(now(), 'UTC')

  it('this week: refused once its reviews are less than a day away, or open', async () => {
    const at = Date.now()
    await freshSpace('soon')
    await seed({ [`spaces/soon/weeks/${thisWeek()}`]: boundsDoc({ startAt: at - 3 * DAY, lockAt: at - 2 * DAY, reviewOpenAt: at + 10 * HOUR, deadlineAt: at + 2 * DAY }, [ana.uid, ben.uid, cleo.uid]) })
    await as(ana)
    await rejectsWith(askToPause(await adminSpace('soon'), thisWeek()), 'Reviews for that week open too soon to ask. Friends need a day to answer.')
    await freshSpace('open')
    await seed({ [`spaces/open/weeks/${thisWeek()}`]: boundsDoc({ startAt: at - 4 * DAY, lockAt: at - 3 * DAY, reviewOpenAt: at - HOUR, deadlineAt: at + DAY }, [ana.uid, ben.uid, cleo.uid]) })
    await rejectsWith(askToPause(await adminSpace('open'), thisWeek()), 'Reviews for that week have opened, so it can’t be paused anymore.')
  })

  it('answering after that week’s reviews opened is too late', async () => {
    const at = Date.now()
    await freshSpace('lapsed', { pause: { weekId: thisWeek(), by: ana.uid, at: ts(at - 3 * DAY), oks: [ana.uid] } })
    await seed({ [`spaces/lapsed/weeks/${thisWeek()}`]: boundsDoc({ startAt: at - 4 * DAY, lockAt: at - 3 * DAY, reviewOpenAt: at - HOUR, deadlineAt: at + DAY }, [ana.uid, ben.uid, cleo.uid]) })
    await as(ben)
    await rejectsWith(answerPause(await adminSpace('lapsed'), 'ok'), 'Too late: reviews for that week have opened.')
    // A lapsed request doesn't hold up asking again (next week).
    expect(await askToPause(await adminSpace('lapsed'), nextWeek())).toBe('asked')
  })

  it('someone who joined after the week locked isn’t asked: their Not Now is refused, the request goes on', async () => {
    const at = Date.now()
    // Cleo is in the space but not in this week (she joined after its lock).
    await freshSpace('late', { pause: { weekId: thisWeek(), by: ana.uid, at: ts(at - HOUR), oks: [ana.uid] } })
    await seed({ [`spaces/late/weeks/${thisWeek()}`]: boundsDoc({ startAt: at - DAY, lockAt: at - HOUR / 2, reviewOpenAt: at + 2 * DAY, deadlineAt: at + 3 * DAY }, [ana.uid, ben.uid]) })
    await as(cleo)
    await rejectsWith(answerPause(await adminSpace('late'), 'not-now'), 'You’re not in that week, so you don’t need to answer.')
    expect((await adminGet('spaces/late'))?.pause.declinedBy).toBeUndefined()
    await as(ben)
    expect(await answerPause(await adminSpace('late'), 'ok')).toBe('paused')
  })
})

describe('upkeep and races', () => {
  it('records a pause once everyone still in the week has said OK (the last holdout left)', async () => {
    await freshSpace('final')
    await as(ana)
    await askToPause(await adminSpace('final'), nextWeek())
    await as(ben)
    await answerPause(await adminSpace('final'), 'ok')
    // Cleo leaves before next week locks: she's out of it, so nobody else is needed.
    await as(cleo)
    await leaveSpace('final')
    expect((await adminGet(`spaces/final/weeks/${nextWeek()}`))?.members).toEqual([ana.uid, ben.uid])
    expect((await adminGet('spaces/final'))?.paused).toBeUndefined()
    await as(ana)
    await finalizePause(await adminSpace('final'))
    expect((await adminGet('spaces/final'))?.paused).toEqual({ [monthIdForWeek(nextWeek())]: nextWeek() })
    // ensureSpace runs it too, and it does nothing more.
    await ensureSpace({ ...(await adminSpace('final')), pause: { weekId: nextWeek(), by: ana.uid, at: Date.now(), oks: [ana.uid, ben.uid] } })
  })

  it('two last OKs at once record the pause once', async () => {
    await freshSpace('race')
    await as(ana)
    await askToPause(await adminSpace('race'), nextWeek())
    // Cleo answers from another phone at the same moment Ben does.
    const cleoDb = clientFor(cleo.uid)
    const ref = doc(cleoDb, 'spaces', 'race')
    const cleoOk = runTransaction(cleoDb, async (tx) => {
      const snap = await tx.get(ref)
      const oks = snap.get('pause.oks') as string[]
      // Once recorded, a pause takes no more OKs.
      if (oks.includes(cleo.uid) || snap.get('paused') !== undefined) return
      const done = oks.includes(ben.uid)
      if (done) tx.update(ref, new FieldPath('pause', 'oks'), [...oks, cleo.uid], new FieldPath('paused', monthIdForWeek(nextWeek())), nextWeek())
      else tx.update(ref, new FieldPath('pause', 'oks'), [...oks, cleo.uid])
    })
    await as(ben)
    const [benResult] = await Promise.all([answerPause(await adminSpace('race'), 'ok'), cleoOk])
    const stored = await adminGet('spaces/race')
    expect(stored?.pause.oks).toEqual(expect.arrayContaining([ana.uid, ben.uid]))
    expect(stored?.paused).toEqual({ [monthIdForWeek(nextWeek())]: nextWeek() })
    expect(['waiting', 'paused']).toContain(benResult)
  })

  it('every pause write fails at once offline', async () => {
    const space = await freshSpace('offline')
    await as(ana)
    const { db } = getFirebase()
    await disableNetwork(db)
    try {
      await rejectsWith(askToPause(space, nextWeek()), OFFLINE)
      await rejectsWith(answerPause(space, 'ok'), OFFLINE)
      await rejectsWith(withdrawPause(space), OFFLINE)
    } finally {
      await enableNetwork(db)
    }
  })
})
