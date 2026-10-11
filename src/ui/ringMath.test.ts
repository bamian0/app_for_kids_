import { describe, expect, it } from 'vitest'
import { capShadowOpacity, irisAt, polar, ringMet, wholePercent } from './ringMath.ts'

describe('ringMet', () => {
  it('turns iridescent at the bar, despite float noise in the average', () => {
    expect(ringMet(90, 90)).toBe(true)
    expect(ringMet((100 + 100 + 70) / 3, 90)).toBe(true)
    expect(ringMet(89.99999999999999, 90)).toBe(true)
    expect(ringMet(89.9, 90)).toBe(false)
  })

  it('stays graphite for a provisional score, no score, or garbage', () => {
    expect(ringMet(100, 90, false)).toBe(false)
    expect(ringMet(null, 90)).toBe(false)
    expect(ringMet(Number.NaN, 90)).toBe(false)
  })

  it('caps values over 100 at 100', () => {
    expect(ringMet(140, 100)).toBe(true)
  })
})

describe('wholePercent', () => {
  it('never rounds up past a bar', () => {
    expect(wholePercent(89.9)).toBe(89)
    expect(wholePercent(66.666)).toBe(66)
    expect(wholePercent(89.99999999999999)).toBe(90)
    expect(wholePercent(0)).toBe(0)
  })
})

describe('irisAt', () => {
  it('blends neighbouring stops and wraps around the ring', () => {
    expect(irisAt(0)).toBe('color-mix(in oklab, var(--iris-1) 100.0%, var(--iris-2))')
    expect(irisAt(1.5 / 7)).toBe('color-mix(in oklab, var(--iris-2) 50.0%, var(--iris-3))')
    expect(irisAt(6.5 / 7)).toBe('color-mix(in oklab, var(--iris-7) 50.0%, var(--iris-1))')
    expect(irisAt(1)).toBe(irisAt(0))
    expect(irisAt(-0.25)).toBe(irisAt(0.75))
  })
})

describe('polar', () => {
  it('starts at 12 o’clock and runs clockwise', () => {
    const [x0, y0] = polar(50, 40, 0)
    expect([x0, y0]).toEqual([50, 10])
    const [x1, y1] = polar(50, 40, 0.25)
    expect(x1).toBeCloseTo(90)
    expect(y1).toBeCloseTo(50)
  })
})

describe('capShadowOpacity', () => {
  it('shows only as the end comes round to the start', () => {
    expect(capShadowOpacity(0.05)).toBe(0)
    expect(capShadowOpacity(0.8)).toBe(0)
    expect(capShadowOpacity(0.9)).toBeCloseTo(0.5)
    expect(capShadowOpacity(0.96)).toBe(1)
    expect(capShadowOpacity(1)).toBe(1)
  })
})
