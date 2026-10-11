import { describe, expect, it } from 'vitest'
import { springs } from './motion.ts'

/** Peak overshoot past the target, in px, for a spring released at rest `distance` px away. */
function overshoot({ stiffness, damping, mass }: { stiffness: number; damping: number; mass: number }, distance: number): number {
  const zeta = damping / (2 * Math.sqrt(stiffness * mass))
  if (zeta >= 1) return 0
  return distance * Math.exp((-zeta * Math.PI) / Math.sqrt(1 - zeta * zeta))
}

describe('springs.banner', () => {
  it('settles like an iOS notification: damping ratio ≥ 0.85, no visible bounce from its start offset', () => {
    const { stiffness, damping, mass } = springs.banner
    expect(damping / (2 * Math.sqrt(stiffness * mass))).toBeGreaterThanOrEqual(0.85)
    expect(overshoot(springs.banner, 90)).toBeLessThan(1)
    // The old preset dropped the banner 24px past its resting place.
    expect(overshoot(springs.bouncy, 140)).toBeGreaterThan(20)
  })
})
