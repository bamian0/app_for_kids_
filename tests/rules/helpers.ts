// Shared setup for the security rules tests (run with `npm run test:rules`).
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, expect } from 'vitest'
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { doc, serverTimestamp, setDoc, setLogLevel, Timestamp, type DocumentData, type Firestore } from 'firebase/firestore'

// Denied listeners and writes would otherwise log a warning per test.
setLogLevel('silent')

const RULES = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8')

export const HOUR = 3_600_000
export const DAY = 24 * HOUR
export const ts = (ms: number): Timestamp => Timestamp.fromMillis(ms)

/** Registers the emulator lifecycle for one test file: fresh rules once, empty database per test. */
export function useRulesEnv() {
  let env: RulesTestEnvironment
  const clients = new Map<string, Firestore>()

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: 'demo-stakes',
      // `firebase emulators:exec` sets FIRESTORE_EMULATOR_HOST; otherwise assume the default port.
      firestore: process.env.FIRESTORE_EMULATOR_HOST ? { rules: RULES } : { rules: RULES, host: '127.0.0.1', port: 8080 },
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

  return { db, seed }
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

/** A space as stored after creation (seeded with rules disabled). */
export function spaceDoc(memberIds: string[], extra: DocumentData = {}): DocumentData {
  const at = ts(Date.now() - 30 * DAY)
  return {
    name: 'Film crew',
    reward: 'Dinner on me',
    penalty: 'You buy coffee for a week',
    ownerId: memberIds[0] ?? 'owner',
    memberIds,
    joinedAt: Object.fromEntries(memberIds.map((uid) => [uid, at])),
    timezone: 'Europe/Berlin',
    inviteCode: CODE,
    threshold: 90,
    latePenalty: 5,
    createdAt: at,
    ...extra,
  }
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
    inviteCode: CODE,
    threshold: 90,
    latePenalty: 5,
    createdAt: serverTimestamp(),
    ...extra,
  }
}

export function inviteDoc(spaceId: string, createdBy: string): DocumentData {
  return { spaceId, spaceName: 'Film crew', inviterName: 'Alex', createdBy, createdAt: ts(Date.now() - 30 * DAY) }
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
