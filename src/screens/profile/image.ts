// From a picked file to a profile photo: decode it upright, keep a working copy small enough for an
// iPhone's canvas limits, and render the chosen square as a small JPEG data URL (SPEC §7.3).
import { isProfilePhoto } from '../../data/convert.ts'
import { cropSquare, fitQuality, maybeImage } from './crop.ts'
import type { Crop, Size } from './crop.ts'

/** Side of the stored photo, px. */
export const PHOTO_PX = 256
/** Longest side of the working copy: sharp at full zoom on a 3× screen, ~12 MB of canvas at most. */
const WORKING_MAX = 2048

/** What went wrong with a photo, worded for a banner: `title`, then the message says what to do. */
export class PhotoError extends Error {
  readonly title: string
  constructor(title: string, message: string) {
    super(message)
    this.title = title
  }
}

const CANT_OPEN = 'Couldn’t open this photo'

export interface WorkingImage extends Size {
  canvas: HTMLCanvasElement
  /** Frees the canvas's memory at once (iOS counts it until then). */
  release: () => void
}

interface Decoded extends Size {
  source: CanvasImageSource
  close: () => void
}

function newCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  return canvas
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new PhotoError(CANT_OPEN, 'Try again, or choose a smaller photo.')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  return ctx
}

const release = (canvas: HTMLCanvasElement) => {
  canvas.width = 0
  canvas.height = 0
}

/** Both decoders turn the photo upright from its EXIF orientation; HEIC works where the browser has it (Safari). */
async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
    } catch {
      // Not every browser decodes every format (or takes the options) this way: try an <img>.
    }
  }
  const url = URL.createObjectURL(file)
  const img = new Image()
  img.decoding = 'async'
  img.src = url
  try {
    await img.decode()
  } catch {
    URL.revokeObjectURL(url)
    throw new PhotoError(CANT_OPEN, 'Stakes can’t read this kind of file. Try a different photo.')
  }
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) }
}

/** Decodes a picked file into a working copy for Move and Scale. Throws PhotoError for anything that isn't a photo. */
export async function openPhoto(file: File): Promise<WorkingImage> {
  if (!maybeImage(file)) throw new PhotoError('That file isn’t a photo', 'Choose a photo instead.')
  const decoded = await decode(file)
  try {
    if (decoded.width < 1 || decoded.height < 1) throw new PhotoError(CANT_OPEN, 'Stakes can’t read this kind of file. Try a different photo.')
    const k = Math.min(1, WORKING_MAX / Math.max(decoded.width, decoded.height))
    const canvas = drawDown(decoded.source, { x: 0, y: 0, width: decoded.width, height: decoded.height }, decoded.width * k, decoded.height * k)
    return { canvas, width: canvas.width, height: canvas.height, release: () => release(canvas) }
  } finally {
    decoded.close()
  }
}

/**
 * Draws a region of `source` at `width` × `height`, halving step by step: one big jump skips pixels
 * and leaves hair and fabric grainy.
 */
function drawDown(source: CanvasImageSource, region: { x: number; y: number; width: number; height: number }, width: number, height: number, background?: string): HTMLCanvasElement {
  let from = source
  let { x, y, width: w, height: h } = region
  let step: HTMLCanvasElement | null = null
  while (w > width * 2 && h > height * 2) {
    const next = newCanvas(w / 2, h / 2)
    context(next).drawImage(from, x, y, w, h, 0, 0, next.width, next.height)
    if (step) release(step)
    step = next
    from = next
    x = 0
    y = 0
    w = next.width
    h = next.height
  }
  const out = newCanvas(width, height)
  const ctx = context(out)
  if (background) {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, out.width, out.height)
  }
  ctx.drawImage(from, x, y, w, h, 0, 0, out.width, out.height)
  if (step) release(step)
  return out
}

/** The square inside the circle as a 256 × 256 JPEG data URL that fits the profile (≤ 60,000 characters). */
export function renderPhoto(image: WorkingImage, crop: Crop, diameter: number): string {
  const square = cropSquare(crop, image, diameter)
  // White behind a transparent PNG: JPEG would turn it black.
  const out = drawDown(image.canvas, { x: square.x, y: square.y, width: square.size, height: square.size }, PHOTO_PX, PHOTO_PX, '#ffffff')
  try {
    const photo = fitQuality((quality) => out.toDataURL('image/jpeg', quality), isProfilePhoto)
    if (!photo) throw new PhotoError('Couldn’t use this photo', 'It has too much fine detail to fit. Try a different one.')
    return photo
  } finally {
    release(out)
  }
}
