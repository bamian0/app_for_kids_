// Spring presets and accessibility preferences shared by every animated component.
import { useSyncExternalStore } from 'react'
import type { Transition } from 'motion/react'

export interface SpringPreset {
  type: 'spring'
  stiffness: number
  damping: number
  mass: number
  restDelta?: number
  restSpeed?: number
}

/** UIKit-like springs. Critically damped presets never overshoot; `bouncy` is for small, playful moments. */
export const springs = {
  /** Push/pop and interactive swipe-back (≈0.4s, no overshoot). */
  navigation: { type: 'spring', stiffness: 260, damping: 32, mass: 1, restDelta: 0.0005, restSpeed: 0.005 },
  /** Sheet present/dismiss and detent changes. */
  sheet: { type: 'spring', stiffness: 300, damping: 33, mass: 1, restDelta: 0.5, restSpeed: 2 },
  /** Thumbs, toggles, small layout moves: quick with a hint of give. */
  snappy: { type: 'spring', stiffness: 520, damping: 38, mass: 1 },
  /** Banners: settles like an iOS notification, no visible bounce (damping ratio ≈ 0.88). */
  banner: { type: 'spring', stiffness: 420, damping: 36, mass: 1 },
  /** Check-offs and badges: visible bounce. */
  bouncy: { type: 'spring', stiffness: 380, damping: 19, mass: 1 },
} satisfies Record<string, SpringPreset>

export type SpringName = keyof typeof springs

const instant: Transition = { duration: 0 }
const fade: Transition = { duration: 0.2, ease: 'easeOut' }

/** The preset, or an instant/fade transition when the user prefers reduced motion. */
export function transitionFor(name: SpringName, reduced = prefersReducedMotion(), reducedStyle: 'instant' | 'fade' = 'fade'): Transition {
  if (reduced) return reducedStyle === 'instant' ? instant : fade
  return springs[name]
}

function mediaStore(query: string) {
  const mql = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query) : null
  return {
    get: () => mql?.matches ?? false,
    subscribe: (cb: () => void) => {
      mql?.addEventListener('change', cb)
      return () => mql?.removeEventListener('change', cb)
    },
  }
}

const reducedMotion = mediaStore('(prefers-reduced-motion: reduce)')
const reducedTransparency = mediaStore('(prefers-reduced-transparency: reduce)')

export function prefersReducedMotion(): boolean {
  return reducedMotion.get()
}

export function prefersReducedTransparency(): boolean {
  return reducedTransparency.get()
}

/** Live `prefers-reduced-motion: reduce`. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(reducedMotion.subscribe, reducedMotion.get, () => false)
}

/** Live `prefers-reduced-transparency: reduce`. Glass and frosted materials turn solid via CSS automatically. */
export function usePrefersReducedTransparency(): boolean {
  return useSyncExternalStore(reducedTransparency.subscribe, reducedTransparency.get, () => false)
}

/** Velocity tracker for gestures: feed positions, read px/s from the last ~100ms. */
export function createVelocityTracker() {
  let samples: Array<{ t: number; v: number }> = []
  return {
    reset() {
      samples = []
    },
    add(value: number, t = performance.now()) {
      samples.push({ t, v: value })
      if (samples.length > 8) samples.shift()
    },
    velocity(): number {
      const now = performance.now()
      const recent = samples.filter((s) => now - s.t < 100)
      if (recent.length < 2) return 0
      const first = recent[0]
      const last = recent[recent.length - 1]
      const dt = (last.t - first.t) / 1000
      return dt > 0 ? (last.v - first.v) / dt : 0
    },
  }
}

/** iOS-style rubber banding for overdrag past a bound. */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  const sign = Math.sign(overshoot)
  const x = Math.abs(overshoot)
  return sign * (1 - 1 / ((x * constant) / dimension + 1)) * dimension
}
