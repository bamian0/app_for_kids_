// Shared setup for the security rules tests (run with `npm run test:rules`).
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, expect } from 'vitest'
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { DateTime } from 'luxon'
import { doc, serverTimestamp, setDoc, setLogLevel, Timestamp, type DocumentData, type Firestore } from 'firebase/firestore'

// Denied listeners and writes would otherwise log a warning per test.
setLogLevel('silent')

// RULES_FILE runs the suites against another copy of the rules (mutation runs), never the published file's edits.
const RULES = readFileSync(process.env.RULES_FILE ?? new URL('../../firestore.rules', import.meta.url), 'utf8')

export const HOUR = 3_600_000
export const DAY = 24 * HOUR
export const ts = (ms: number): Timestamp => Timestamp.fromMillis(ms)

/** Registers the emulator lifecycle for one test file: fresh rules once, empty database per test.
 *  `rules` replaces the published rules (calendar.test.ts runs them on a moved clock). */
export function useRulesEnv(rules: string = RULES) {
  let env: RulesTestEnvironment
  const clients = new Map<string, Firestore>()

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: 'demo-stakes',
      // `firebase emulators:exec` sets FIRESTORE_EMULATOR_HOST; otherwise assume the default port.
      firestore: process.env.FIRESTORE_EMULATOR_HOST ? { rules } : { rules, host: '127.0.0.1', port: 8080 },
    })
  })
  afterAll(async () => {
    await env?.cleanup()
  })
  beforeEach(async () => {
    await env.clearFirestore()
  })

  /** Client SDK signed in as `uid`, or signed out when omitted. */
  function db(uid?: string): Firestore {
    const key = uid ?? ''
    let client = clients.get(key)
    if (!client) {
      const ctx = uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()
      client = ctx.firestore() as unknown as Firestore
      clients.set(key, client)
    }
    return client
  }

  /** Writes documents with rules disabled. Keys are document paths. */
  async function seed(docs: Record<string, DocumentData>): Promise<void> {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const admin = ctx.firestore() as unknown as Firestore
      await Promise.all(Object.entries(docs).map(([path, data]) => setDoc(doc(admin, path), data)))
    })
  }

  /** Replaces the rules for the rest of this file (the measuring in budget.test.ts). Resolves to
   *  false when the emulator refuses them (e.g. a rule too complex to compile). */
  async function loadRules(next: string): Promise<boolean> {
    const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080'
    const res = await fetch(`http://${host}/emulator/v1/projects/demo-stakes:securityRules`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: next }] } }),
    })
    return res.ok
  }

  /** Empties the database (between measuring attempts). */
  const clear = () => env.clearFirestore()

  return { db, seed, loadRules, clear }
}

function isPermissionDenied(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'permission-denied'
}

export async function allowed(op: Promise<unknown>): Promise<void> {
  try {
    await op
  } catch (e) {
    throw new Error(`expected success, got ${String(e)}`)
  }
}

export async function denied(op: Promise<unknown>): Promise<void> {
  let error: unknown = null
  try {
    await op
  } catch (e) {
    error = e
  }
  expect(isPermissionDenied(error), `expected permission-denied, got ${error === null ? 'success' : String(error)}`).toBe(true)
}

/** Runs each case in order and reports by name every one that was not denied. */
export async function allDenied(cases: Record<string, () => Promise<unknown>>): Promise<void> {
  const notDenied: string[] = []
  for (const [name, run] of Object.entries(cases)) {
    try {
      await run()
      notDenied.push(`${name}: allowed`)
    } catch (e) {
      if (!isPermissionDenied(e)) notDenied.push(`${name}: ${String(e)}`)
    }
  }
  expect(notDenied).toEqual([])
}

// ---------- fixtures ----------

export const CODE = 'ABCD2345'
export const OTHER_CODE = 'WXYZ6789'

/** The zone's UTC offset in minutes right now, as createSpace stores it. */
export const offsetNow = (zone: string): number => DateTime.now().setZone(zone).offset
/** The zone's UTC offset at 00:00 of the day `id` ('YYYY-MM-DD'): a space created in that week's season.
 *  Tests about next week seed it, so they hold in a week before a DST change too. */
