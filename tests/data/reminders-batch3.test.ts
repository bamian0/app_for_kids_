// Batch 3 in the reminders job (SPEC §11.10) against the data emulator: the scores writer (scores, rings and stats
// once a week's deadline has passed) and the shared goals' weekly check-in push.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Timestamp, type DocumentReference, type Firestore } from 'firebase-admin/firestore'
import { runReminders } from '../../scripts/reminders.ts'
import { allReviews, at, clear, connect, device, fakePush, profile, quiet, scoresWritten, seedSpace, seedWeek, sentLog, ts } from './reminders-fixtures.ts'

const { db, close } = connect('reminders-batch3-test')
afterAll(close)
beforeEach(clear)

const noPush = fakePush().send
const HOUR = 3_600_000

async function data(path: string) {
  return (await db.doc(path).get()).data()
}

/** Field names, sorted: what a doc holds besides its values. */
async function keysOf(path: string) {
  return Object.keys((await data(path)) ?? {}).sort()
}

/** The scores writer's markers in the sent log. */
async function markers() {
  return Object.keys(await sentLog(db)).filter((key) => key.endsWith('_scores') || key.endsWith('_stats')).sort()
}

/** A database whose batched reads of scores docs fail, as if the scores writer broke. */
function failingScores(target: Firestore): Firestore {
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'getAll') {
        return (...refs: DocumentReference[]) => {
          if (refs.some((ref) => ref.path.startsWith('scores/'))) return Promise.reject(new Error('scores are down'))
          return t.getAll(...refs)
        }
      }
      const value: unknown = Reflect.get(t, prop, t)
      return typeof value === 'function' ? value.bind(t) : value
    },
  })
}

/** A closed week of one task each, everyone reviewed by everyone: done (100%) unless `marks` says otherwise. */
function playWeek(spaceId: string, weekId: string, members: string[], marks: Record<string, 0 | 0.5 | 1> = {}) {
  return seedWeek(db, spaceId, weekId, {
    members,
    plans: Object.fromEntries(members.map((m) => [m, 1])),
    submittedBy: members,
    reviews: allReviews(members, marks),
  })
}

