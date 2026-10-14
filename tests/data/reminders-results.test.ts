// The reminders job's results writer (SPEC §9.8, §9.11): month results with streaks, tier runs and the terms that
// counted, written once per month per space from FIRST_RESULTS_MONTH, after freezing the month's house stakes; and
// the verdict that quotes them.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import { runReminders } from '../../scripts/reminders.ts'
import { allReviews, at, clear, connect, device, fakePush, profile, quiet, seedList, seedSpace, seedStakes, seedWeek, ts } from './reminders-fixtures.ts'

const { db, close } = connect('reminders-results-test')
afterAll(close)
beforeEach(clear)

/** Monday Nov 2 2026, 12:17 UTC: October (last Friday the 30th) is complete; its verdict window is open. */
const NOV_2 = at('2026-11-02T12:17:00Z')
const noPush = fakePush().send

async function results(spaceId: string, monthId: string) {
  return (await db.doc(`spaces/${spaceId}/results/${monthId}`).get()).data()
}
async function resultIds(spaceId: string) {
  return (await db.collection(`spaces/${spaceId}/results`).get()).docs.map((d) => d.id)
}
const house = (text: string) => ({ text, together: true, source: 'house' })

describe('results writer', () => {
  it('writes a complete month once, from FIRST_RESULTS_MONTH, after freezing its house stakes; the verdict quotes it', async () => {
    // A space from August: nothing for September or earlier.
    await seedSpace(db, 's1', ['a', 'b'], { createdAt: ts(at('2026-08-03T00:00:00Z')) })
    await seedWeek(db, 's1', '2026-10-05', { members: ['a', 'b'], plans: { a: 1, b: 1 }, submittedBy: ['a', 'b'], reviews: allReviews(['a', 'b']) })
    // Anna's October list scored 0: one more week in her average, so she misses with 50%.
    await seedList(db, 's1', '2026-10', { members: ['a', 'b'], plans: { a: 1 }, submittedBy: ['a', 'b'], reviews: [['b', 'a', { am1: 0 }]] })
    await device(db, 'a')
    await device(db, 'b')
    const push = fakePush()
    const logs: string[] = []
    const first = await runReminders({ db, send: push.send, nowMs: NOV_2, log: (m) => logs.push(m) })
    expect(first).toMatchObject({ results: 1, errors: 0 })
    expect(logs).toContain('results 2026-10 written for space s1')
    expect(await resultIds('s1')).toEqual(['2026-10'])
    const doc = await results('s1', '2026-10')
    expect(doc).toMatchObject({
      monthId: '2026-10',
      members: { a: { score: 50, passed: false, streak: 0 }, b: { score: 100, passed: true, streak: 1 } },
      terms: {
        a: { b: { reward: house('Dinner on me'), penalty: house('Coffee for a week'), tiers: [] } },
        b: { a: { reward: house('Dinner on me'), penalty: house('Coffee for a week'), tiers: [] } },
      },
    })
    expect((doc!.completeAt as Timestamp).toMillis()).toBe(at('2026-10-31T00:00:00Z'))
    expect(doc!.createdAt).toBeInstanceOf(Timestamp)
    // Frozen first, with the space's stakes, at completion.
    const frozen = (await db.doc('spaces/s1/months/2026-10').get()).data()
    expect(frozen).toMatchObject({ reward: 'Dinner on me', penalty: 'Coffee for a week' })
    // The verdict (same run) counts the list too.
    expect(push.lines()).toEqual([
      'a | You fell short: 50% | October in s1 is done. Pay up: Coffee for a week',
      'b | You made it: 100% | October in s1 is done. Collect: Dinner on me',
    ])
    // A rerun writes nothing and leaves the doc as it was.
    expect(await runReminders({ db, send: push.send, nowMs: NOV_2 + 3_600_000, log: quiet })).toMatchObject({ results: 0, errors: 0 })
    expect(((await results('s1', '2026-10'))!.createdAt as Timestamp).isEqual(doc!.createdAt as Timestamp)).toBe(true)
  })

  it('backfills over runs, oldest first, carrying streaks and tier runs', async () => {
    await seedSpace(db, 's1', ['a', 'b'])
    // Ben agreed in September to Anna's stakes, with a 3-month streak reward.
    const terms = { rewardMode: 'group' as const, penaltyMode: 'group' as const, reward: 'Dinner, on you', penalty: 'Coffee', tiers: [{ months: 3, reward: 'Weekend away' }] }
    await seedStakes(db, 's1', 'a', terms, { b: at('2026-09-20T12:00:00Z') }, at('2026-09-20T11:00:00Z'))
    // Both pass October, November, December and January.
    for (const w of ['2026-10-05', '2026-11-02', '2026-12-07', '2027-01-04']) {
      await seedWeek(db, 's1', w, { members: ['a', 'b'], plans: { a: 1, b: 1 }, submittedBy: ['a', 'b'], reviews: allReviews(['a', 'b']) })
    }
    const now = at('2027-02-10T12:00:00Z')
    expect(await runReminders({ db, send: noPush, nowMs: now, log: quiet })).toMatchObject({ results: 2 })
    expect(await resultIds('s1')).toEqual(['2026-10', '2026-11'])
    expect(await runReminders({ db, send: noPush, nowMs: now + 3_600_000, log: quiet })).toMatchObject({ results: 2 })
    expect(await resultIds('s1')).toEqual(['2026-10', '2026-11', '2026-12', '2027-01'])
    const members = await Promise.all(['2026-10', '2026-11', '2026-12', '2027-01'].map(async (m) => (await results('s1', m))!.members))
    expect(members.map((m) => [m.a.streak, m.a.tierRuns, m.b.streak, m.b.tierRuns])).toEqual([
      [1, { 3: 1 }, 1, undefined],
      [2, { 3: 2 }, 2, undefined],
      [3, { 3: 3 }, 3, undefined],
      [4, { 3: 4 }, 4, undefined],
    ])
    expect((await results('s1', '2026-12'))!.terms.a.b).toMatchObject({
      reward: { text: 'Dinner, on you', together: true, source: 'agreed' },
      tiers: [{ months: 3, reward: 'Weekend away' }],
    })
    expect(await runReminders({ db, send: noPush, nowMs: now + 7_200_000, log: quiet })).toMatchObject({ results: 0 })
  })

  it('writes at most 6 months a run across all spaces', async () => {
    // Four spaces, each missing October and November.
    for (const id of ['s1', 's2', 's3', 's4']) await seedSpace(db, id, [`${id}a`])
    const now = at('2026-12-09T12:00:00Z')
    expect(await runReminders({ db, send: noPush, nowMs: now, log: quiet })).toMatchObject({ results: 6 })
    expect(await Promise.all(['s1', 's2', 's3', 's4'].map(resultIds))).toEqual([['2026-10', '2026-11'], ['2026-10', '2026-11'], ['2026-10', '2026-11'], []])
    expect(await runReminders({ db, send: noPush, nowMs: now + 3_600_000, log: quiet })).toMatchObject({ results: 2 })
    expect(await resultIds('s4')).toEqual(['2026-10', '2026-11'])
  })

  it('skips a month that isn’t complete by its stored deadline, and everything after it', async () => {
    await seedSpace(db, 's1', ['a', 'b'])
    // October's last week is due Tuesday Nov 3 (a skewed doc): not complete on Monday.
    await seedWeek(db, 's1', '2026-10-26', { members: ['a', 'b'], bounds: { deadlineAt: at('2026-11-03T00:00:00Z') } })
    expect(await runReminders({ db, send: noPush, nowMs: NOV_2, log: quiet })).toMatchObject({ results: 0, errors: 0 })
    expect(await resultIds('s1')).toEqual([])
    expect((await db.doc('spaces/s1/months/2026-10').get()).exists).toBe(false)
    expect(await runReminders({ db, send: noPush, nowMs: at('2026-11-03T00:17:00Z'), log: quiet })).toMatchObject({ results: 1 })
  })

  it('a dry run writes nothing and says what it would write', async () => {
    await seedSpace(db, 's1', ['a', 'b'])
    const logs: string[] = []
    expect(await runReminders({ db, send: noPush, nowMs: NOV_2, dryRun: true, log: (m) => logs.push(m) })).toMatchObject({ results: 1 })
    expect(await resultIds('s1')).toEqual([])
    expect((await db.doc('spaces/s1/months/2026-10').get()).exists).toBe(false)
    expect(logs.some((l) => l.startsWith('[dry run] would freeze spaces/s1/months/2026-10'))).toBe(true)
    expect(logs.some((l) => l.startsWith('[dry run] would write spaces/s1/results/2026-10'))).toBe(true)
  })

  it('overwrites the previous app’s early October freeze with the space’s stakes; a binding freeze stays', async () => {
    // s1: frozen by the old app at October's first lock, then the owner changed the stakes.
    await seedSpace(db, 's1', ['a', 'b'], { reward: 'New dinner', penalty: 'New coffee' })
    await db.doc('spaces/s1/months/2026-10').set({ reward: 'Old dinner', penalty: 'Old coffee', createdAt: ts(at('2026-10-06T00:00:00Z')) })
    // s2: frozen when October ended.
    await seedSpace(db, 's2', ['a', 'b'], { reward: 'New dinner', penalty: 'New coffee' })
    await db.doc('spaces/s2/months/2026-10').set({ reward: 'Frozen dinner', penalty: 'Frozen coffee', createdAt: ts(at('2026-10-31T09:00:00Z')) })
    for (const id of ['s1', 's2']) await seedWeek(db, id, '2026-10-05', { members: ['a', 'b'], plans: { a: 1, b: 1 }, submittedBy: ['a', 'b'], reviews: allReviews(['a', 'b']) })
    await runReminders({ db, send: noPush, nowMs: NOV_2, log: quiet })
    const early = (await db.doc('spaces/s1/months/2026-10').get()).data()!
    expect(early).toMatchObject({ reward: 'New dinner', penalty: 'New coffee' })
    expect((early.createdAt as Timestamp).toMillis()).toBe(NOV_2)
    expect((await results('s1', '2026-10'))!.terms.a.b.reward).toEqual(house('New dinner'))
    expect((await db.doc('spaces/s2/months/2026-10').get()).data()).toMatchObject({ reward: 'Frozen dinner', createdAt: ts(at('2026-10-31T09:00:00Z')) })
    expect((await results('s2', '2026-10'))!.terms.a.b.reward).toEqual(house('Frozen dinner'))
  })

  it('the verdict names each pair’s terms and a streak reward reached that month', async () => {
    await seedSpace(db, 's1', ['a', 'b', 'c'])
    for (const [uid, name] of [['a', 'Anna'], ['b', 'Ben'], ['c', 'Chris']]) {
      await device(db, uid)
      await profile(db, uid, name)
    }
    const agreedAt = at('2026-10-10T12:00:00Z')
    // Anna: one reward for everyone and a 2-month streak reward. Ben: a reward per friend.
    await seedStakes(db, 's1', 'a', { rewardMode: 'group', penaltyMode: 'group', reward: 'Dinner, on you', penalty: 'Coffee', tiers: [{ months: 2, reward: 'Weekend away' }] }, { b: agreedAt, c: agreedAt }, agreedAt - 1000)
    await seedStakes(
      db, 's1', 'b',
      { rewardMode: 'each', penaltyMode: 'group', reward: '', penalty: 'Tea', tiers: [] },
      { a: agreedAt, c: agreedAt }, agreedAt - 1000,
      { a: { reward: 'Lunch', penalty: '' }, c: { reward: 'Movie night', penalty: '' } },
    )
    // October's results (written by an earlier run): Anna's run toward 2 months is at 1.
    await db.doc('spaces/s1/results/2026-10').set({
      monthId: '2026-10', completeAt: ts(at('2026-10-31T00:00:00Z')), createdAt: ts(at('2026-11-02T00:17:00Z')),
      members: { a: { score: 100, passed: true, streak: 1, tierRuns: { 2: 1 } }, b: { score: 100, passed: true, streak: 1 }, c: { score: 100, passed: true, streak: 1 } },
    })
    // November: Anna and Ben pass, Chris misses.
    await seedWeek(db, 's1', '2026-11-02', { members: ['a', 'b', 'c'], plans: { a: 1, b: 1, c: 1 }, submittedBy: ['a', 'b', 'c'], reviews: allReviews(['a', 'b', 'c'], { c: 0 }) })
    const push = fakePush()
    // Tuesday Dec 1, 10:17: November is written first, then its verdict quotes it.
    expect(await runReminders({ db, send: push.send, nowMs: at('2026-12-01T10:17:00Z'), log: quiet })).toMatchObject({ results: 1, errors: 0 })
    expect((await results('s1', '2026-11'))!.members.a).toEqual({ score: 100, passed: true, streak: 2, tierRuns: { 2: 2 } })
    expect(push.lines()).toEqual([
      'a | 2 months in a row: 100% | November in s1 is done. Collect: Dinner, on you, plus Weekend away.',
      'b | You made it: 100% | November in s1 is done. Collect from Anna and Chris.',
      'c | You fell short: 0% | November in s1 is done. Pay up: Coffee for a week',
    ])
  })

  it('costs a steady-state run one read per space for the newest results doc', async () => {
    await seedSpace(db, 's1', ['a'])
    await db.doc('spaces/s1/results/2026-10').set({ monthId: '2026-10', completeAt: ts(at('2026-10-31T00:00:00Z')), createdAt: ts(at('2026-11-02T00:17:00Z')), members: {} })
    // Wednesday Nov 11, 12:00: no window open in a one-person space (no stakes push without friends).
    expect(await runReminders({ db, send: noPush, nowMs: at('2026-11-11T12:00:00Z'), log: quiet })).toMatchObject({ reads: 2, results: 0, windows: 0 })
  })
})
