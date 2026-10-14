// The hourly reminders job (scripts/reminders.ts) against the data emulator, with a fake push sender.
// Month results (the results writer) are in reminders-results.test.ts.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { FieldValue } from 'firebase-admin/firestore'
import { runReminders } from '../../scripts/reminders.ts'
import { weekBounds } from '../../src/domain/time.ts'
import { allReviews, at, clear, connect, device, fakePush, profile, quiet, recording, seedList, seedSpace, seedStakes, seedWeek, sentLog, ts } from './reminders-fixtures.ts'

const { db, close } = connect('reminders-test')
afterAll(close)
beforeEach(clear)

/** Monday 2026-10-12, 18:17 UTC: the Monday 'plan' window is open in a UTC space. */
const MONDAY_EVENING = at('2026-10-12T18:17:00Z')
const space = (id: string, memberIds: string[], extra: Record<string, unknown> = {}) => seedSpace(db, id, memberIds, extra)

describe('reminders job', () => {
  it('a push service that never answers costs one delivery, not the run', async () => {
    await space('s1', ['a'])
    await device(db, 'a', 'ok', 'https://fcm.googleapis.com/fcm/send/ok', at('2026-10-01T00:00:00Z'))
    await device(db, 'a', 'stuck', 'https://fcm.googleapis.com/fcm/send/hang', at('2026-10-02T00:00:00Z'))
    const push = fakePush()
    const started = Date.now()
    const summary = await runReminders({ db, send: push.send, nowMs: MONDAY_EVENING, log: quiet, sendTimeoutMs: 300 })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(summary).toMatchObject({ sent: 1, devices: 1, failedDeliveries: 1, errors: 0 })
    expect(push.sent).toEqual([expect.objectContaining({ endpoint: 'https://fcm.googleapis.com/fcm/send/ok', title: 'Lock in your week' })])
    expect(push.sent[0].options.timeout).toBe(300)
  })

  it('a space over its time budget is left for the next run; the others still go out', async () => {
    await space('a-slow', ['slow'])
    await space('b-fine', ['fine'])
    await device(db, 'slow', 'd', 'https://web.push.apple.com/hang')
    await device(db, 'fine', 'd', 'https://web.push.apple.com/ok')
    const push = fakePush()
    const logs: string[] = []
    const summary = await runReminders({ db, send: push.send, nowMs: MONDAY_EVENING, log: (m) => logs.push(m), sendTimeoutMs: 2_000, spaceBudgetMs: 200 })
    expect(summary).toMatchObject({ skippedSpaces: 1, errors: 0, sent: 1 })
    expect(push.sent.map((p) => p.endpoint)).toEqual(['https://web.push.apple.com/ok'])
    expect(logs.some((l) => l.includes('a-slow') && l.includes('budget'))).toBe(true)
    // Let the abandoned send time out before the next test clears the database.
    await new Promise((resolve) => setTimeout(resolve, 2_100))
  })

  it('an unsupported timezone skips that space and does not fail the run', async () => {
    await space('bad', ['a'], { timezone: 'Foo/Bar' })
    await space('good', ['b'])
    await device(db, 'b', 'd', 'https://updates.push.services.mozilla.com/wpush/v2/x')
    const push = fakePush()
    const logs: string[] = []
    const summary = await runReminders({ db, send: push.send, nowMs: MONDAY_EVENING, log: (m) => logs.push(m) })
    expect(summary).toMatchObject({ skippedSpaces: 1, errors: 0, sent: 1 })
    expect(logs.join('\n')).toContain('unsupported timezone "Foo/Bar"')
  })

  it('sends to the 5 newest subscriptions on real push services only', async () => {
    await space('s1', ['a'])
    for (let i = 0; i < 7; i++) await device(db, 'a', `d${i}`, `https://web.push.apple.com/d${i}`, at('2026-10-01T00:00:00Z') + i * 60_000)
    await device(db, 'a', 'evil', 'https://push.example.com/newest', at('2026-10-11T00:00:00Z'))
    const push = fakePush()
    await runReminders({ db, send: push.send, nowMs: MONDAY_EVENING, log: quiet })
    expect(push.sent.map((p) => p.endpoint).sort()).toEqual(['d2', 'd3', 'd4', 'd5', 'd6'].map((d) => `https://web.push.apple.com/${d}`))
  })

  it('reads tasks with steps and tasks added after the lock like the app does', async () => {
    // Alone in the space, so nobody reviews a: the score is a's own check-offs, steps as fractions.
    await space('s1', ['a'])
    const W = '2026-10-05'
    const b = weekBounds(W, 'UTC')
    await db.doc(`spaces/s1/weeks/${W}`).set({
      startAt: ts(b.startAt), lockAt: ts(b.lockAt), reviewOpenAt: ts(b.reviewOpenAt), deadlineAt: ts(b.deadlineAt), members: ['a'], submittedBy: [],
    })
    await db.doc(`spaces/s1/weeks/${W}/plans/a`).set({
      tasks: [{ id: 'a1', title: 'Shoot', subs: ['s1|Scout', 's2|Rent a lens'] }, { id: 'a2', title: 'Client work' }],
      added: { a2: ts(b.lockAt + 3_600_000) },
      updatedAt: ts(b.lockAt + 3_600_000),
    })
    // a1's own key is ignored: it has steps, and one of two is ticked.
    await db.doc(`spaces/s1/weeks/${W}/progress/a`).set({ done: { a1: true, s1: true, a2: true }, updatedAt: ts(b.lockAt) })
    await device(db, 'a')
    const push = fakePush()
    await runReminders({ db, send: push.send, nowMs: at('2026-10-10T09:17:00Z'), log: quiet })
    expect(push.sent.map((p) => `${p.title} | ${p.body}`)).toEqual(['Results are in | You scored 75%. See how s1 did this week.'])
  })

  it('nudges midweek: nothing ticked on Wednesday, tasks still open on Thursday, each once', async () => {
    // a: two tasks, and only a tick left by a task deleted before the lock. b: one task with two steps,
    // one ticked. c: no tasks. d: left after the lock (still in the week). e: joined after the lock.
    // f: nothing ticked, but no device.
    const t = ts(at('2026-09-01T00:00:00Z'))
    await space('s1', ['a', 'b', 'c', 'e', 'f'], {
      joinedAt: { a: t, b: t, c: t, e: ts(at('2026-10-13T09:00:00Z')), f: t },
      leftAt: { d: ts(at('2026-10-13T12:00:00Z')) },
    })
    const W = '2026-10-12'
    const b = weekBounds(W, 'UTC')
    await db.doc(`spaces/s1/weeks/${W}`).set({
      startAt: ts(b.startAt), lockAt: ts(b.lockAt), reviewOpenAt: ts(b.reviewOpenAt), deadlineAt: ts(b.deadlineAt), members: ['a', 'b', 'c', 'd', 'f'], submittedBy: [],
    })
    const plans = {
      a: [{ id: 'a1', title: 'Shoot' }, { id: 'a2', title: 'Edit' }],
      b: [{ id: 'b1', title: 'Pitch', subs: ['b1x|Draft', 'b1y|Send'] }],
      d: [{ id: 'd1', title: 'Run' }],
      f: [{ id: 'f1', title: 'Read' }],
    }
    for (const [uid, tasks] of Object.entries(plans)) await db.doc(`spaces/s1/weeks/${W}/plans/${uid}`).set({ tasks, updatedAt: ts(b.startAt) })
    await db.doc(`spaces/s1/weeks/${W}/progress/a`).set({ done: { gone: true }, updatedAt: ts(b.startAt) })
    await db.doc(`spaces/s1/weeks/${W}/progress/b`).set({ done: { b1x: true }, updatedAt: ts(b.lockAt) })
    for (const uid of ['a', 'b', 'c', 'd', 'e']) await device(db, uid)
    const push = fakePush()
    const lines = () => push.sent.map((p) => `${p.endpoint.slice(-1)} | ${p.title} | ${p.body}`)

    // Wednesday 18:17 and an hour later.
    const wednesday = at('2026-10-14T18:17:00Z')
    const reads = recording(db)
    expect(await runReminders({ db: reads.db, send: push.send, nowMs: wednesday, log: quiet })).toMatchObject({ sent: 1, skipped: 1, errors: 0 })
    expect(lines()).toEqual(['a | Nothing ticked yet | Halfway through the week in s1. 2 tasks to go before Friday.'])
    // Only the plans of participants waiting with a device and the progress of those with tasks: none
    // for c (no tasks), nothing for f (no device), no reviews and no profiles.
    expect(reads.paths.filter((path) => !path.startsWith('_private/'))).toEqual([
      `spaces/s1/weeks/${W}/plans/a`,
      `spaces/s1/weeks/${W}/plans/b`,
      `spaces/s1/weeks/${W}/plans/c`,
      `spaces/s1/weeks/${W}/progress/a`,
      `spaces/s1/weeks/${W}/progress/b`,
    ])
    // It lapses at Thursday 00:00, the end of its window.
    expect(push.sent[0].options).toMatchObject({ TTL: 5 * 3600 + 43 * 60, urgency: 'normal' })
    // e is outside the week for good; b, c and f can still change, so they aren't logged.
    expect(await sentLog(db)).toEqual({ 's1_2026-10-12_no-progress_a': 'Nothing ticked yet', 's1_2026-10-12_no-progress_e': 'skipped' })
    expect(await runReminders({ db, send: push.send, nowMs: wednesday + 3_600_000, log: quiet })).toMatchObject({ sent: 0, skipped: 0 })
    expect(push.sent).toHaveLength(1)

    // Thursday 18:17: a gets the second nudge too, and b's half-done task is still open.
    const thursday = at('2026-10-15T18:17:00Z')
    expect(await runReminders({ db, send: push.send, nowMs: thursday, log: quiet })).toMatchObject({ sent: 2, errors: 0 })
    expect(lines().slice(1)).toEqual([
      'a | 2 of 2 tasks still open | Reviews in s1 start in 6 hours. Finish what you can before then.',
      'b | 1 of 1 task still open | Reviews in s1 start in 6 hours. Finish what you can before then.',
    ])
    expect(await sentLog(db)).toEqual({
      's1_2026-10-12_no-progress_a': 'Nothing ticked yet',
      's1_2026-10-12_no-progress_e': 'skipped',
      's1_2026-10-12_open-tasks_a': '2 of 2 tasks still open',
      's1_2026-10-12_open-tasks_b': '1 of 1 task still open',
      's1_2026-10-12_open-tasks_e': 'skipped',
    })
    // A rerun, or a run delayed to the last minute, sends nothing twice.
    await runReminders({ db, send: push.send, nowMs: thursday, log: quiet })
    await runReminders({ db, send: push.send, nowMs: at('2026-10-15T23:59:00Z'), log: quiet })
    expect(push.sent).toHaveLength(3)
  })

  it('a dry run shows a nudge without sending or logging it', async () => {
    await space('s1', ['a'])
    await seedWeek(db, 's1', '2026-10-12', { members: ['a'], plans: { a: 1 } })
    await device(db, 'a')
    const push = fakePush()
    const logs: string[] = []
    const summary = await runReminders({ db, send: push.send, nowMs: at('2026-10-14T18:17:00Z'), dryRun: true, log: (m) => logs.push(m) })
    expect(summary).toMatchObject({ sent: 1, errors: 0 })
    expect(push.sent).toEqual([])
    expect(logs).toEqual(['[dry run] s1_2026-10-12_no-progress_a → 1 device(s): Nothing ticked yet · Halfway through the week in s1. 1 task to go before Friday.'])
    expect((await db.collection('_private/sent/log').get()).empty).toBe(true)
  })

  it('the verdict quotes the month’s house stakes frozen at completion, and spaces get their utcOffsetMin backfilled', async () => {
    // b lost October, then the owner edited the penalty; October was frozen when it ended, so its stakes hold.
    await space('s1', ['a', 'b'], { penalty: 'A high five' })
    // A space from before utcOffsetMin existed.
    await db.doc('spaces/s1').update({ utcOffsetMin: FieldValue.delete() })
    await db.doc('spaces/s1/months/2026-10').set({ reward: 'Dinner on me', penalty: 'Coffee for a week', createdAt: ts(at('2026-10-31T09:00:00Z')) })
    await seedWeek(db, 's1', '2026-10-05', { members: ['a', 'b'], plans: { a: 1, b: 1 }, submittedBy: ['a', 'b'], reviews: allReviews(['a', 'b'], { b: 0 }) })
    await device(db, 'a')
    await device(db, 'b')
    const push = fakePush()
    await runReminders({ db, send: push.send, nowMs: at('2026-11-01T10:17:00Z'), log: quiet })
    expect(push.lines().filter((l) => l.includes('October'))).toEqual([
      'a | You made it: 100% | October in s1 is done. Collect: Dinner on me',
      'b | You fell short: 0% | October in s1 is done. Pay up: Coffee for a week',
    ])
    expect((await db.doc('spaces/s1').get()).get('utcOffsetMin')).toBe(0)
  })
})

