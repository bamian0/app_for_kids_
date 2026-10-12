// Move and Scale math (SPEC §7.3), kept pure so it can be tested: where the photo sits under the
// circle, how far it can move and zoom, and which square of it becomes the profile photo.
import { rubberband } from '../../ui/motion.ts'

export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** Where the photo sits: its center's offset from the circle's center (screen px) and its scale
 *  (screen px per image px). */
export interface Crop {
  x: number
  y: number
  scale: number
}

/** How far past "just fills the circle" you can zoom in. */
export const MAX_ZOOM = 5

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

/** The smallest scale that still fills the circle: the photo's short side spans it. */
export function minScale(image: Size, diameter: number): number {
  return diameter / Math.min(image.width, image.height)
}

export function maxScale(image: Size, diameter: number): number {
  return minScale(image, diameter) * MAX_ZOOM
}

/** Fills the circle, centered: where every photo starts. */
export function initialCrop(image: Size, diameter: number): Crop {
  return { x: 0, y: 0, scale: minScale(image, diameter) }
}

function offsetLimits(image: Size, diameter: number, scale: number): Point {
  return { x: Math.max(0, (image.width * scale - diameter) / 2), y: Math.max(0, (image.height * scale - diameter) / 2) }
}

/** The crop moved and scaled back within its limits: the circle always full, never more than MAX_ZOOM. */
export function clampCrop(crop: Crop, image: Size, diameter: number): Crop {
  const scale = clamp(crop.scale, minScale(image, diameter), maxScale(image, diameter))
  const limit = offsetLimits(image, diameter, scale)
  return { scale, x: clamp(crop.x, -limit.x, limit.x), y: clamp(crop.y, -limit.y, limit.y) }
}

/** What the finger shows: inside the limits it is the crop itself; past them it gives way less and
 *  less, like a scroll view's rubber band. clampCrop is where it settles on release. */
export function rubberCrop(crop: Crop, image: Size, diameter: number): Crop {
  const min = minScale(image, diameter)
  const max = maxScale(image, diameter)
  const settled = clamp(crop.scale, min, max)
  // In log space, so pinching in and out past a limit feels the same.
  const scale = settled * Math.exp(rubberband(Math.log(crop.scale / settled), 0.5, 1))
  const limit = offsetLimits(image, diameter, scale)
  const band = (v: number, l: number) => {
    const inside = clamp(v, -l, l)
    return inside + rubberband(v - inside, diameter)
  }
  return { scale, x: band(crop.x, limit.x), y: band(crop.y, limit.y) }
}

/** Zooms by `factor` about `point` (relative to the circle's center): what is under it stays put. */
export function zoomAt(crop: Crop, factor: number, point: Point): Crop {
  return { scale: crop.scale * factor, x: point.x + (crop.x - point.x) * factor, y: point.y + (crop.y - point.y) * factor }
}

/** Double tap: in on the tapped spot, or back out when already zoomed in (like Photos). */
export function doubleTapCrop(crop: Crop, point: Point, image: Size, diameter: number): Crop {
  const min = minScale(image, diameter)
  const target = crop.scale > min * 1.5 ? min : min * 2.5
  return clampCrop(zoomAt(crop, target / crop.scale, point), image, diameter)
}

/** The same framing in a circle of another size (the window resized or rotated). */
export function resizeCrop(crop: Crop, from: number, to: number): Crop {
  const k = from > 0 ? to / from : 1
  return { x: crop.x * k, y: crop.y * k, scale: crop.scale * k }
}

/** Slider position, 0…1, for a scale. Logarithmic, so every step of the slider zooms by the same ratio. */
export function sliderOf(scale: number, image: Size, diameter: number): number {
  return clamp(Math.log(scale / minScale(image, diameter)) / Math.log(MAX_ZOOM), 0, 1)
}

export function scaleOfSlider(t: number, image: Size, diameter: number): number {
  return minScale(image, diameter) * MAX_ZOOM ** clamp(t, 0, 1)
}

/** The square of the image (image px) inside the circle; always within the image, so every browser
 *  draws it (Safari draws nothing for a source rectangle that pokes out). */
export function cropSquare(crop: Crop, image: Size, diameter: number): Point & { size: number } {
  const c = clampCrop(crop, image, diameter)
  const size = Math.min(diameter / c.scale, image.width, image.height)
  return {
    x: clamp(image.width / 2 - (diameter / 2 + c.x) / c.scale, 0, image.width - size),
    y: clamp(image.height / 2 - (diameter / 2 + c.y) / c.scale, 0, image.height - size),
    size,
  }
}

/** JPEG qualities to try, best first: ~0.8 almost always fits; a very detailed photo steps down. */
export const QUALITIES = [0.82, 0.76, 0.7, 0.62, 0.54, 0.46, 0.38, 0.3]

/** The first encoding, best quality first, that `fits`; null when none does. */
export function fitQuality(encode: (quality: number) => string, fits: (encoded: string) => boolean): string | null {
  for (const quality of QUALITIES) {
    const encoded = encode(quality)
    if (fits(encoded)) return encoded
  }
  return null
}

/** Whether a picked file can be tried as a photo: an image type, or none at all (some pickers leave it
 *  empty; decoding decides). HEIC counts: the browser decodes it if it can. */
export function maybeImage(file: { type: string }): boolean {
  return file.type === '' || file.type.startsWith('image/')
}
