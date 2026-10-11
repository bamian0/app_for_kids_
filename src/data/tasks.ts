// How tasks are stored in a plan (SPEC §6.1, §6.2). Pure, so the reminders job reads plans the same way.
// A task is { id, title } or { id, title, subs: ["<subId>|<title>", …] }; a task added after the lock
// has its server time in the plan's `added` map (arrays can't hold server timestamps).
import { MAX_SUBTASKS } from '../domain/ids.ts'
import type { Subtask, Task } from '../domain/types.ts'

/** Task and step ids, as the rules check them (also review mark keys and check-off keys). */
export const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/

export interface StoredTask {
  id: string
  title: string
  subs?: string[]
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

/** Step titles live on one line: the stored "<id>|<title>" lines are checked with one regex. */
export function oneLine(title: string): string {
  return title.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ').trim()
}

/** Malformed steps are skipped rather than failing the whole plan; so are ids already taken. */
function decodeSubs(v: unknown, taken: Set<string>): Subtask[] {
  const out: Subtask[] = []
  if (!Array.isArray(v)) return out
  for (const entry of v) {
    if (out.length === MAX_SUBTASKS) break
    if (typeof entry !== 'string') continue
    const bar = entry.indexOf('|')
    if (bar < 0) continue
    const id = entry.slice(0, bar).trim()
    const title = oneLine(entry.slice(bar + 1))
    if (!TASK_ID.test(id) || title === '' || taken.has(id)) continue
    taken.add(id)
    out.push({ id, title })
  }
  return out
}

/**
 * A plan's `tasks` and `added` as domain tasks. `toMs` reads a stored time (null if it isn't one).
 * Tasks without steps or an add time come out as plain { id, title }, exactly as before steps existed.
 */
export function decodeTasks(tasks: unknown, added: unknown, toMs: (v: unknown) => number | null): Task[] {
  if (!Array.isArray(tasks)) return []
  const plain = tasks.map((t: unknown) => ({ id: str(record(t).id), title: str(record(t).title), subs: record(t).subs })).filter((t) => t.id !== '')
  const taken = new Set(plain.map((t) => t.id))
  const addedAt = record(added)
  return plain.map(({ id, title, subs }) => {
    const task: Task = { id, title }
    const steps = decodeSubs(subs, taken)
    if (steps.length > 0) task.subtasks = steps
    const at = Object.hasOwn(addedAt, id) ? toMs(addedAt[id]) : null
    if (at !== null) task.addedAt = at
    return task
  })
}

/** The stored form of a clean task. `addedAt` never goes into the task: the rules keep it in `added`. */
export function encodeTask(task: Task): StoredTask {
  const subs = (task.subtasks ?? []).map((step) => `${step.id}|${oneLine(step.title)}`)
  return subs.length > 0 ? { id: task.id, title: task.title, subs } : { id: task.id, title: task.title }
}
