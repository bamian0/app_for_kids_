// The reminders job and deals (SPEC §12.11) against the emulator: dormant without `hasDeals`; the stamps, periods and
// ends it writes (weeks and months, leaving, Call Off, everyone else leaving), idempotent and safe beside a concurrent
// run; recording the cutover month; the `deal` and `deal-end` pushes; reads; and a dry run. Spaces are on UTC: a week's
// lists lock Tuesday 00:00 and its reviews are due Saturday 00:00.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Timestamp, type Firestore } from 'firebase-admin/firestore'
import { ensureVapidKeys, runReminders, type RunSummary } from '../../scripts/reminders.ts'
import { dealsFromAt } from '../../src/domain/stakes.ts'
import { allReviews, at, clear, connect, device, fakePush, HOUR, profile, quiet, scoresWritten, seedSpace, seedWeek, sentLog, ts } from './reminders-fixtures.ts'

const { db, close } = connect('reminders-deals-test')
afterAll(close)
beforeEach(clear)

const noPush = fakePush().send
const NAMES: [string, string][] = [['a', 'Lena'], ['b', 'Sam'], ['c', 'Kim']]

/** A deal doc as the app writes it, plus the job's fields when given (times in ms become Timestamps). */
function seedDeal(spaceId: string, uid: string, seq: number, friends: string[], extra: Record<string, unknown> = {}) {
  return db.doc(`spaces/${spaceId}/deals/${uid}_${seq}`).set({
    uid, seq, unit: 'week', count: 2, rewardMode: 'group', penaltyMode: 'group', reward: 'Dinner, on us', penalty: 'Coffee for a week', per: {},
    friends, agreed: {}, off: {}, settled: {}, createdAt: ts(at('2026-10-29T09:00:00Z')), ended: null, ...extra,
  })
}
const agreed = (...uids: string[]) => Object.fromEntries(uids.map((u, i) => [u, ts(at('2026-10-30T10:00:00Z') + i * HOUR)]))
/** A fully agreed weeks deal of Lena's with Sam and Kim, stamped by the job to start the week of Nov 2. */
const running = (extra: Record<string, unknown> = {}) => ({ agreed: agreed('b', 'c'), agreedAt: ts(at('2026-10-30T11:00:00Z')), start: '2026-11-02', ...extra })

async function deal(spaceId: string, id: string) {
  return (await db.doc(`spaces/${spaceId}/deals/${id}`).get()).data()!
}
const millis = (v: unknown) => (v as Timestamp).toMillis()

/** Everyone played the week; marks per member (1 by default). */
const playWeek = (spaceId: string, weekId: string, members: string[], marks: Record<string, 0 | 0.5 | 1> = {}) =>
  seedWeek(db, spaceId, weekId, { members, plans: Object.fromEntries(members.map((m) => [m, 1])), submittedBy: members, reviews: allReviews(members, marks) })

async function people(uids: string[], withProfiles = true) {
  for (const [uid, name] of NAMES) {
    if (!uids.includes(uid)) continue
    await device(db, uid)
    if (withProfiles) await profile(db, uid, name)
  }
}

/** The run, with the months before the ones a test is about settled: their results docs exist. */
async function settledBefore(spaceId: string, months: string[]) {
  for (const m of months) await db.doc(`spaces/${spaceId}/results/${m}`).set({ monthId: m, completeAt: ts(at('2026-10-31T00:00:00Z')), createdAt: ts(at('2026-11-01T00:00:00Z')), members: {} })
}

describe('dormant without hasDeals', () => {
  it('a stray deal doc in a space without the flag is never read: the run is its twin’s, read for read', async () => {
    const twin = async (withDoc: boolean) => {
      await clear()
      await seedSpace(db, 's1', ['a', 'b', 'c'])
      await people(['a', 'b', 'c'])
      await playWeek('s1', '2026-11-02', ['a', 'b', 'c'])
      if (withDoc) await seedDeal('s1', 'a', 1, ['b', 'c'], { agreed: agreed('b', 'c') })
      const push = fakePush()
      const runs: RunSummary[] = []
      for (const iso of ['2026-11-01T03:17:00Z', '2026-11-03T12:17:00Z', '2026-11-07T10:17:00Z']) runs.push(await runReminders({ db, send: push.send, nowMs: at(iso), log: quiet, dealsFrom: null }))
      return { runs, lines: push.lines(), log: await sentLog(db), config: (await db.doc('public/config').get()).exists }
    }
    const without = await twin(false)
    const withDoc = await twin(true)
    expect(withDoc).toEqual(without)
    expect(without.runs.every((r) => r.deals === 0 && r.errors === 0)).toBe(true)
    // The stray doc is as it was: nothing stamped.
    expect(await deal('s1', 'a_1')).not.toHaveProperty('agreedAt')
    expect(withDoc.config).toBe(false)
  })
})