describe('the scores writer', () => {
  it('once a week’s deadline has passed: each space’s month so far in scores, one number in rings, four totals in stats', async () => {
    await seedSpace(db, 's1', ['a', 'b'])
    await seedSpace(db, 's2', ['a', 'c'])
    for (const [uid, name] of [['a', 'Anna'], ['b', 'Ben'], ['c', 'Cleo']]) await profile(db, uid, name)
    await playWeek('s1', '2026-10-05', ['a', 'b'], { b: 0 })
    await playWeek('s2', '2026-10-05', ['a', 'c'], { a: 0.5 })
    // Wednesday Oct 14: the week of Oct 5 closed on Saturday.
    const summary = await runReminders({ db, send: noPush, nowMs: at('2026-10-14T12:17:00Z'), log: quiet })
    expect(summary).toMatchObject({ errors: 0, rings: 4, stats: 4, cleaned: 0, goals: 0 })
    expect((await data('scores/a'))!.months).toEqual({
      '2026-10': { s1: { score: 100, weeks: ['2026-10-05'], final: false }, s2: { score: 50, weeks: ['2026-10-05'], final: false } },
    })
    expect((await data('scores/b'))!.months).toEqual({ '2026-10': { s1: { score: 0, weeks: ['2026-10-05'], final: false } } })
    // The ring is the mean across spaces; neither it nor the stats name a space.
    expect(await data('rings/a')).toMatchObject({ monthId: '2026-10', score: 75, final: false, spaces: 2 })
    expect(await keysOf('rings/a')).toEqual(['final', 'monthId', 'score', 'spaces', 'updatedAt'])
    expect(await data('stats/a')).toMatchObject({ monthsCleared: 0, currentStreak: 0, bestStreak: 0, weeksPlayed: 1, finishedMonths: 0, since: '2026-10' })
    expect(await keysOf('stats/a')).toEqual(['bestStreak', 'currentStreak', 'finishedMonths', 'monthsCleared', 'since', 'updatedAt', 'weeksPlayed'])
    expect((await data('rings/c'))!.score).toBe(100)
    expect((await data('rings/a'))!.updatedAt).toBeInstanceOf(Timestamp)
    expect(await markers()).toEqual(['s1_2026-10-05_scores', 's2_2026-10-05_scores'])

    // The markers keep the next runs from writing again: one read per space (2 spaces, 2 markers, and each space's
    // daytime query for changed stakes).
    const before = (await data('scores/a'))!.updatedAt as Timestamp
    expect(await runReminders({ db, send: noPush, nowMs: at('2026-10-14T13:17:00Z'), log: quiet })).toMatchObject({ errors: 0, rings: 0, stats: 0, reads: 6 })
    expect(((await data('scores/a'))!.updatedAt as Timestamp).isEqual(before)).toBe(true)
  })

  it('final at the month’s end, as the month results say; a space’s second week adds to the same month', async () => {
    await seedSpace(db, 's1', ['a', 'b'])
    await profile(db, 'a', 'Anna')
    await profile(db, 'b', 'Ben')
    await playWeek('s1', '2026-10-05', ['a', 'b'], { b: 0 })
    await playWeek('s1', '2026-10-26', ['a', 'b'])
    await runReminders({ db, send: noPush, nowMs: at('2026-10-14T12:17:00Z'), log: quiet })
    expect((await data('scores/b'))!.months['2026-10'].s1).toEqual({ score: 0, weeks: ['2026-10-05'], final: false })
    // Sunday Nov 1: the last week of October closed on Saturday; the results writer wrote October in the same run.
    expect(await runReminders({ db, send: noPush, nowMs: at('2026-11-01T10:17:00Z'), log: quiet })).toMatchObject({ errors: 0, results: 1, rings: 2 })
    const october = (await data('spaces/s1/results/2026-10'))!.members
    const b = (await data('scores/b'))!.months['2026-10'].s1
    expect(b).toEqual({ score: october.b.score, weeks: ['2026-10-05', '2026-10-26'], final: true })
    expect((await data('scores/a'))!.months['2026-10'].s1.score).toBe(october.a.score)
    expect(await data('rings/b')).toMatchObject({ monthId: '2026-10', score: 50, final: true, spaces: 1 })
    expect(await data('stats/a')).toMatchObject({ monthsCleared: 1, currentStreak: 1, bestStreak: 1, weeksPlayed: 2, finishedMonths: 1, since: '2026-10' })
    expect(await data('stats/b')).toMatchObject({ monthsCleared: 0, currentStreak: 0, bestStreak: 0, weeksPlayed: 2, finishedMonths: 1 })
    expect(await markers()).toEqual(['s1_2026-10-05_scores', 's1_2026-10-26_scores', 's1_2026-10_stats'])
  })

  it('a month whose end the job missed is written as final with the next week’s scores', async () => {
    await seedSpace(db, 's1', ['a', 'b'])
    await profile(db, 'a', 'Anna')
    await profile(db, 'b', 'Ben')
    await playWeek('s1', '2026-10-26', ['a', 'b'], { b: 0 })
    await playWeek('s1', '2026-11-02', ['a', 'b'])
    // First run on Wednesday Nov 11 (the job was down since October): November so far, and October, final.
    const summary = await runReminders({ db, send: noPush, nowMs: at('2026-11-11T12:17:00Z'), log: quiet })
    expect(summary).toMatchObject({ errors: 0, rings: 2 })
    expect((await data('scores/b'))!.months).toEqual({
      '2026-10': { s1: { score: 0, weeks: ['2026-10-26'], final: true } },
      '2026-11': { s1: { score: 100, weeks: ['2026-11-02'], final: false } },
    })
    // The ring is November’s so far; the stats count October.
    expect(await data('rings/b')).toMatchObject({ monthId: '2026-11', score: 100, final: false, spaces: 1 })
    expect(await data('stats/b')).toMatchObject({ monthsCleared: 0, finishedMonths: 1, weeksPlayed: 2, since: '2026-10' })
    expect(await data('stats/a')).toMatchObject({ monthsCleared: 1, currentStreak: 1, finishedMonths: 1, weeksPlayed: 2 })
    expect(await markers()).toEqual(['s1_2026-10_stats', 's1_2026-11-02_scores'])
  })

  it('someone without a profile (a deleted account) gets their scores, ring and stats deleted, not written', async () => {
    await seedSpace(db, 's1', ['a', 'c'])
    await profile(db, 'a', 'Anna')
    await playWeek('s1', '2026-10-05', ['a', 'c'])
    // Leftovers of c's account, deleted by an old app.
    await db.doc('scores/c').set({ months: { '2026-09': {} }, updatedAt: ts(at('2026-10-01T00:00:00Z')) })
    await db.doc('rings/c').set({ monthId: '2026-10', score: 80, final: false, spaces: 1, updatedAt: ts(at('2026-10-01T00:00:00Z')) })
    await db.doc('stats/c').set({ monthsCleared: 0, currentStreak: 0, bestStreak: 0, weeksPlayed: 1, finishedMonths: 0, since: '2026-10', updatedAt: ts(at('2026-10-01T00:00:00Z')) })
    expect(await runReminders({ db, send: noPush, nowMs: at('2026-10-14T12:17:00Z'), log: quiet })).toMatchObject({ errors: 0, rings: 1, cleaned: 1 })
    for (const path of ['scores/c', 'rings/c', 'stats/c']) expect(await data(path)).toBeUndefined()
    expect(await data('rings/a')).toMatchObject({ score: 100 })
  })

  it('a space everyone has left still finishes its last month for them, for a while', async () => {
    const left = { memberIds: [], joinedAt: {}, leftAt: { a: ts(at('2026-10-20T10:00:00Z')), b: ts(at('2026-10-21T10:00:00Z')) } }
    await seedSpace(db, 's1', ['a', 'b'], left)
    await profile(db, 'a', 'Anna')
    await profile(db, 'b', 'Ben')
    await playWeek('s1', '2026-10-05', ['a', 'b'])
    await playWeek('s1', '2026-10-19', ['a', 'b'], { b: 0 })
    await runReminders({ db, send: noPush, nowMs: at('2026-10-24T12:17:00Z'), log: quiet })
    expect((await data('scores/b'))!.months['2026-10'].s1).toEqual({ score: 50, weeks: ['2026-10-05', '2026-10-19'], final: false })
    await runReminders({ db, send: noPush, nowMs: at('2026-11-11T12:17:00Z'), log: quiet })
    expect((await data('scores/b'))!.months['2026-10'].s1.final).toBe(true)
    expect(await data('stats/a')).toMatchObject({ monthsCleared: 1, finishedMonths: 1 })
    // Emptied more than 60 days ago: the run reads the spaces and nothing else.
    await clear()
    await seedSpace(db, 's2', ['a'], { memberIds: [], joinedAt: {}, leftAt: { a: ts(at('2026-08-01T10:00:00Z')) } })
    expect(await runReminders({ db, send: noPush, nowMs: at('2026-11-11T12:17:00Z'), log: quiet })).toMatchObject({ reads: 1, rings: 0 })
  })

  it('a failing scores writer is counted, the space’s reminders still go out, and the next run catches up', async () => {
    await seedSpace(db, 's1', ['a'])
    await profile(db, 'a', 'Anna')
    await playWeek('s1', '2026-10-05', ['a'])
    await device(db, 'a')
    const push = fakePush()
    const logs: string[] = []
    // Monday Oct 12, 18:17: the 'plan' window is open.
    const summary = await runReminders({ db: failingScores(db), send: push.send, nowMs: at('2026-10-12T18:17:00Z'), log: (m) => logs.push(m) })
    expect(summary).toMatchObject({ errors: 1, sent: 1, rings: 0 })
    expect(push.sent.map((p) => p.title)).toEqual(['Lock in your week'])
    expect(logs).toContain('space s1 scores failed: scores are down')
    expect(await markers()).toEqual([])
    expect(await runReminders({ db, send: push.send, nowMs: at('2026-10-12T19:17:00Z'), log: quiet })).toMatchObject({ errors: 0, rings: 1 })
    expect(await markers()).toEqual(['s1_2026-10-05_scores'])
  })

  it('a dry run writes nothing and claims no marker', async () => {
    await seedSpace(db, 's1', ['a'])
    await profile(db, 'a', 'Anna')
    await playWeek('s1', '2026-10-05', ['a'])
    const logs: string[] = []
    expect(await runReminders({ db, send: noPush, nowMs: at('2026-10-14T12:17:00Z'), dryRun: true, log: (m) => logs.push(m) })).toMatchObject({ errors: 0, rings: 1, stats: 1 })
    for (const path of ['scores/a', 'rings/a', 'stats/a']) expect(await data(path)).toBeUndefined()
    expect(await markers()).toEqual([])
    expect(logs.some((l) => l.startsWith('[dry run] would write scores, ring and stats of a for space s1'))).toBe(true)
  })
})

