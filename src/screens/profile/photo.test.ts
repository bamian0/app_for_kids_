import { describe, expect, it } from 'vitest'
import { personOf } from '../components/people.ts'
import {
  clampCrop,
  cropSquare,
  doubleTapCrop,
  fitQuality,
  initialCrop,
  MAX_ZOOM,
  maxScale,
  maybeImage,
  minScale,
  QUALITIES,
  resizeCrop,
  rubberCrop,
  scaleOfSlider,
  sliderOf,
  zoomAt,
} from './crop.ts'
import type { Crop, Point, Size } from './crop.ts'

const LANDSCAPE: Size = { width: 2000, height: 1500 }
const PORTRAIT: Size = { width: 1500, height: 2000 }
const D = 300

/** Where a screen point (from the circle's center) lands on the image. */
const imagePoint = (crop: Crop, image: Size, p: Point): Point => ({
  x: (p.x - crop.x) / crop.scale + image.width / 2,
  y: (p.y - crop.y) / crop.scale + image.height / 2,
})

/** True when the image covers the whole circle's bounding square. */
const fills = (crop: Crop, image: Size) =>
  image.width * crop.scale >= D - 1e-9 &&
  image.height * crop.scale >= D - 1e-9 &&
  Math.abs(crop.x) <= (image.width * crop.scale - D) / 2 + 1e-9 &&
  Math.abs(crop.y) <= (image.height * crop.scale - D) / 2 + 1e-9