describe('deal results', () => {
  it('stamps agreedAt and start once (with a day’s notice); a waiting deal is left alone at no cost', async () => {
    await seedSpace(db, 's1', ['a', 'b', 'c'], { hasDeals: true })
    // Kim's Agree on Saturday Oct 31 12:00: the week of Nov 2 locks Tuesday 00:00, more than a day later.
    await seedDeal('s1', 'a', 1, ['b', 'c'], { agreed: { b: ts(at('2026-10-30T10:00:00Z')), c: ts(at('2026-10-31T12:00:00Z')) } })
    await seedDeal('s1', 'b', 1, ['a', 'c'], { agreed: agreed('a') })
    const now = at('2026-11-01T03:17:00Z')
    const first = await runReminders({ db, send: noPush, nowMs: now, log: quiet })
    expect(first).toMatchObject({ deals: 1, dealsEnded: 0, errors: 0 })
    const stamped = await deal('s1', 'a_1')
    expect(millis(stamped.agreedAt)).toBe(at('2026-10-31T12:00:00Z'))
    expect(stamped.start).toBe('2026-11-02')
    expect(millis(stamped.checkedAt)).toBe(now)
    expect(stamped).not.toHaveProperty('track')
    // Agreed on Monday Nov 2 at 00:01 instead: less than a day before Tuesday's lock, so it starts the week after.
    await seedDeal('s1', 'c', 1, ['a', 'b'], { agreed: { a: ts(at('2026-11-01T10:00:00Z')), b: ts(at('2026-11-02T00:01:00Z')) } })
    await runReminders({ db, send: noPush, nowMs: at('2026-11-02T03:17:00Z'), log: quiet })
    expect((await deal('s1', 'c_1')).start).toBe('2026-11-09')
    // The waiting deal: untouched.
    expect(Object.keys(await deal('s1', 'b_1')).sort()).toEqual(['agreed', 'count', 'createdAt', 'ended', 'friends', 'off', 'penalty', 'penaltyMode', 'per', 'reward', 'rewardMode', 'seq', 'settled', 'uid', 'unit'])
    // A rerun writes nothing (no checkedAt-only write).
    const again = await runReminders({ db, send: noPush, nowMs: at('2026-11-02T04:17:00Z'), log: quiet })
    expect(again.deals).toBe(0)
    expect(millis((await deal('s1', 'a_1')).checkedAt)).toBe(now)
  })

  it('weeks: pass, pass → won at the second deadline; a rerun writes nothing', async () => {
    await seedSpace(db, 's1', ['a', 'b', 'c'], { hasDeals: true })
    await people(['a', 'b', 'c'])
    await settledBefore('s1', ['2026-10'])
    await seedDeal('s1', 'a', 1, ['b', 'c'], running())
    await playWeek('s1', '2026-11-02', ['a', 'b', 'c'])
    await playWeek('s1', '2026-11-09', ['a', 'b', 'c'])
    const push = fakePush()
    const now = at('2026-11-14T10:17:00Z')
    expect(await runReminders({ db, send: push.send, nowMs: now, log: quiet })).toMatchObject({ deals: 1, dealsEnded: 1, errors: 0 })
    const won = await deal('s1', 'a_1')
    expect(won.track).toEqual([
      { id: '2026-11-02', result: 'pass', score: 100 },
      { id: '2026-11-09', result: 'pass', score: 100 },
    ])
    expect(won.ended).toEqual({ outcome: 'won', at: ts(at('2026-11-14T00:00:00Z')), period: '2026-11-09' })
    expect(push.lines().filter((l) => l.includes('made it'))).toEqual([
      'a | You made it: 2 weeks at 90%+ | Your deal in s1 is done. Collect from Sam and Kim: Dinner, on us.',
      'b | Lena made it | 2 weeks at 90%+ in s1. You owe Lena: Dinner, on us.',
      'c | Lena made it | 2 weeks at 90%+ in s1. You owe Lena: Dinner, on us.',
    ])
    expect(push.sent.filter((p) => p.title.includes('made it')).map((p) => [p.tag, p.url])).toEqual(Array(3).fill(['deal-s1-a@1', './?space=s1']))
    const checked = millis(won.checkedAt)
    const rerun = fakePush()
    expect(await runReminders({ db, send: rerun.send, nowMs: now + HOUR, log: quiet })).toMatchObject({ deals: 0, dealsEnded: 0 })
    expect(millis((await deal('s1', 'a_1')).checkedAt)).toBe(checked)
    // The deal-end went out once.
    expect(rerun.lines().filter((l) => l.includes('made it'))).toEqual([])
  })

  it('weeks: a miss ends it lost at that deadline with its score', async () => {
    await seedSpace(db, 's1', ['a', 'b', 'c'], { hasDeals: true })
    await settledBefore('s1', ['2026-10'])
    await seedDeal('s1', 'a', 1, ['b', 'c'], running({ count: 4 }))
    await playWeek('s1', '2026-11-02', ['a', 'b', 'c'])
    await playWeek('s1', '2026-11-09', ['a', 'b', 'c'], { a: 0.5 })
    await runReminders({ db, send: noPush, nowMs: at('2026-11-14T03:17:00Z'), log: quiet })
    const lost = await deal('s1', 'a_1')
    expect(lost.track).toEqual([{ id: '2026-11-02', result: 'pass', score: 100 }, { id: '2026-11-09', result: 'miss', score: 50 }])
    expect(lost.ended).toEqual({ outcome: 'lost', at: ts(at('2026-11-14T00:00:00Z')), period: '2026-11-09', score: 50 })
  })

  it('weeks: a paused, an excused, a missing week add one; a judged week is a miss; a missed review costs 5', async () => {
    await seedSpace(db, 's1', ['a', 'b', 'c'], { hasDeals: true, paused: { '2026-11': '2026-11-02' } })
    await settledBefore('s1', ['2026-10'])
    await seedDeal('s1', 'a', 1, ['b', 'c'], running({ count: 3 }))
    await seedWeek(db, 's1', '2026-11-02', { members: ['a', 'b', 'c'] })
    // Week of Nov 9: Lena crossed out her only task and both friends said fair.
    await seedWeek(db, 's1', '2026-11-09', {
      members: ['a', 'b', 'c'], plans: { a: 1, b: 1, c: 1 }, cancels: { a1: 1 }, submittedBy: ['a', 'b', 'c'],
      reviews: [['b', 'a', { a1: 'fair' }], ['c', 'a', { a1: 'fair' }], ['a', 'b', { b1: 1 }], ['a', 'c', { c1: 1 }], ['b', 'c', { c1: 1 }], ['c', 'b', { b1: 1 }]],
    })
    // Week of Nov 16: no doc (nobody opened it). Week of Nov 23: Lena didn't review Kim. Week of Nov 30: 100.
    await seedWeek(db, 's1', '2026-11-23', {
      members: ['a', 'b', 'c'], plans: { a: 1, b: 1, c: 1 }, submittedBy: ['a', 'b', 'c'],
      reviews: allReviews(['a', 'b', 'c']).filter(([r, e]) => !(r === 'a' && e === 'c')),
    })
    await playWeek('s1', '2026-11-30', ['a', 'b', 'c'])
    await scoresWritten(db, 's1', ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30'])
    // A judged week next: the week of Dec 7.
    await seedWeek(db, 's1', '2026-12-07', { members: ['a', 'b', 'c'], judges: ['a'], plans: { b: 1, c: 1 }, submittedBy: ['a', 'b', 'c'], reviews: allReviews(['b', 'c']) })
    await scoresWritten(db, 's1', ['2026-12-07'])
    await db.doc('spaces/s1/results/2026-11').set({ monthId: '2026-11', completeAt: ts(at('2026-11-28T00:00:00Z')), createdAt: ts(at('2026-11-28T01:00:00Z')), members: {} })
    // The job was down: 5 weeks are due at once; at most 4 loads a run (the missing week costs no load).
    const first = await runReminders({ db, send: noPush, nowMs: at('2026-12-06T03:17:00Z'), log: quiet })
    expect(first).toMatchObject({ deals: 1, errors: 0 })
    expect((await deal('s1', 'a_1')).track).toEqual([
      { id: '2026-11-02', result: 'skip', score: null, why: 'paused' },
      { id: '2026-11-09', result: 'skip', score: null, why: 'excused' },
      { id: '2026-11-16', result: 'skip', score: null, why: 'missing' },
      { id: '2026-11-23', result: 'pass', score: 95, missed: 1 },
      { id: '2026-11-30', result: 'pass', score: 100 },
    ])
    await runReminders({ db, send: noPush, nowMs: at('2026-12-12T03:17:00Z'), log: quiet })
    const judged = await deal('s1', 'a_1')
    expect(judged.track.at(-1)).toEqual({ id: '2026-12-07', result: 'miss', score: null, why: 'judge' })
    expect(judged.ended).toEqual({ outcome: 'lost', at: ts(at('2026-12-12T00:00:00Z')), period: '2026-12-07', score: null })
  })

  it('weeks: 5 pending weeks → 4 loads this run, the rest the next', async () => {
    await seedSpace(db, 's1', ['a', 'b', 'c'], { hasDeals: true })
    await settledBefore('s1', ['2026-10', '2026-11'])
    await seedDeal('s1', 'a', 1, ['b', 'c'], running({ count: 5 }))
    for (const w of ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30']) await playWeek('s1', w, ['a', 'b', 'c'])
    await scoresWritten(db, 's1', ['2026-11-30'])
    await db.doc('_private/sent/log/s1_2026-11_stats').set({ kind: 'scores', spaceId: 's1', at: ts(at('2026-11-28T00:00:00Z')) })
    await runReminders({ db, send: noPush, nowMs: at('2026-12-06T03:17:00Z'), log: quiet })
    expect((await deal('s1', 'a_1')).track).toHaveLength(4)
    expect((await deal('s1', 'a_1')).ended).toBeNull()
    await runReminders({ db, send: noPush, nowMs: at('2026-12-06T04:17:00Z'), log: quiet })
    const won = await deal('s1', 'a_1')
    expect(won.track).toHaveLength(5)
    expect(won.ended).toMatchObject({ outcome: 'won', period: '2026-11-30' })
  })

  it('a week’s load is shared with the scores writer: the deal adds its query and its write’s re-read', async () => {
    const night = at('2026-11-14T03:17:00Z')
    const reads = async (withDeal: boolean) => {
      await clear()
      await seedSpace(db, 's1', ['a', 'b', 'c'], withDeal ? { hasDeals: true } : {})
      await settledBefore('s1', ['2026-10'])
      await playWeek('s1', '2026-11-02', ['a', 'b', 'c'])
      await playWeek('s1', '2026-11-09', ['a', 'b', 'c'])
      await scoresWritten(db, 's1', ['2026-11-02'])
      if (withDeal) await seedDeal('s1', 'a', 1, ['b', 'c'], running({ count: 4, track: [{ id: '2026-11-02', result: 'pass', score: 100 }] }))
      return (await runReminders({ db, send: noPush, nowMs: night, log: quiet })).reads
    }
    const base = await reads(false)
    expect(await reads(true)).toBe(base + 2)
    expect((await deal('s1', 'a_1')).track).toHaveLength(2)
  })

  it('months: a completed month shares the results writer’s loads; leaving mid-month loses it at the next lock', async () => {
    const night = at('2026-11-01T03:17:00Z')
    const reads = async (withDeal: boolean) => {
      await clear()
      await seedSpace(db, 's1', ['a', 'b', 'c'], withDeal ? { hasDeals: true } : {})
      for (const w of ['2026-09-28', '2026-10-05']) await playWeek('s1', w, ['a', 'b', 'c'])
      await scoresWritten(db, 's1', ['2026-10-26'])
      await db.doc('_private/sent/log/s1_2026-10_stats').set({ kind: 'scores', spaceId: 's1', at: ts(at('2026-10-31T00:00:00Z')) })
      await db.doc('_private/sent/log/s1_2026-09_stats').set({ kind: 'scores', spaceId: 's1', at: ts(at('2026-10-31T00:00:00Z')) })
      if (withDeal) await seedDeal('s1', 'a', 1, ['b', 'c'], { ...running(), unit: 'month', count: 1, start: '2026-10', agreedAt: ts(at('2026-09-20T10:00:00Z')) })
      const summary = await runReminders({ db, send: noPush, nowMs: night, log: quiet })
      expect(summary).toMatchObject({ results: 1, errors: 0 })
      return summary.reads
    }
    const base = await reads(false)
    expect(await reads(true)).toBe(base + 2)
    expect(await deal('s1', 'a_1')).toMatchObject({
      track: [{ id: '2026-10', result: 'pass', score: 100 }],
      ended: { outcome: 'won', at: ts(at('2026-10-31T00:00:00Z')), period: '2026-10' },
    })

    // Lena leaves on Thursday Nov 12, after November's second week locked: the third week's lock loses it.
    await clear()
    await seedSpace(db, 's1', ['b', 'c'], { hasDeals: true, leftAt: { a: ts(at('2026-11-12T12:00:00Z')) } })
    await people(['a', 'b', 'c'])
    await settledBefore('s1', ['2026-10'])
    await seedDeal('s1', 'a', 1, ['b', 'c'], { ...running(), unit: 'month', count: 3, start: '2026-11' })
    await playWeek('s1', '2026-11-02', ['a', 'b', 'c'])
    await playWeek('s1', '2026-11-09', ['a', 'b', 'c'])
    const push = fakePush()
    await runReminders({ db, send: push.send, nowMs: at('2026-11-17T10:17:00Z'), log: quiet })
    expect(await deal('s1', 'a_1')).toMatchObject({
      track: [{ id: '2026-11', result: 'miss', score: null, why: 'left' }],
      ended: { outcome: 'lost', at: ts(at('2026-11-17T00:00:00Z')), period: '2026-11', score: null },
    })
    expect(push.lines().filter((l) => l.includes('deal'))).toEqual([
      'b | Lena’s deal ended | Lena left s1 during the deal, so it counts as a miss. Lena owes you: Coffee for a week.',
      'c | Lena’s deal ended | Lena left s1 during the deal, so it counts as a miss. Lena owes you: Coffee for a week.',
    ])
  })
})

describe('leaving, Call Off, everyone else leaving', () => {
  it('a deleted account’s agreed deal is lost at the next lock and kept; its waiting deal is withdrawn at its leftAt', async () => {
    const left = at('2026-11-05T12:00:00Z')
    await seedSpace(db, 's1', ['b', 'c'], { hasDeals: true, leftAt: { a: ts(left), d: ts(left) } })
    await people(['b', 'c'])
    await settledBefore('s1', ['2026-10'])
    await seedDeal('s1', 'a', 1, ['b', 'c'], running({ count: 4 }))
    await seedDeal('s1', 'd', 1, ['b', 'c'], { agreed: agreed('b') })
    await playWeek('s1', '2026-11-02', ['a', 'b', 'c'])
    const push = fakePush()
    expect(await runReminders({ db, send: push.send, nowMs: at('2026-11-10T10:17:00Z'), log: quiet })).toMatchObject({ deals: 2, dealsEnded: 1, errors: 0 })
    expect(await deal('s1', 'a_1')).toMatchObject({
      track: [{ id: '2026-11-02', result: 'pass', score: 100 }, { id: '2026-11-09', result: 'miss', score: null, why: 'left' }],
      ended: { outcome: 'lost', at: ts(at('2026-11-10T00:00:00Z')), period: '2026-11-09', score: null },
    })
    expect((await deal('s1', 'd_1')).ended).toEqual({ outcome: 'withdrawn', at: ts(left), by: 'd' })
    // No profile: "A former member"; nothing to the person, who isn't a member.
    expect(push.lines().filter((l) => l.includes('deal'))).toEqual([
      'b | A former member’s deal ended | A former member left s1 during the deal, so it counts as a miss. A former member owes you: Coffee for a week.',
      'c | A former member’s deal ended | A former member left s1 during the deal, so it counts as a miss. A former member owes you: Coffee for a week.',
    ])
  })

  it('called off by everyone at the last tap; off alone once everyone else left by a lock', async () => {
    await seedSpace(db, 's1', ['a', 'b', 'c'], { hasDeals: true })
    await seedSpace(db, 's2', ['a'], { hasDeals: true, leftAt: { b: ts(at('2026-11-07T12:00:00Z')), c: ts(at('2026-11-08T12:00:00Z')) } })
    await people(['a', 'b', 'c'])
    for (const s of ['s1', 's2']) await settledBefore(s, ['2026-10'])
    const taps = { a: ts(at('2026-11-04T09:00:00Z')), b: ts(at('2026-11-04T10:00:00Z')), c: ts(at('2026-11-04T11:00:00Z')) }
    await seedDeal('s1', 'a', 1, ['b', 'c'], running({ count: 4, off: taps }))
    await seedDeal('s2', 'a', 1, ['b', 'c'], running({ count: 4 }))
    await playWeek('s2', '2026-11-02', ['a', 'b', 'c'])
    const push = fakePush()
    // The run after Kim's tap: off from it (the week in progress doesn't count).
    await runReminders({ db, send: push.send, nowMs: at('2026-11-04T12:17:00Z'), log: quiet })
    expect((await deal('s1', 'a_1')).ended).toEqual({ outcome: 'off', at: taps.c, reason: 'called-off' })
    expect((await deal('s2', 'a_1')).ended).toBeNull()
    await runReminders({ db, send: push.send, nowMs: at('2026-11-10T10:17:00Z'), log: quiet })
    expect(await deal('s2', 'a_1')).toMatchObject({ track: [{ id: '2026-11-02', result: 'pass', score: 100 }], ended: { outcome: 'off', at: ts(at('2026-11-10T00:00:00Z')), reason: 'alone' } })
    expect(push.lines().filter((l) => l.includes('off'))).toEqual([
      'a | Your deal is off | Everyone in s1 called it off. Nothing’s owed.',
      'b | Lena’s deal is off | Everyone called it off. Nothing’s owed.',
      'c | Lena’s deal is off | Everyone called it off. Nothing’s owed.',
      'a | Your deal is off | Everyone in your deal left s2, so nothing’s owed.',
    ])
  })

  it('a concurrent run’s entries are kept, not doubled; a withdrawal between the read and the write is left alone', async () => {
    await seedSpace(db, 's1', ['a', 'b', 'c'], { hasDeals: true })
    await settledBefore('s1', ['2026-10'])
    await seedDeal('s1', 'a', 1, ['b', 'c'], running({ count: 4 }))
    await seedDeal('s1', 'b', 1, ['a', 'c'], { agreed: agreed('a') })
    await playWeek('s1', '2026-11-02', ['a', 'b', 'c'])
    await playWeek('s1', '2026-11-09', ['a', 'b', 'c'])
    // Another run writes the first week (with checkedAt) and Sam withdraws, just before this run's transactions.
    const racing = beforeTransactions(db, async () => {
      await db.doc('spaces/s1/deals/a_1').update({ track: [{ id: '2026-11-02', result: 'pass', score: 100 }], checkedAt: ts(1) })
      await db.doc('spaces/s1/deals/b_1').update({ ended: { outcome: 'withdrawn', at: ts(at('2026-11-14T02:00:00Z')), by: 'b' } })
    })
    // Sam left (so the job would withdraw it too), after the withdrawal.
    await seedSpace(db, 's1', ['a', 'c'], { hasDeals: true, leftAt: { b: ts(at('2026-11-14T02:30:00Z')) } })
    await runReminders({ db: racing, send: noPush, nowMs: at('2026-11-14T03:17:00Z'), log: quiet })
    expect((await deal('s1', 'a_1')).track).toEqual([{ id: '2026-11-02', result: 'pass', score: 100 }, { id: '2026-11-09', result: 'pass', score: 100 }])
    expect((await deal('s1', 'b_1')).ended).toEqual({ outcome: 'withdrawn', at: ts(at('2026-11-14T02:00:00Z')), by: 'b' })
  })
})

/** The database, running `before` once just ahead of its first transaction (a concurrent writer). */
function beforeTransactions(target: Firestore, before: () => Promise<void>): Firestore {
  let done = false
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'runTransaction') {
        return async (...args: unknown[]) => {
          if (!done) {
            done = true
            await before()
          }
          return (t.runTransaction as (...a: unknown[]) => Promise<unknown>)(...args)
        }
      }
      const value: unknown = Reflect.get(t, prop, t)
      return typeof value === 'function' ? value.bind(t) : value
    },
  })
}

