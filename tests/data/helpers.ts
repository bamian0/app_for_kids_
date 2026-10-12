// Emulator setup for the data-layer tests. Run them with:
// npx firebase emulators:exec --config tests/data/firebase.data.json --only auth,firestore --project demo-stakes "npx vitest run --config vitest.data.config.ts"
import { readFileSync } from 'node:fs'
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, setLogLevel, Timestamp, type DocumentData, type Firestore } from 'firebase/firestore'
import { initClockFromUrl } from '../../src/domain/clock.ts'
import { getFirebase, setEmulatorPorts } from '../../src/firebase/app.ts'
import { signIn, signOut, signUp } from '../../src/data/api.ts'
import type { Live } from '../../src/data/api.ts'
import type { Start } from '../../src/data/store.ts'
import type { Mark, Space, WeekData } from '../../src/domain/types.ts'

// Listeners the tests open on purpose after access ends would otherwise log a warning each.
setLogLevel('silent')

const PROJECT = 'demo-stakes'
export const HOUR = 3_600_000
export const DAY = 24 * HOUR
export const PASSWORD = 'secret123'
export const ts = (ms: number): Timestamp => Timestamp.fromMillis(ms)

function hostPort(value: string | undefined, fallback: number): { host: string; port: number } {
  if (!value) return { host: '127.0.0.1', port: fallback }
  const i = value.lastIndexOf(':')
  return { host: value.slice(0, i), port: Number(value.slice(i + 1)) }
}

const firestoreAt = hostPort(process.env.FIRESTORE_EMULATOR_HOST, 8180)
const authAt = hostPort(process.env.FIREBASE_AUTH_EMULATOR_HOST, 9199)

let env: RulesTestEnvironment | null = null

/** The real rules, as deployed. */
export const RULES = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8')