export const offsetOn = (zone: string, id: string): number => DateTime.fromISO(id, { zone }).offset

/** A space as stored after creation (seeded with rules disabled). utcOffsetMin follows the timezone
 *  unless given; use legacySpaceDoc for a space from before it existed. */
export function spaceDoc(memberIds: string[], extra: DocumentData = {}): DocumentData {
  const at = ts(Date.now() - 30 * DAY)
  const timezone: string = extra.timezone ?? 'Europe/Berlin'
  return {
    name: 'Film crew',
    reward: 'Dinner on me',
    penalty: 'You buy coffee for a week',
    ownerId: memberIds[0] ?? 'owner',
    memberIds,
    joinedAt: Object.fromEntries(memberIds.map((uid) => [uid, at])),
    timezone,
    utcOffsetMin: offsetNow(timezone),
    inviteCode: CODE,
    threshold: 90,
    latePenalty: 5,
    createdAt: at,
    ...extra,
  }
}

export function legacySpaceDoc(memberIds: string[], extra: DocumentData = {}): DocumentData {
  const { utcOffsetMin: _, ...rest } = spaceDoc(memberIds, extra)
  return rest
}

/** What createSpace writes. */
export function newSpace(uid: string, extra: DocumentData = {}): DocumentData {
  return {
    name: 'Film crew',
    reward: 'Dinner on me',
    penalty: 'You buy coffee for a week',
    ownerId: uid,
    memberIds: [uid],
    joinedAt: { [uid]: serverTimestamp() },
    timezone: 'America/Los_Angeles',
    utcOffsetMin: offsetNow('America/Los_Angeles'),
    inviteCode: CODE,
    threshold: 90,
    latePenalty: 5,
    createdAt: serverTimestamp(),
    ...extra,
  }
}

/** An invite as stored, mirroring spaceDoc's name and stakes. */
export function inviteDoc(spaceId: string, createdBy: string, extra: DocumentData = {}): DocumentData {
  return {
    spaceId, spaceName: 'Film crew', reward: 'Dinner on me', penalty: 'You buy coffee for a week',
    inviterName: 'Alex', createdBy, createdAt: ts(Date.now() - 30 * DAY), ...extra,
  }
}

/** The largest task a plan can hold (SPEC §2 limits): 64-character ids, 120-character titles and 8
 *  steps, stored as "<id>|<title>". Plans of these test the rules' expression budget. */
export function fullTask(i: number): DocumentData {
  const id = (prefix: string) => prefix.padEnd(64, 'x')
  return {
    id: id(`k${i}-`),
    title: 'Ж'.repeat(120),
    subs: Array.from({ length: 8 }, (_, j) => `${id(`s${i}-${j}-`)}|${'Ж'.repeat(120)}`),
  }
}

export type Phase = 'planning' | 'active' | 'review' | 'closed'

/** A week doc whose bounds put `now` in the given phase (request.time is real time). */
export function weekDoc(phase: Phase, members: string[], submittedBy: string[] = []): DocumentData {
  const now = Date.now()
  const startAt = {
    planning: now - 12 * HOUR, // lockAt = now + 12h
    active: now - 2 * DAY, // lockAt = now - 1d, reviewOpenAt = now + 2d
    review: now - 4 * DAY - HOUR, // reviewOpenAt = now - 1h, deadlineAt = now + 23h
    closed: now - 5 * DAY - HOUR, // deadlineAt = now - 1h
  }[phase]
  return {
    startAt: ts(startAt),
    lockAt: ts(startAt + DAY),
    reviewOpenAt: ts(startAt + 4 * DAY),
    deadlineAt: ts(startAt + 5 * DAY),
    members,
    submittedBy,
  }
}

// ---------- batch 2 fixtures ----------

/** The published rules, for files that run a variant of them. */
export const PUBLISHED_RULES = RULES

/** The rules with "now" moved: in validNewWeek, retimesWeek, validNewMonthly and retimesMonthly,
 *  request.time becomes the space doc's `testNow` when it has one (calendar.test.ts). */