describe('the cutover month (dealsFrom)', () => {
  it('not given: public/config is never read or written', async () => {
    await seedSpace(db, 's1', ['a', 'b'], { hasDeals: true })
    await seedDeal('s1', 'a', 1, ['b'])
    await runReminders({ db, send: noPush, nowMs: at('2026-11-02T03:17:00Z'), log: quiet })
    expect((await db.doc('public/config').get()).exists).toBe(false)
  })

  it('null: the first deal records it once; a second run or a second space doesn’t change it; ensureVapidKeys returns it', async () => {
    const created = at('2026-10-29T09:00:00Z')
    await seedSpace(db, 's1', ['a', 'b'], { hasDeals: true })
    await seedSpace(db, 's2', ['a', 'b'], { hasDeals: true })
    await seedDeal('s1', 'a', 1, ['b'], { createdAt: ts(created) })
    await seedDeal('s2', 'a', 1, ['b'], { createdAt: ts(at('2026-11-05T09:00:00Z')) })
    const now = at('2026-11-06T03:17:00Z')
    const logs: string[] = []
    await runReminders({ db, send: noPush, nowMs: now, log: (m) => logs.push(m), dealsFrom: null })
    expect(dealsFromAt({ timezone: 'UTC' }, created)).toBe('2026-11')
    expect((await db.doc('public/config').get()).data()).toEqual({ dealsFrom: '2026-11', dealsFromAt: ts(now) })
    expect(logs).toContain('dealsFrom 2026-11 recorded from space s1')
    await runReminders({ db, send: noPush, nowMs: now + HOUR, log: quiet, dealsFrom: null })
    expect((await db.doc('public/config').get()).data()).toEqual({ dealsFrom: '2026-11', dealsFromAt: ts(now) })
    const keys = { publicKey: 'pub', privateKey: 'priv' }
    expect(await ensureVapidKeys(db, () => keys)).toEqual({ ...keys, dealsFrom: '2026-11' })
    await db.doc('public/config').set({ dealsFrom: 'soon' }, { merge: true })
    expect((await ensureVapidKeys(db, () => keys)).dealsFrom).toBeNull()
  })

  it('a stray flag without deal docs records nothing', async () => {
    await seedSpace(db, 's1', ['a', 'b'], { hasDeals: true })
    await runReminders({ db, send: noPush, nowMs: at('2026-11-06T03:17:00Z'), log: quiet, dealsFrom: null })
    expect((await db.doc('public/config').get()).exists).toBe(false)
  })

  it('a late ship records December, and the same run’s November verdict keeps its stakes', async () => {
    await seedSpace(db, 's1', ['a', 'b', 'c'], { hasDeals: true })
    await people(['a', 'b', 'c'])
    await settledBefore('s1', ['2026-10'])
    await seedDeal('s1', 'a', 1, ['b', 'c'], { createdAt: ts(at('2026-11-05T09:00:00Z')) })
    await playWeek('s1', '2026-11-02', ['a', 'b', 'c'], { c: 0 })
    const push = fakePush()
    await runReminders({ db, send: push.send, nowMs: at('2026-12-01T10:17:00Z'), log: quiet, dealsFrom: null })
    expect((await db.doc('public/config').get()).get('dealsFrom')).toBe('2026-12')
    expect(push.lines().filter((l) => l.includes('November'))).toEqual([
      'a | You made it: 100% | November in s1 is done. Collect: Dinner on me',
      'b | You made it: 100% | November in s1 is done. Collect: Dinner on me',
      'c | You fell short: 0% | November in s1 is done. Pay up: Coffee for a week',
    ])
  })
})