/** Points the app at the test emulators, loads the real rules and wipes all data. */
export async function setupEmulators(): Promise<void> {
  if (!env) {
    setEmulatorPorts({ host: firestoreAt.host, firestorePort: firestoreAt.port, authPort: authAt.port })
    env = await initializeTestEnvironment({
      projectId: PROJECT,
      firestore: { host: firestoreAt.host, port: firestoreAt.port, rules: RULES },
    })
  }
  // Retried: right after another test file the emulator sometimes answers 500 once.
  for (let attempt = 1; ; attempt++) {
    try {
      await env.clearFirestore()
      break
    } catch (e) {
      if (attempt === 5) throw e
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  const res = await fetch(`http://${authAt.host}:${authAt.port}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Could not clear auth emulator: ${res.status}`)
}

/** Swaps the rules the emulator enforces, e.g. for older rules still live while a new client ships; RULES puts the real ones back. */
export async function loadRules(rules: string): Promise<void> {
  const url = `http://${firestoreAt.host}:${firestoreAt.port}/emulator/v1/projects/${PROJECT}:securityRules`
  const res = await fetch(url, { method: 'PUT', body: JSON.stringify({ rules: { files: [{ content: rules }] } }) })
  if (!res.ok) throw new Error(`Could not load rules: ${await res.text()}`)
}

export async function teardownEmulators(): Promise<void> {
  await signOut().catch(() => {})
  await env?.cleanup()
  env = null
}

async function asAdmin<T>(fn: (db: Firestore) => Promise<T>): Promise<T> {
  let result: T | undefined
  await env!.withSecurityRulesDisabled(async (ctx) => {
    result = await fn(ctx.firestore() as unknown as Firestore)
  })
  return result as T
}

/** Writes documents with rules disabled. Keys are document paths. */
export function seed(docs: Record<string, DocumentData>): Promise<void> {
  return asAdmin(async (db) => {
    await Promise.all(Object.entries(docs).map(([path, data]) => setDoc(doc(db, path), data)))
  })
}

export function adminGet(path: string): Promise<DocumentData | undefined> {
  return asAdmin(async (db) => (await getDoc(doc(db, path))).data())
}

/** Ids of the docs in a collection, read with rules disabled. */
export function adminList(path: string): Promise<string[]> {
  return asAdmin(async (db) => (await getDocs(collection(db, path))).docs.map((d) => d.id).sort())
}

export function adminDelete(path: string): Promise<void> {
  return asAdmin((db) => deleteDoc(doc(db, path)))
}

const millis = (v: unknown): number => (v && typeof (v as Timestamp).toMillis === 'function' ? (v as Timestamp).toMillis() : 0)
const millisById = (v: unknown): Record<string, number> => Object.fromEntries(Object.entries((v ?? {}) as Record<string, unknown>).map(([k, t]) => [k, millis(t)]))

/** The space as the domain sees it, read with rules disabled (works after everyone has left). */
export async function adminSpace(spaceId: string): Promise<Space> {
  const d = await adminGet(`spaces/${spaceId}`)
  if (!d) throw new Error(`No space ${spaceId}`)
  const space: Space = {
    id: spaceId, name: d.name, reward: d.reward, penalty: d.penalty, ownerId: d.ownerId, memberIds: d.memberIds,
    joinedAt: millisById(d.joinedAt), timezone: d.timezone, inviteCode: d.inviteCode, threshold: d.threshold,
    latePenalty: d.latePenalty, createdAt: millis(d.createdAt),
  }
  if (typeof d.utcOffsetMin === 'number') space.utcOffsetMin = d.utcOffsetMin
  if (d.leftAt) space.leftAt = millisById(d.leftAt)
  return space
}

/** Everything stored for one week, every review included (revealed or not), read with rules disabled. */
export function adminWeekData(spaceId: string, weekId: string): Promise<WeekData> {
  return asAdmin(async (db) => {
    const path = `spaces/${spaceId}/weeks/${weekId}`
    const w = (await getDoc(doc(db, path))).data()
    const docs = async (name: string) => (await getDocs(collection(db, `${path}/${name}`))).docs.map((d) => ({ id: d.id, d: d.data() }))
    const [plans, progress, reviews] = await Promise.all([docs('plans'), docs('progress'), docs('reviews')])
    return {
      spaceId,
      weekId,
      week: w
        ? {
            id: weekId, spaceId, startAt: millis(w.startAt), lockAt: millis(w.lockAt), reviewOpenAt: millis(w.reviewOpenAt),
            deadlineAt: millis(w.deadlineAt), members: w.members, submittedBy: w.submittedBy,
          }
        : null,
      plans: Object.fromEntries(plans.map(({ id, d }) => [id, { uid: id, tasks: d.tasks, updatedAt: millis(d.updatedAt) }])),
      progress: Object.fromEntries(progress.map(({ id, d }) => [id, { uid: id, done: d.done, updatedAt: millis(d.updatedAt) }])),
      reviews: reviews.map(({ id, d }) => ({ id, reviewerId: d.reviewerId, revieweeId: d.revieweeId, marks: d.marks as Record<string, Mark>, submittedAt: millis(d.submittedAt) })),
    }
  })
}

/** Creates an auth user through the emulator's REST API, without a profile doc (an "older account"). */
export async function createBareAccount(email: string, password: string): Promise<string> {
  const url = `http://${authAt.host}:${authAt.port}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) })
  const body = (await res.json()) as { localId?: string }
  if (!body.localId) throw new Error(`Could not create ${email}: ${JSON.stringify(body)}`)
  return body.localId
}

export interface TestUser {
  name: string
  email: string
  uid: string
}

export async function createUser(name: string): Promise<TestUser> {
  const email = `${name.toLowerCase()}@example.com`
  await signOut()
  await signUp(name, email, PASSWORD)
  return { name, email, uid: getFirebase().auth.currentUser!.uid }
}

/** Switches the app's signed-in user. */
export async function as(user: TestUser): Promise<void> {
  await signOut()
  await signIn(user.email, PASSWORD)
}

/** Shifts the app clock (domain now()) to `ms`; the emulator keeps real time. */
export function setClock(ms: number): void {
  initClockFromUrl(`?now=${encodeURIComponent(new Date(ms).toISOString())}`, true)
}

export function resetClock(): void {
  setClock(Date.now())
}

/** Starts a data-layer subscription outside React and lets a test wait for a state. */
export function observe<T>(start: Start<T>) {
  let latest: Live<T> = { data: undefined, loading: true, error: null }
  const waiters = new Set<() => void>()
  const stop = start((next) => {
    latest = next
    for (const waiter of [...waiters]) waiter()
  })
  function until(predicate: (live: Live<T>) => boolean, timeoutMs = 10_000): Promise<Live<T>> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!predicate(latest)) return
        clearTimeout(timer)
        waiters.delete(check)
        resolve(latest)
      }
      const timer = setTimeout(() => {
        waiters.delete(check)
        reject(new Error(`Timed out; last state: ${JSON.stringify(latest, (_k, v) => (v instanceof Error ? v.message : v))}`))
      }, timeoutMs)
      waiters.add(check)
      check()
    })
  }
  return { until, stop, current: () => latest }
}

/** Expects `op` to reject with exactly `message`. */
export async function rejectsWith(op: Promise<unknown>, message: string): Promise<void> {
  let error: unknown = null
  try {
    await op
  } catch (e) {
    error = e
  }
  if (!(error instanceof Error)) throw new Error(`Expected "${message}", but it succeeded`)
  if (error.message !== message) throw new Error(`Expected "${message}", got "${error.message}" (cause: ${String(error.cause)})`)
}

/** Week doc timestamps that put the real time (the emulator's request.time) in the given phase. */
export function weekDoc(phase: 'planning' | 'active' | 'review' | 'closed', members: string[], submittedBy: string[] = []): DocumentData {
  const now = Date.now()
  const startAt = { planning: now - 12 * HOUR, active: now - 2 * DAY, review: now - 4 * DAY - HOUR, closed: now - 5 * DAY - HOUR }[phase]
  return {
    startAt: ts(startAt),
    lockAt: ts(startAt + DAY),
    reviewOpenAt: ts(startAt + 4 * DAY),
    deadlineAt: ts(startAt + 5 * DAY),
    members,
    submittedBy,
  }
}

/** Polls until `check` returns true. */
export async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