export function movedClock(rules: string): string {
  let out = rules
  for (const fn of ['validNewWeek', 'retimesWeek', 'validNewMonthly', 'retimesMonthly']) {
    const start = out.indexOf(`function ${fn}(`)
    const end = out.indexOf('\n      }\n', start)
    if (start < 0 || end < 0) throw new Error(`${fn} not found in firestore.rules`)
    const body = out.slice(start, end)
    const moved = body.replaceAll('request.time', "space.get('testNow', request.time)")
    if (moved === body) throw new Error(`${fn} doesn't read request.time any more`)
    out = out.slice(0, start) + moved + out.slice(end)
  }
  return out
}

export type Schedule = { lock: number; reviewOpen: number; deadline: number }
/** Lists lock Monday at midnight, reviews open Thursday at midnight, due Friday at midnight. */
export const USUAL: Schedule = { lock: 1440, reviewOpen: 5760, deadline: 7200 }
/** SPEC §9.2's example: lists lock Monday at 8:00 PM, reviews open Thursday at midnight, due Saturday at noon. */
export const CUSTOM: Schedule = { lock: 1200, reviewOpen: 5760, deadline: 7920 }

/** The instant `minutes` after the week's Monday 00:00 on the zone's wall clock (whole days through
 *  startOf('day'), the rest through set({hour, minute}), like the domain's momentAt). */
export function momentAt(weekId: string, zone: string, minutes: number): number {
  const days = Math.floor(minutes / 1440)
  const rest = minutes - days * 1440
  const day = DateTime.fromISO(weekId, { zone }).plus({ days }).startOf('day')
  return (rest === 0 ? day : day.set({ hour: Math.floor(rest / 60), minute: rest % 60 })).toMillis()
}

/** Monday (ISO week start, local date) of the week containing now in `zone`, shifted by `weeks`. */
export function mondayOf(zone: string, weeks = 0): string {
  return DateTime.now().setZone(zone).startOf('week').plus({ weeks }).toISODate()!
}

/** A week doc on `schedule` in `zone`, as the data layer creates it (it stores `schedule` only when it
 *  isn't the usual one; pass `extra` to add or override keys). */
export function weekOn(members: string[], weekId: string, zone: string, schedule: Schedule = USUAL, extra: DocumentData = {}): DocumentData {
  const usual = schedule.lock === USUAL.lock && schedule.reviewOpen === USUAL.reviewOpen && schedule.deadline === USUAL.deadline
  return {
    startAt: ts(momentAt(weekId, zone, 0)),
    lockAt: ts(momentAt(weekId, zone, schedule.lock)),
    reviewOpenAt: ts(momentAt(weekId, zone, schedule.reviewOpen)),
    deadlineAt: ts(momentAt(weekId, zone, schedule.deadline)),
    members,
    submittedBy: [],
    ...(usual ? {} : { schedule }),
    ...extra,
  }
}

/** A month's weeks (SPEC §9.5): the week holding its first Friday, the next one (whose lock the list
 *  shares) and the week holding its last Friday (whose review window it shares). */
export function monthWeeks(monthId: string): { first: string; lock: string; last: string } {
  const [y, m] = monthId.split('-').map(Number) as [number, number]
  const firstMonday = (year: number, month: number) => {
    const d = DateTime.utc(year, month, 1)
    return d.plus({ days: ((12 - d.weekday) % 7) - 4 })
  }
  const first = firstMonday(y, m)
  const next = m === 12 ? firstMonday(y + 1, 1) : firstMonday(y, m + 1)
  return { first: first.toISODate()!, lock: first.plus({ days: 7 }).toISODate()!, last: next.minus({ days: 7 }).toISODate()! }
}

/** A monthly list as ensureMonthly creates it: bounds computed on `schedule` in `zone`. */
export function monthlyOn(monthId: string, zone: string, schedule: Schedule, members: string[], judges: string[] = [], extra: DocumentData = {}): DocumentData {
  const w = monthWeeks(monthId)
  return {
    startAt: ts(momentAt(w.first, zone, 0)),
    lockAt: ts(momentAt(w.lock, zone, schedule.lock)),
    reviewOpenAt: ts(momentAt(w.last, zone, schedule.reviewOpen)),
    deadlineAt: ts(momentAt(w.last, zone, schedule.deadline)),
    members,
    judges,
    submittedBy: [],
    ...extra,
  }
}