describe('the deal pushes', () => {
  it('`deal`: once to each friend still to agree, in the daytime, tagged per deal; final once agreed', async () => {
    await seedSpace(db, 's1', ['a', 'b', 'c'], { hasDeals: true })
    await people(['a', 'b', 'c'])
    await settledBefore('s1', ['2026-10'])
    await scoresWritten(db, 's1', ['2026-10-26', '2026-11-02'])
    await seedDeal('s1', 'a', 1, ['b', 'c'], { createdAt: ts(at('2026-11-03T22:00:00Z')), count: 4 })
    const push = fakePush()
    // At night nothing goes out (and nothing is read for it).
    await runReminders({ db, send: push.send, nowMs: at('2026-11-04T03:17:00Z'), log: quiet })
    expect(push.sent).toEqual([])
    await runReminders({ db, send: push.send, nowMs: at('2026-11-04T09:17:00Z'), log: quiet })
    expect(push.lines()).toEqual(
      ['b', 'c'].map((u) => `${u} | New deal from Lena | Lena wants a deal in s1: 4 weeks at 90%+. Take a look, and tap Agree if you’re in.`),
    )
    expect(push.sent.map((p) => [p.tag, p.url, p.options.urgency])).toEqual(Array(2).fill(['deal-s1-a@1', './?space=s1', 'normal']))
    await runReminders({ db, send: push.send, nowMs: at('2026-11-04T10:17:00Z'), log: quiet })
    expect(push.sent).toHaveLength(2)
    expect((await sentLog(db))['s1_a@1_deal_b']).toBe('New deal from Lena')
  })

  it('reads with deals (SPEC §12.11’s note): a steady night, a steady day, a week’s close', async () => {
    await seedSpace(db, 's1', ['a', 'b', 'c'], { hasDeals: true })
    await people(['a', 'b', 'c'])
    await settledBefore('s1', ['2026-10'])
    await seedDeal('s1', 'a', 1, ['b', 'c'], running({ count: 4, checkedAt: ts(at('2026-10-31T00:00:00Z')) }))
    await playWeek('s1', '2026-11-02', ['a', 'b', 'c'])
    await scoresWritten(db, 's1', ['2026-10-26'])
    const reads: Record<string, number> = {}
    reads.night = (await runReminders({ db, send: noPush, nowMs: at('2026-11-05T03:17:00Z'), log: quiet })).reads
    reads.day = (await runReminders({ db, send: noPush, nowMs: at('2026-11-05T13:17:00Z'), log: quiet })).reads
    reads.close = (await runReminders({ db, send: noPush, nowMs: at('2026-11-07T10:17:00Z'), log: quiet })).reads
    reads.after = (await runReminders({ db, send: noPush, nowMs: at('2026-11-07T11:17:00Z'), log: quiet })).reads
    console.log(`deals reads: ${JSON.stringify(reads)}`)
    // Night: spaces, results, scores marker, the open deals (1). Day: + the recent ends query and the stakes query.
    expect(reads.night).toBe(4)
    expect(reads.day).toBe(6)
    expect(reads.after).toBeLessThan(reads.close)
  })

  it('a dry run writes nothing and says what it would write', async () => {
    await seedSpace(db, 's1', ['a', 'b', 'c'], { hasDeals: true })
    await settledBefore('s1', ['2026-10'])
    await seedDeal('s1', 'a', 1, ['b', 'c'], { agreed: agreed('b', 'c') })
    const logs: string[] = []
    const summary = await runReminders({ db, send: noPush, nowMs: at('2026-11-01T03:17:00Z'), log: (m) => logs.push(m), dryRun: true, dealsFrom: null })
    expect(summary).toMatchObject({ deals: 1, errors: 0 })
    expect((await db.doc('public/config').get()).exists).toBe(false)
    expect(await deal('s1', 'a_1')).not.toHaveProperty('agreedAt')
    expect(logs.some((l) => l.startsWith('[dry run] would record dealsFrom 2026-11'))).toBe(true)
    expect(logs.some((l) => l.startsWith('[dry run] would update spaces/s1/deals/a_1'))).toBe(true)
  })
})
