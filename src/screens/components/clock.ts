// One shared ticking clock for every countdown on screen, so many cards don't each run a timer.
import { useSyncExternalStore } from 'react'
import { now } from '../../domain/clock.ts'

const TICK_MS = 10_000

let current = now()
const listeners = new Set<() => void>()
let timer: number | undefined

function tick() {
  current = now()
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    current = now()
    timer = window.setInterval(tick, TICK_MS)
    // Coming back from the background: refresh right away instead of showing a stale countdown.
    document.addEventListener('visibilitychange', tick)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }
}

/** App time (honours the dev ?now= override), refreshed every few seconds. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => current)
}
