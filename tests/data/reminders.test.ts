// The hourly reminders job (scripts/reminders.ts) against the data emulator, with a fake push sender.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deleteApp, initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore'
import { runReminders, type PushKeys, type SendOptions } from '../../scripts/reminders.ts'
import { weekBounds } from '../../src/domain/time.ts'

const PROJECT = 'demo-stakes'
const FIRESTORE = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8180'
process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE

const app = initializeApp({ projectId: PROJECT }, 'reminders-test')
const db = getFirestore(app)
afterAll(() => deleteApp(app))

beforeEach(async () => {
  // Retried: right after another test file the emulator sometimes answers 500 once.
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`http://${FIRESTORE}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' })
    if (res.ok) return
    if (attempt === 5) throw new Error(`Could not clear the emulator: ${res.status}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
})

const at = (iso: string) => Date.parse(iso)
const ts = (ms: number) => Timestamp.fromMillis(ms)
/** Monday 2026-10-12, 18:17 UTC: the Monday 'plan' window is open in a UTC space. */
const MONDAY_EVENING = at('2026-10-12T18:17:00Z')

function space(id: string, memberIds: string[], extra: Record<string, unknown> = {}) {
  const t = ts(at('2026-09-01T00:00:00Z'))
  return db.doc(`spaces/${id}`).set({
    name: id, reward: 'Dinner on me', penalty: 'Coffee for a week', ownerId: memberIds[0], memberIds,
    joinedAt: Object.fromEntries(memberIds.map((m) => [m, t])), timezone: 'UTC', utcOffsetMin: 0, inviteCode: 'ABCD2345',
    threshold: 90, latePenalty: 5, createdAt: t, ...extra,
  })
}

function device(uid: string, id: string, endpoint: string, createdAt: number) {
  return db.doc(`users/${uid}/push/${id}`).set({ endpoint, keys: { p256dh: 'p', auth: 'a' }, createdAt: ts(createdAt), ua: 'test' })
}

/** A fake push service: records every send; endpoints containing "hang" never answer. */
function fakePush() {
  const sent: { endpoint: string; title: string; body: string; options: SendOptions }[] = []
  const send = (sub: PushKeys, payload: string, options: SendOptions) => {
    if (sub.endpoint.includes('hang')) return new Promise<never>(() => {})
    const { title, body } = JSON.parse(payload) as { title: string; body: string }
    sent.push({ endpoint: sub.endpoint, title, body, options })
    return Promise.resolve()
  }
  return { sent, send }
}

const quiet = () => {}

describe('reminders job', () => {
  it('a push service that never answers costs one delivery, not the run', async () => {
    await space('s1', ['a'])
    await device('a', 'ok', 'https://fcm.googleapis.com/fcm/send/ok', at('2026-10-01T00:00:00Z'))
    await device('a', 'stuck', 'https://fcm.googleapis.com/fcm/send/hang', at('2026-10-02T00:00:00Z'))
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
    await device('slow', 'd', 'https://web.push.apple.com/hang', at('2026-10-01T00:00:00Z'))
    await device('fine', 'd', 'https://web.push.apple.com/ok', at('2026-10-01T00:00:00Z'))
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
    await device('b', 'd', 'https://updates.push.services.mozilla.com/wpush/v2/x', at('2026-10-01T00:00:00Z'))
    const push = fakePush()
    const logs: string[] = []
    const summary = await runReminders({ db, send: push.send, nowMs: MONDAY_EVENING, log: (m) => logs.push(m) })
    expect(summary).toMatchObject({ skippedSpaces: 1, errors: 0, sent: 1 })
    expect(logs.join('\n')).toContain('unsupported timezone "Foo/Bar"')
  })

  it('sends to the 5 newest subscriptions on real push services only', async () => {
    await space('s1', ['a'])
    for (let i = 0; i < 7; i++) await device('a', `d${i}`, `https://web.push.apple.com/d${i}`, at('2026-10-01T00:00:00Z') + i * 60_000)
    await device('a', 'evil', 'https://push.example.com/newest', at('2026-10-11T00:00:00Z'))
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
    await device('a', 'd', 'https://web.push.apple.com/a', at('2026-10-01T00:00:00Z'))
    const push = fakePush()
    await runReminders({ db, send: push.send, nowMs: at('2026-10-10T09:17:00Z'), log: quiet })
    expect(push.sent.map((p) => `${p.title} | ${p.body}`)).toEqual(['Results are in | You scored 75%. See how s1 did this week.'])
  })

  it('the verdict quotes the stakes frozen for the month, and spaces get their utcOffsetMin backfilled', async () => {
    // b lost October, then edited the penalty; the frozen October stakes still apply.
    await space('s1', ['a', 'b'], { penalty: 'A high five' })
    // A space from before utcOffsetMin existed.
    await db.doc('spaces/s1').update({ utcOffsetMin: FieldValue.delete() })
    await db.doc('spaces/s1/months/2026-10').set({ reward: 'Dinner on me', penalty: 'Coffee for a week', createdAt: ts(at('2026-10-01T00:00:00Z')) })
    const W = '2026-10-05'
    const b = weekBounds(W, 'UTC')
    await db.doc(`spaces/s1/weeks/${W}`).set({
      startAt: ts(b.startAt), lockAt: ts(b.lockAt), reviewOpenAt: ts(b.reviewOpenAt), deadlineAt: ts(b.deadlineAt), members: ['a', 'b'], submittedBy: ['a', 'b'],
    })
    await db.doc(`spaces/s1/weeks/${W}/plans/a`).set({ tasks: [{ id: 'a1', title: 'A' }], updatedAt: ts(b.startAt) })
    await db.doc(`spaces/s1/weeks/${W}/plans/b`).set({ tasks: [{ id: 'b1', title: 'B' }], updatedAt: ts(b.startAt) })
    await db.doc(`spaces/s1/weeks/${W}/reviews/a_b`).set({ reviewerId: 'a', revieweeId: 'b', marks: { b1: 0 }, submittedAt: ts(b.reviewOpenAt) })
    await db.doc(`spaces/s1/weeks/${W}/reviews/b_a`).set({ reviewerId: 'b', revieweeId: 'a', marks: { a1: 1 }, submittedAt: ts(b.reviewOpenAt) })
    await device('a', 'd', 'https://web.push.apple.com/a', at('2026-10-01T00:00:00Z'))
    await device('b', 'd', 'https://web.push.apple.com/b', at('2026-10-01T00:00:00Z'))
    const push = fakePush()
    await runReminders({ db, send: push.send, nowMs: at('2026-11-01T10:17:00Z'), log: quiet })
    const verdicts = Object.fromEntries(push.sent.filter((p) => p.title.startsWith('You')).map((p) => [p.endpoint.slice(-1), `${p.title} | ${p.body}`]))
    expect(verdicts).toEqual({
      a: 'You made it: 100% | October in s1 is done. Collect: Dinner on me',
      b: 'You fell short: 0% | October in s1 is done. Pay up: Coffee for a week',
    })
    expect((await db.doc('spaces/s1').get()).get('utcOffsetMin')).toBe(0)
  })
})
