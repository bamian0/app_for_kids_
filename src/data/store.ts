// Shared live subscriptions. Every hook reads from a keyed, ref-counted entry, so twenty components
// asking for the same space or profile share one Firestore listener.
import { useCallback, useSyncExternalStore } from 'react'
import type { Live } from './api.ts'

export type Emit<T> = (next: Live<T>) => void
/** Starts listening and returns the function that stops it. */
export type Start<T> = (emit: Emit<T>) => () => void

interface Entry {
  state: Live<unknown>
  listeners: Set<() => void>
  stop: () => void
  linger: ReturnType<typeof setTimeout> | null
  retry: ReturnType<typeof setTimeout> | null
  failures: number
}

/** Keeps a listener alive briefly after its last user unmounts, so push/pop navigation doesn't churn listeners. */
const LINGER_MS = 20_000

/**
 * Firestore never resumes a listener after an error, so a failed entry is restarted after these
 * delays while it lives. Access can arrive just after the UI knows about it: a space we just created
 * is in the local cache, and on screen, a moment before the server has it, and listeners opened in
 * that moment are refused.
 */
const RETRY_MS = [1_000, 3_000, 10_000, 30_000, 60_000]

export const LOADING: Live<never> = Object.freeze({ data: undefined, loading: true, error: null })

const entries = new Map<string, Entry>()

/** Subscribes `onChange` to the entry for `key`, starting it if needed. Returns the release function. */
export function watch<T>(key: string, start: Start<T>, onChange: () => void): () => void {
  let entry = entries.get(key)
  if (!entry) {
    const created: Entry = { state: LOADING, listeners: new Set(), stop: () => {}, linger: null, retry: null, failures: 0 }
    entries.set(key, created)
    entry = created
    const begin = () => {
      let live = true
      const stopRun = start((next) => {
        if (!live || entries.get(key) !== created) return
        if (next.error) {
          if (created.retry === null) {
            const delay = RETRY_MS[Math.min(created.failures, RETRY_MS.length - 1)]
            created.failures++
            created.retry = setTimeout(() => {
              created.retry = null
              live = false
              stopRun()
              begin()
            }, delay)
          }
          // A first refusal before anything loaded is usually that race: keep showing "loading".
          if (created.failures === 1 && created.state === LOADING) return
        } else if (next.data !== undefined) {
          created.failures = 0
        }
        created.state = next
        for (const listener of [...created.listeners]) listener()
      })
      created.stop = () => {
        live = false
        if (created.retry) clearTimeout(created.retry)
        created.retry = null
        stopRun()
      }
    }
    begin()
  }
  const current = entry
  if (current.linger) clearTimeout(current.linger)
  current.linger = null
  // Wrapped so the same callback can subscribe twice and release independently.
  const listener = () => onChange()
  current.listeners.add(listener)
  let released = false
  return () => {
    if (released) return
    released = true
    current.listeners.delete(listener)
    if (current.listeners.size > 0) return
    current.linger = setTimeout(() => {
      if (current.listeners.size > 0 || entries.get(key) !== current) return
      entries.delete(key)
      current.stop()
    }, LINGER_MS)
  }
}

export function peek<T>(key: string): Live<T> {
  return (entries.get(key)?.state ?? LOADING) as Live<T>
}

/** Combines several entries into one, recomputed whenever any of them changes. */
export function combine<T, R>(children: { key: string; start: Start<T> }[], merge: (states: Live<T>[]) => Live<R>): Start<R> {
  return (emit) => {
    let ready = false
    const update = () => {
      if (ready) emit(merge(children.map((child) => peek<T>(child.key))))
    }
    const releases = children.map((child) => watch(child.key, child.start, update))
    ready = true
    update()
    return () => releases.forEach((release) => release())
  }
}

/** React binding. `key` must identify everything `start` depends on; null means "nothing to watch". */
export function useLive<T>(key: string | null, start: Start<T>): Live<T> {
  // `start` is only used when the entry for `key` is first created, so it is not a dependency.
  const subscribe = useCallback((onChange: () => void) => (key ? watch(key, start, onChange) : () => {}), [key])
  const getSnapshot = () => (key ? peek<T>(key) : (LOADING as Live<T>))
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** A tiny observable value for module-level state (auth). */
export function signal<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next: T) {
      value = next
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
