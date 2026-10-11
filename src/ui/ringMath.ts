// Pure geometry and rules behind ScoreRing (kept apart so they can be unit-tested without a DOM).

const IRIS_COUNT = 7
/** Float noise: an average of exactly 90 can compute as 89.99999999999999. */
const EPS = 1e-9

/** Whether the arc turns iridescent: a real score at or above the bar, unless the caller keeps it gray. */
export function ringMet(value: number | null, threshold: number, iridescent = true): boolean {
  return iridescent && value != null && Number.isFinite(value) && Math.min(100, value) >= threshold - EPS
}

/** Whole percent, never rounding up past a bar: 89.9 shows as 89. */
export function wholePercent(v: number): number {
  return Math.floor(v + 1e-6)
}

/** The prism color at a point of the ring (0 = 12 o'clock, 1 = a full turn), as a CSS color. */
export function irisAt(turn: number): string {
  const t = (((turn % 1) + 1) % 1) * IRIS_COUNT
  const i = Math.floor(t)
  const f = t - i
  return `color-mix(in oklab, var(--iris-${i + 1}) ${((1 - f) * 100).toFixed(1)}%, var(--iris-${((i + 1) % IRIS_COUNT) + 1}))`
}

/** Point on a circle of radius r around (c, c), clockwise from 12 o'clock. */
export function polar(c: number, r: number, turn: number): [number, number] {
  const a = turn * 2 * Math.PI
  return [c + r * Math.sin(a), c - r * Math.cos(a)]
}

/**
 * How strongly the end cap's shadow shows: none until the end has come most of the way round, full
 * once it is about to overlap the start (Activity rings shade the start where the end passes over it).
 */
export function capShadowOpacity(turn: number): number {
  return Math.min(1, Math.max(0, (turn - 0.86) / 0.08))
}