describe('reminders job, batch 2', () => {
  it('after a recent change of times, reads last, this and next week first and goes by their stored times', async () => {
    // Lists now lock Tuesday at noon, but this week was created on the usual times (too late to retime): its
    // plan push still opens Monday 18:00 and counts to its stored lock, Tuesday 00:00.
    const noteAt = at('2026-10-12T10:00:00Z')
    await space('s1', ['a', 'b', 'c'], {
      schedule: { lock: 2160, reviewOpen: 5760, deadline: 7200 },
      scheduleNote: { by: 'a', at: ts(noteAt), fromWeek: '2026-10-19', before: { lock: 1440, reviewOpen: 5760, deadline: 7200 } },
      joinedAt: { a: ts(at('2026-09-01T00:00:00Z')), b: ts(at('2026-09-01T00:00:00Z')), c: ts(noteAt + 3_600_000) },
    })
    await seedWeek(db, 's1', '2026-10-12', { members: ['a', 'b', 'c'], plans: { b: 1 } })
    for (const [uid, name] of [['a', 'Anna'], ['b', 'Ben'], ['c', 'Chris']]) {
      await device(db, uid)
      await profile(db, uid, name)
    }
    const push = fakePush()
    const reads = recording(db)
    await runReminders({ db: reads.db, send: push.send, nowMs: at('2026-10-12T19:17:00Z'), log: quiet })
    expect(reads.paths.slice(0, 3)).toEqual(['spaces/s1/weeks/2026-10-05', 'spaces/s1/weeks/2026-10-12', 'spaces/s1/weeks/2026-10-19'])
    expect(push.lines()).toEqual([
      'a | Lock in your week | Your list for s1 locks in 5 hours. Nothing planned = 0%.',
      'c | Lock in your week | Your list for s1 locks in 5 hours. Nothing planned = 0%.',
      // The schedule push: once, to whoever was there before the change, not the owner.
      'b | New times in s1 | Anna changed them. From next week, lists lock Tuesday at noon, UTC time.',
    ])
    expect(push.sent[2]).toMatchObject({ url: './?space=s1', tag: 'schedule-s1' })
    expect(await sentLog(db)).toMatchObject({ [`s1_2026-10-19@${noteAt}_schedule_a`]: 'skipped', [`s1_2026-10-19@${noteAt}_schedule_c`]: 'skipped' })
    await runReminders({ db, send: push.send, nowMs: at('2026-10-12T20:17:00Z'), log: quiet })
    expect(push.sent).toHaveLength(3)
  })

  it('a paused week reads nothing for its windows and sends nothing', async () => {
    await space('s1', ['a', 'b'], { paused: { '2026-10': '2026-10-12' } })
    await seedWeek(db, 's1', '2026-10-12', { members: ['a', 'b'] })
    await device(db, 'a')
    await device(db, 'b')
    const push = fakePush()
    for (const iso of ['2026-10-12T18:17:00Z', '2026-10-14T18:17:00Z', '2026-10-16T09:17:00Z', '2026-10-16T20:17:00Z', '2026-10-17T09:17:00Z']) {
      // Just the spaces, and the daytime query for changed stakes (the one window open): no week, no sent log.
      expect(await runReminders({ db, send: push.send, nowMs: at(iso), log: quiet })).toMatchObject({ windows: 1, reads: 2, sent: 0 })
    }
    expect(push.sent).toEqual([])
  })

  it('asks for a pause once, only in the daytime, to whoever still has to say OK, until reviews open', async () => {
    const asked = at('2026-10-14T21:30:00Z')
    await space('s1', ['a', 'b', 'c', 'd'], { pause: { weekId: '2026-10-19', by: 'a', at: ts(asked), oks: ['a', 'b'] } })
    // Dana isn't in next week's doc, so nobody waits for her.
    await seedWeek(db, 's1', '2026-10-19', { members: ['a', 'b', 'c'] })
    for (const uid of ['a', 'b', 'c', 'd']) await device(db, uid)
    await profile(db, 'a', 'Anna')
    const push = fakePush()
    for (const iso of ['2026-10-14T21:45:00Z', '2026-10-15T03:17:00Z', '2026-10-15T08:17:00Z']) await runReminders({ db, send: push.send, nowMs: at(iso), log: quiet })
    expect(push.sent).toEqual([])
    await runReminders({ db, send: push.send, nowMs: at('2026-10-15T09:17:00Z'), log: quiet })
    expect(push.lines()).toEqual(['c | Pause a week? | Anna wants to pause s1 for the week of Oct 19. It only happens if everyone says OK.'])
    expect(push.sent[0]).toMatchObject({ url: './?space=s1', tag: 'pause-s1', options: { urgency: 'normal' } })
    const period = `2026-10-19@${asked}`
    const log = Object.fromEntries(Object.entries(await sentLog(db)).filter(([key]) => key.includes('_pause-ask_')))
    expect(log).toEqual({
      [`s1_${period}_pause-ask_a`]: 'skipped',
      [`s1_${period}_pause-ask_b`]: 'skipped',
      [`s1_${period}_pause-ask_c`]: 'Pause a week?',
      [`s1_${period}_pause-ask_d`]: 'skipped',
    })
    await runReminders({ db, send: push.send, nowMs: at('2026-10-16T12:17:00Z'), log: quiet })
    expect(push.sent).toHaveLength(1)
  })

  it('judges get the review push and never the plan push; they hear when results are in', async () => {
    await space('s1', ['a', 'b', 'c'], { judges: ['c'] })
    await seedWeek(db, 's1', '2026-10-12', { members: ['a', 'b', 'c'], judges: ['c'], plans: { a: 1 } })
    for (const [uid, name] of [['a', 'Anna'], ['b', 'Ben'], ['c', 'Chris']]) {
      await device(db, uid)
      await profile(db, uid, name)
    }
    const push = fakePush()
    await runReminders({ db, send: push.send, nowMs: MONDAY_EVENING, log: quiet })
    expect(push.lines()).toEqual(['b | Lock in your week | Your list for s1 locks in 6 hours. Nothing planned = 0%.'])
    await runReminders({ db, send: push.send, nowMs: at('2026-10-16T09:17:00Z'), log: quiet })
    expect(push.lines().slice(1)).toEqual(['b | Review day | Rate Anna in s1. Due in 15 hours.', 'c | Review day | Rate Anna in s1. Due in 15 hours.'])
    // Everyone submits: revealed.
    await db.doc('spaces/s1/weeks/2026-10-12').update({ submittedBy: ['a', 'b', 'c'] })
    await db.doc('spaces/s1/weeks/2026-10-12/reviews/b_a').set({ reviewerId: 'b', revieweeId: 'a', marks: { a1: 1 }, submittedAt: ts(at('2026-10-16T10:00:00Z')) })
    await runReminders({ db, send: push.send, nowMs: at('2026-10-17T09:17:00Z'), log: quiet })
    expect(push.lines().slice(3)).toEqual([
      'a | Results are in | You scored 100%. See how s1 did this week.',
      'b | Results are in | You scored 0%. See how s1 did this week.',
      'c | Results are in | See how s1 did this week.',
    ])
  })

  it('the verdict waits for a month whose last deadline spills into the 3rd', async () => {
    // Reviews due Sunday at midnight: July 2026 (last Friday the 31st) completes Monday Aug 3.
    const schedule = { lock: 1440, reviewOpen: 5760, deadline: 10080 }
    await space('s1', ['a', 'b'], { schedule })
    await seedWeek(db, 's1', '2026-07-27', { members: ['a', 'b'], schedule, plans: { a: 1, b: 1 }, submittedBy: ['a', 'b'], reviews: allReviews(['a', 'b']) })
    await device(db, 'a')
    await device(db, 'b')
    const push = fakePush()
    await runReminders({ db, send: push.send, nowMs: at('2026-08-01T10:17:00Z'), log: quiet })
    await runReminders({ db, send: push.send, nowMs: at('2026-08-02T10:17:00Z'), log: quiet })
    expect(push.lines().filter((l) => l.includes('July'))).toEqual([])
    await runReminders({ db, send: push.send, nowMs: at('2026-08-03T10:17:00Z'), log: quiet })
    expect(push.lines().filter((l) => l.includes('July'))).toEqual([
      'a | You made it: 100% | July in s1 is done. Collect: Dinner on me',
      'b | You made it: 100% | July in s1 is done. Collect: Dinner on me',
    ])
  })

  it('in a month’s last week, loads its list and carries it in the same push, logging both keys', async () => {
    await space('s1', ['a', 'b', 'c'])
    await seedWeek(db, 's1', '2026-10-26', { members: ['a', 'b', 'c'], plans: { a: 1, b: 1, c: 1 } })
    await seedList(db, 's1', '2026-10', { members: ['a', 'b', 'c'], plans: { a: 1, b: 1 } })
    for (const [uid, name] of [['a', 'Anna'], ['b', 'Ben'], ['c', 'Chris']]) {
      await device(db, uid)
      await profile(db, uid, name)
    }
    const push = fakePush()
    await runReminders({ db, send: push.send, nowMs: at('2026-10-30T09:17:00Z'), log: quiet })
    expect(push.lines()).toEqual([
      'a | Review day | Rate Ben and Chris in s1, October lists too. Due in 15 hours.',
      'b | Review day | Rate Anna and Chris in s1, October lists too. Due in 15 hours.',
      'c | Review day | Rate Anna and Ben in s1, October lists too. Due in 15 hours.',
    ])
    const log = await sentLog(db)
    for (const uid of ['a', 'b', 'c']) {
      expect(log[`s1_2026-10-26_review_${uid}`]).toBe('Review day')
      expect(log[`s1_2026-10_review_${uid}`]).toBe('Review day')
    }
    await runReminders({ db, send: push.send, nowMs: at('2026-10-30T10:17:00Z'), log: quiet })
    expect(push.sent).toHaveLength(3)
    // Ben submits his week but not his list: his last call is for the list alone.
    await db.doc('spaces/s1/weeks/2026-10-26').update({ submittedBy: ['b'] })
    await runReminders({ db, send: push.send, nowMs: at('2026-10-30T20:17:00Z'), log: quiet })
    expect(push.lines().slice(3)).toEqual([
      'a | 4 hours left | Miss the s1 deadline and you lose 15 points.',
      'b | 4 hours left | Miss the s1 deadline and you lose 5 points.',
      'c | 4 hours left | Miss the s1 deadline and you lose 20 points.',
    ])
  })

  it('asks friends to agree to new stakes once, keyed by the change, in the daytime', async () => {
    const updatedAt = at('2026-10-13T12:00:00Z')
    await space('s1', ['a', 'b', 'c', 'd'], { judges: ['d'] })
    await seedStakes(db, 's1', 'b', { rewardMode: 'group', penaltyMode: 'group', reward: 'Lunch', penalty: 'Coffee', tiers: [] }, { c: updatedAt + 60_000 }, updatedAt)
    for (const [uid, name] of [['a', 'Anna'], ['b', 'Ben'], ['c', 'Chris'], ['d', 'Dana']]) {
      await device(db, uid)
      await profile(db, uid, name)
    }
    const push = fakePush()
    await runReminders({ db, send: push.send, nowMs: at('2026-10-14T21:17:00Z'), log: quiet })
    expect(push.sent).toEqual([])
    const summary = await runReminders({ db, send: push.send, nowMs: at('2026-10-15T12:17:00Z'), log: quiet })
    expect(push.lines()).toEqual(['a | New stakes from Ben | Ben has new stakes in s1. Take a look, and tap Agree if you’re in.'])
    expect(push.sent[0]).toMatchObject({ url: './?space=s1', tag: 'stakes-s1' })
    const log = Object.fromEntries(Object.entries(await sentLog(db)).filter(([key]) => key.includes('_stakes_')))
    expect(log).toEqual({ [`s1_b@${updatedAt}_stakes_a`]: 'New stakes from Ben' })
    expect(summary.reads).toBeGreaterThanOrEqual(3)
    await runReminders({ db, send: push.send, nowMs: at('2026-10-15T13:17:00Z'), log: quiet })
    expect(push.sent).toHaveLength(1)
  })

  it('tells everyone who was there that the house stakes changed, once', async () => {
    const changed = at('2026-10-14T10:00:00Z')
    await space('s1', ['a', 'b', 'c'], {
      stakesNote: { by: 'a', at: ts(changed) },
      joinedAt: { a: ts(at('2026-09-01T00:00:00Z')), b: ts(at('2026-09-01T00:00:00Z')), c: ts(changed + 60_000) },
    })
    for (const [uid, name] of [['a', 'Anna'], ['b', 'Ben'], ['c', 'Chris']]) {
      await device(db, uid)
      await profile(db, uid, name)
    }
    const push = fakePush()
    await runReminders({ db, send: push.send, nowMs: at('2026-10-14T10:17:00Z'), log: quiet })
    await runReminders({ db, send: push.send, nowMs: at('2026-10-14T11:17:00Z'), log: quiet })
    expect(push.lines()).toEqual([
      'b | New house stakes in s1 | Anna changed them: “Dinner on me” if you hit 90%, “Coffee for a week” if you miss. They count now, where friends haven’t agreed on their own.',
    ])
    expect(push.sent[0]).toMatchObject({ url: './?space=s1', tag: 'stakes-s1' })
    expect(await sentLog(db)).toEqual({ [`s1_house@${changed}_house_a`]: 'skipped', [`s1_house@${changed}_house_b`]: 'New house stakes in s1', [`s1_house@${changed}_house_c`]: 'skipped' })
  })

  it('sends nothing between 00:00 and 08:00 local, and reads nothing for its windows', async () => {
    await space('s1', ['a', 'b'])
    await seedWeek(db, 's1', '2026-10-12', { members: ['a', 'b'], plans: { a: 1, b: 1 }, submittedBy: ['a', 'b'], reviews: allReviews(['a', 'b']) })
    await device(db, 'a')
    const push = fakePush()
    // Sunday 03:17: the weekend results window is open.
    expect(await runReminders({ db, send: push.send, nowMs: at('2026-10-18T03:17:00Z'), log: quiet })).toMatchObject({ sent: 0, reads: 1 })
    await runReminders({ db, send: push.send, nowMs: at('2026-10-18T08:17:00Z'), log: quiet })
    expect(push.lines()).toEqual(['a | Results are in | You scored 100%. See how s1 did this week.'])
  })
})