/** A monthly list doc whose bounds put `now` in the given phase, like weekDoc. */
export function monthlyDoc(phase: Phase, members: string[], judges: string[] = [], submittedBy: string[] = []): DocumentData {
  return { ...weekDoc(phase, members, submittedBy), judges }
}

/** 'YYYY-MM' of an instant (UTC), like the rules' monthStr. */
export const monthStr = (ms: number): string => DateTime.fromMillis(ms, { zone: 'utc' }).toFormat('yyyy-MM')
/** The month `n` months after `monthId`. */
export const addMonths = (monthId: string, n: number): string =>
  DateTime.fromISO(`${monthId}-01`, { zone: 'utc' }).plus({ months: n }).toFormat('yyyy-MM')

// ---------- batch 3 fixtures (SPEC §11) ----------

/** A profile as stored. */
export const profileDoc = (name: string): DocumentData => ({ name, color: '#636366', createdAt: ts(Date.now() - 400 * DAY) })

/** The pair doc of `a` and `b` (sorted uids), asked by `by` (default `a`), `daysAgo` old: [path, data]. */
export function pairEntry(a: string, b: string, state = 'friends', by = a, daysAgo = 10): [string, DocumentData] {
  const users = [a, b].sort()
  return [`friends/${users[0]}_${users[1]}`, { users, by, state, at: ts(Date.now() - daysAgo * DAY) }]
}

/** The Monday ('YYYY-MM-DD') of the week holding `ms` on a clock `off` minutes ahead of UTC: a goal's
 *  week as the rules see it (its stored utcOffsetMin). */
export function weekOfClock(ms: number, off: number): string {
  const local = new Date(ms + off * 60_000)
  const back = (local.getUTCDay() + 6) % 7
  const monday = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - back * DAY
  return new Date(monday).toISOString().slice(0, 10)
}
/** 00:00 of the day `id` on a clock `off` minutes ahead of UTC (the rules' dayAnchor). */
export const anchorOf = (id: string, off: number): number => Date.parse(`${id}T00:00:00Z`) - off * 60_000
/** The day `n` days after `id`. */
export const addDays = (id: string, n: number): string => new Date(Date.parse(`${id}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)

export const GOAL_ZONE = 'Europe/Berlin'

/** A shared goal as stored (seeded): Alice owns it, Bob is a member, Cleo is invited; 55 of 100 km
 *  counted. Every key of SPEC §11.3. */
export function goalDoc(extra: DocumentData = {}): DocumentData {
  return {
    name: 'Run 100 km',
    unit: 'km',
    target100: 10_000,
    endsOn: null,
    timezone: GOAL_ZONE,
    utcOffsetMin: offsetNow(GOAL_ZONE),
    zones: { alice: GOAL_ZONE, bob: 'America/New_York' },
    ownerId: 'alice',
    createdBy: 'alice',
    memberIds: ['alice', 'bob'],
    invited: ['cleo'],
    joinedAt: { alice: ts(Date.now() - 20 * DAY), bob: ts(Date.now() - 19 * DAY) },
    leftAt: {},
    totals100: { alice: 3000, bob: 2500 },
    total100: 5500,
    last: null,
    reachedAt: null,
    archivedAt: null,
    createdAt: ts(Date.now() - 20 * DAY),
    ...extra,
  }
}

/** What createSharedGoal writes for `me`, inviting `invited`. */
export function newGoalDoc(me: string, invited: string[] = [], extra: DocumentData = {}): DocumentData {
  return {
    name: 'Run 100 km',
    unit: 'km',
    target100: 10_000,
    endsOn: null,
    timezone: GOAL_ZONE,
    utcOffsetMin: offsetNow(GOAL_ZONE),
    zones: { [me]: GOAL_ZONE },
    ownerId: me,
    createdBy: me,
    memberIds: [me],
    invited,
    joinedAt: { [me]: serverTimestamp() },
    leftAt: {},
    totals100: {},
    total100: 0,
    last: null,
    reachedAt: null,
    archivedAt: null,
    createdAt: serverTimestamp(),
    ...extra,
  }
}