describe('Move and Scale', () => {
  it('starts centered with the short side spanning the circle', () => {
    expect(minScale(LANDSCAPE, D)).toBe(0.2)
    expect(minScale(PORTRAIT, D)).toBe(0.2)
    expect(initialCrop(LANDSCAPE, D)).toEqual({ x: 0, y: 0, scale: 0.2 })
    expect(maxScale(LANDSCAPE, D)).toBeCloseTo(0.2 * MAX_ZOOM)
    expect(cropSquare(initialCrop(LANDSCAPE, D), LANDSCAPE, D)).toEqual({ x: 250, y: 0, size: 1500 })
    expect(cropSquare(initialCrop(PORTRAIT, D), PORTRAIT, D)).toEqual({ x: 0, y: 250, size: 1500 })
  })

  it('keeps the circle filled: never smaller than it, never moved off it, never past the zoom limit', () => {
    for (const image of [LANDSCAPE, PORTRAIT]) {
      for (const crop of [
        { x: 0, y: 0, scale: 0.05 },
        { x: 5000, y: -5000, scale: 0.2 },
        { x: -90, y: 40, scale: 0.6 },
        { x: 0, y: 0, scale: 50 },
      ]) {
        const c = clampCrop(crop, image, D)
        expect(fills(c, image)).toBe(true)
        expect(c.scale).toBeLessThanOrEqual(maxScale(image, D) + 1e-12)
      }
    }
    // Inside the limits nothing changes.
    expect(clampCrop({ x: 10, y: -5, scale: 0.4 }, LANDSCAPE, D)).toEqual({ x: 10, y: -5, scale: 0.4 })
    // A landscape photo at "fill" slides sideways only.
    expect(clampCrop({ x: 500, y: 30, scale: 0.2 }, LANDSCAPE, D)).toEqual({ x: 50, y: 0, scale: 0.2 })
  })

  it('zooms about the fingers: the spot under them stays put', () => {
    const start = { x: 12, y: -30, scale: 0.3 }
    const p = { x: 40, y: 25 }
    const zoomed = zoomAt(start, 1.8, p)
    expect(zoomed.scale).toBeCloseTo(0.54)
    const before = imagePoint(start, LANDSCAPE, p)
    const after = imagePoint(zoomed, LANDSCAPE, p)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  it('gives like a rubber band past the limits, and not at all inside them', () => {
    const inside = { x: 10, y: 0, scale: 0.4 }
    expect(rubberCrop(inside, LANDSCAPE, D)).toEqual(inside)
    // Dragged 400 px past the right edge: it moves, but much less than the finger.
    const settled = clampCrop({ x: 450, y: 0, scale: 0.2 }, LANDSCAPE, D)
    const shown = rubberCrop({ x: 450, y: 0, scale: 0.2 }, LANDSCAPE, D)
    expect(shown.x).toBeGreaterThan(settled.x)
    expect(shown.x).toBeLessThan(450)
    expect(rubberCrop({ x: 900, y: 0, scale: 0.2 }, LANDSCAPE, D).x).toBeGreaterThan(shown.x)
    // Pinched below "fill" and past the zoom limit: some give, bounded.
    const small = rubberCrop({ x: 0, y: 0, scale: 0.1 }, LANDSCAPE, D).scale
    expect(small).toBeLessThan(0.2)
    expect(small).toBeGreaterThan(0.2 / 1.7)
    const big = rubberCrop({ x: 0, y: 0, scale: 10 }, LANDSCAPE, D).scale
    expect(big).toBeGreaterThan(1)
    expect(big).toBeLessThan(1.7)
  })

  it('double tap zooms in on the spot, and back out when zoomed in', () => {
    const start = initialCrop(LANDSCAPE, D)
    const tapped = { x: 60, y: -40 }
    const zoomedIn = doubleTapCrop(start, tapped, LANDSCAPE, D)
    expect(zoomedIn.scale).toBeCloseTo(0.5)
    expect(fills(zoomedIn, LANDSCAPE)).toBe(true)
    const before = imagePoint(start, LANDSCAPE, tapped)
    const after = imagePoint(zoomedIn, LANDSCAPE, tapped)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
    expect(doubleTapCrop(zoomedIn, tapped, LANDSCAPE, D).scale).toBeCloseTo(0.2)
  })

  it('keeps the framing when the circle changes size', () => {
    const crop = clampCrop({ x: 30, y: -20, scale: 0.5 }, LANDSCAPE, D)
    const bigger = resizeCrop(crop, D, 420)
    const a = cropSquare(crop, LANDSCAPE, D)
    const b = cropSquare(bigger, LANDSCAPE, 420)
    expect(b.x).toBeCloseTo(a.x)
    expect(b.y).toBeCloseTo(a.y)
    expect(b.size).toBeCloseTo(a.size)
  })

  it('crops the square under the circle, always inside the image', () => {
    // Zoomed 2× about the center: the middle 750 px.
    expect(cropSquare({ x: 0, y: 0, scale: 0.4 }, LANDSCAPE, D)).toEqual({ x: 625, y: 375, size: 750 })
    // Moved all the way left (the photo's right edge under the circle).
    const right = cropSquare({ x: -1e6, y: 0, scale: 0.2 }, LANDSCAPE, D)
    expect(right.x + right.size).toBeCloseTo(LANDSCAPE.width)
    for (const crop of [
      { x: 1e6, y: 1e6, scale: 1e-3 },
      { x: -1e6, y: -1e6, scale: 1e3 },
    ]) {
      const s = cropSquare(crop, PORTRAIT, D)
      expect(s.x).toBeGreaterThanOrEqual(0)
      expect(s.y).toBeGreaterThanOrEqual(0)
      expect(s.x + s.size).toBeLessThanOrEqual(PORTRAIT.width + 1e-9)
      expect(s.y + s.size).toBeLessThanOrEqual(PORTRAIT.height + 1e-9)
    }
  })

  it('maps the zoom slider evenly between fill and the limit', () => {
    expect(sliderOf(minScale(LANDSCAPE, D), LANDSCAPE, D)).toBe(0)
    expect(sliderOf(maxScale(LANDSCAPE, D), LANDSCAPE, D)).toBeCloseTo(1)
    expect(sliderOf(100, LANDSCAPE, D)).toBe(1)
    expect(scaleOfSlider(0.5, LANDSCAPE, D)).toBeCloseTo(0.2 * Math.sqrt(MAX_ZOOM))
    for (const t of [0, 0.25, 0.8, 1]) expect(sliderOf(scaleOfSlider(t, LANDSCAPE, D), LANDSCAPE, D)).toBeCloseTo(t)
  })
})

describe('encoding', () => {
  it('keeps the best quality that fits, stepping down until one does', () => {
    const tried: number[] = []
    const encode = (q: number) => {
      tried.push(q)
      return 'x'.repeat(Math.round(q * 100_000))
    }
    expect(fitQuality(encode, (s) => s.length <= 100_000)).toHaveLength(82_000)
    expect(tried).toEqual([0.82])
    tried.length = 0
    expect(fitQuality(encode, (s) => s.length <= 60_000)).toHaveLength(54_000)
    expect(tried).toEqual([0.82, 0.76, 0.7, 0.62, 0.54])
    expect(fitQuality(encode, () => false)).toBeNull()
    expect(QUALITIES[0]).toBeCloseTo(0.82)
  })

  it('tries images (HEIC too, and files without a type), never other files', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', '']) expect(maybeImage({ type })).toBe(true)
    for (const type of ['application/pdf', 'video/quicktime', 'text/plain']) expect(maybeImage({ type })).toBe(false)
  })
})

describe('personOf and photos', () => {
  const profiles = (photo?: string) => ({ x: { uid: 'x', name: 'X', color: '#A1B2C3', createdAt: 0, ...(photo === undefined ? {} : { photo }) } })

  it('carries an inline JPEG to the avatar', () => {
    const photo = 'data:image/jpeg;base64,/9j/4AAQ'
    expect(personOf(profiles(photo), 'x')).toEqual({ id: 'x', name: 'X', color: '#A1B2C3', photo })
  })

  it('leaves the photo out when there is none, or it is anything but an inline JPEG', () => {
    expect(personOf(profiles(), 'x')).not.toHaveProperty('photo')
    expect(personOf({}, 'x')).not.toHaveProperty('photo')
    for (const photo of ['', 'https://example.com/me.jpg', '//example.com/me.jpg', 'data:image/svg+xml;base64,PHN2Zy8+', 'javascript:alert(1)']) {
      expect(personOf(profiles(photo), 'x')).not.toHaveProperty('photo')
    }
  })
})