// ---------- The check-in push ----------

const CREATED = at('2026-10-01T10:00:00Z')

/** A Berlin goal as the app writes it (amounts in hundredths). */
function seedGoal(id: string, members: Record<string, string>, extra: Record<string, unknown> = {}) {
  const uids = Object.keys(members)
  return db.doc(`sharedGoals/${id}`).set({
    name: 'Run 100 km', unit: 'km', target100: 10_000, endsOn: null, timezone: 'Europe/Berlin', utcOffsetMin: 120,
    zones: members, ownerId: uids[0], createdBy: uids[0], memberIds: uids, invited: [],
    joinedAt: Object.fromEntries(uids.map((u) => [u, ts(CREATED)])), leftAt: {}, totals100: { [uids[0]]: 1200 }, total100: 1200,
    last: null, reachedAt: null, archivedAt: null, createdAt: ts(CREATED), ...extra,
  })
}

function seedCheckin(goalId: string, weekId: string, uid: string, amount100: number) {
  return db.doc(`sharedGoals/${goalId}/checkins/${weekId}_${uid}`).set({ uid, weekId, amount100, note: '', at: ts(at('2026-10-15T10:00:00Z')) })
}

describe('the check-in push', () => {
  /** The week of Oct 12 ends Monday Oct 19, 00:00 Berlin (Sunday 22:00 UTC): Berlin's window is Sunday 16:00–22:00
   *  UTC, Tokyo's (their Sunday evening) 09:00–15:00 UTC. */
  const members = { a: 'Europe/Berlin', b: 'Europe/Berlin', c: 'Europe/Berlin', d: 'Asia/Tokyo' }

  it('goes to each member who hasn’t checked in, in their own window, once; checked in is final; no device stays open', async () => {
    await seedGoal('g1', members)
    await seedCheckin('g1', '2026-10-12', 'a', 1200)
    await device(db, 'a')
    await device(db, 'b')
    await device(db, 'd')
    const push = fakePush()
    // Sunday 12:17 UTC: Tokyo's evening.
    const noon = await runReminders({ db, send: push.send, nowMs: at('2026-10-18T12:17:00Z'), log: quiet })
    // Read: the spaces (none), the goals, d's sent-log key, d's devices and the week's check-ins.
    expect(noon).toMatchObject({ goals: 1, sent: 1, skipped: 0, errors: 0, reads: 5 })
    expect(push.lines()).toEqual(['d | Time to check in | Add your part to Run 100 km for this week. The team is at 12 of 100 km.'])
    expect(push.sent[0]).toMatchObject({ url: './?goal=g1', tag: 'checkin-g1', options: { TTL: 2 * 3600 + 43 * 60, urgency: 'normal' } })
    // Sunday 17:17 UTC (19:17 in Berlin): b; a checked in (final); c has no device (left open).
    expect(await runReminders({ db, send: push.send, nowMs: at('2026-10-18T17:17:00Z'), log: quiet })).toMatchObject({ sent: 1, skipped: 1, errors: 0 })
    expect(push.lines().slice(1)).toEqual(['b | Time to check in | Add your part to Run 100 km for this week. The team is at 12 of 100 km.'])
    expect(push.sent[1].options.TTL).toBe(4 * 3600 + 43 * 60)
    expect(await sentLog(db)).toEqual({ 'g1_2026-10-12_checkin_a': 'skipped', 'g1_2026-10-12_checkin_b': 'Time to check in', 'g1_2026-10-12_checkin_d': 'Time to check in' })
    expect((await data('_private/sent/log/g1_2026-10-12_checkin_b'))).toMatchObject({ kind: 'checkin', goalId: 'g1', uid: 'b', spaceId: '' })
    // c turns reminders on within the window: still theirs. Then nothing goes out twice.
    await device(db, 'c')
    await runReminders({ db, send: push.send, nowMs: at('2026-10-18T18:17:00Z'), log: quiet })
    await runReminders({ db, send: push.send, nowMs: at('2026-10-18T19:17:00Z'), log: quiet })
    expect(push.lines().slice(2)).toEqual(['c | Time to check in | Add your part to Run 100 km for this week. The team is at 12 of 100 km.'])
  })

  it('nothing outside the windows, and no goal is read outside Saturday 15:00 → Monday 13:00 UTC', async () => {
    await seedGoal('g1', members)
    await device(db, 'b')
    const push = fakePush()
    // Saturday 16:17 UTC: the gate is open, nobody's window is: just the goals query.
    expect(await runReminders({ db, send: push.send, nowMs: at('2026-10-17T16:17:00Z'), log: quiet })).toMatchObject({ goals: 1, sent: 0, reads: 2 })
    // Wednesday: no goal is read.
    expect(await runReminders({ db, send: push.send, nowMs: at('2026-10-14T18:17:00Z'), log: quiet })).toMatchObject({ goals: 0, sent: 0, reads: 1 })
    // Monday 13:17 UTC: closed again.
    expect(await runReminders({ db, send: push.send, nowMs: at('2026-10-19T13:17:00Z'), log: quiet })).toMatchObject({ goals: 0, reads: 1 })
    expect(push.sent).toEqual([])
  })

  it('none after finishing, after the end date, or while reached; joined after the window opened: next week', async () => {
    await seedGoal('done', members, { archivedAt: ts(at('2026-10-16T10:00:00Z')) })
    await seedGoal('ended', members, { endsOn: '2026-10-16' })
    await seedGoal('reached', members, { total100: 10_400, reachedAt: ts(at('2026-10-16T10:00:00Z')) })
    await seedGoal('late', { e: 'Europe/Berlin' }, { joinedAt: { e: ts(at('2026-10-18T16:30:00Z')) } })
    await db.doc('sharedGoals/bad_id').set({ name: 'x', archivedAt: null })
    for (const uid of ['a', 'b', 'c', 'd', 'e']) await device(db, uid)
    const push = fakePush()
    const logs: string[] = []
    // The finished goal isn't in the query; the others cost their doc alone.
    const summary = await runReminders({ db, send: push.send, nowMs: at('2026-10-18T17:17:00Z'), log: (m) => logs.push(m) })
    expect(summary).toMatchObject({ goals: 3, sent: 0, errors: 0, reads: 5 })
    expect(logs).toContain('goal "bad_id" skipped: not a goal id')
    expect(push.sent).toEqual([])
  })

  it('costs: steady runs, a week-close run, and Sunday-evening runs with three goals', async () => {
    // Two spaces of three, a week played in each, scores already written for it.
    for (const s of ['s1', 's2']) {
      const ids = s === 's1' ? ['a', 'b', 'c'] : ['d', 'e', 'f']
      await seedSpace(db, s, ids)
      for (const uid of ids) {
        await profile(db, uid, uid.toUpperCase())
        await device(db, uid)
      }
      await playWeek(s, '2026-10-05', ids)
      await playWeek(s, '2026-10-12', ids)
      await scoresWritten(db, s, ['2026-10-05'])
    }
    const reads: Record<string, number> = {}
    const run = async (name: string, iso: string) => {
      const summary = await runReminders({ db, send: noPush, nowMs: at(iso), log: quiet })
      expect(summary.errors).toBe(0)
      reads[name] = summary.reads
    }
    // Wednesday night and day: the spaces (2), each space's scores marker; by day each space's changed-stakes query.
    await run('night', '2026-10-14T02:17:00Z')
    await run('day', '2026-10-14T12:17:00Z')
    // Saturday 00:17 UTC: the week of Oct 12 has just closed: each space reads its marker, October's weeks so far
    // (docs, plans, progress, reviews), its 3 profiles and 3 scores docs, then writes 3 × 3 docs.
    await run('week close', '2026-10-17T00:17:00Z')
    await run('after', '2026-10-17T01:17:00Z')

    // Three goals, no spaces, on Sunday evening (Berlin): g1 has a due (b, after a's check-in) and Tokyo's d, whose
    // window is over; g2 two due; g3's New York member is due too.
    await clear()
    for (const uid of ['a', 'b', 'c', 'd', 'e', 'f']) await device(db, uid)
    await seedGoal('g1', { a: 'Europe/Berlin', b: 'Europe/Berlin', d: 'Asia/Tokyo' })
    await seedGoal('g2', { c: 'Europe/Berlin', e: 'Europe/Berlin' })
    await seedGoal('g3', { f: 'America/New_York' })
    await seedCheckin('g1', '2026-10-12', 'a', 1200)
    // The spaces (none: 1) and the goals (3); per goal, the sent-log keys of the members whose window is open, their
    // devices and the week's check-ins. An hour later, only the keys (all sent or final by then).
    await run('sunday evening', '2026-10-18T17:17:00Z')
    await run('sunday later', '2026-10-18T18:17:00Z')
    expect(reads).toEqual({ night: 4, day: 6, 'week close': 62, after: 4, 'sunday evening': 17, 'sunday later': 9 })
  })
})
