// Move and Scale, like Contacts: the picked photo under a circle. Drag to move; pinch, the slider, a
// double tap or the trackpad to zoom. The circle always stays filled; past an edge the photo gives
// like a rubber band and springs back. Choose renders the square inside the circle (SPEC §7.3).
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { animate, motion, useMotionValue } from 'motion/react'
import { GlassButton, Icon, cx, transitionFor, useToast } from '../../ui/index.ts'
import { clampCrop, doubleTapCrop, initialCrop, MAX_ZOOM, resizeCrop, rubberCrop, scaleOfSlider, sliderOf, zoomAt } from './crop.ts'
import type { Crop, Point } from './crop.ts'
import { PhotoError, renderPhoto } from './image.ts'
import type { WorkingImage } from './image.ts'
import './profile.css'

export interface PhotoCropSheetProps {
  image: WorkingImage
  close: () => void
  /** The finished photo, a JPEG data URL; the sheet closes itself. */
  onChoose: (photo: string) => void
}

/** Space around the circle, px. */
const INSET = 16
const MAX_DIAMETER = 520
/** Taps closer than this in time and space make a double tap. */
const DOUBLE_TAP_MS = 320
const DOUBLE_TAP_PX = 32

interface Gesture {
  pointers: Map<number, Point>
  /** The crop when the current set of fingers went down, before the rubber band. */
  base: Crop
  /** The crop the fingers ask for (it can go past the limits; the screen shows it rubber-banded). */
  wanted: Crop
  center: Point
  distance: number
  moved: boolean
}

const centroid = (points: Point[]): Point => ({
  x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
  y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
})
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

export function PhotoCropSheet({ image, close, onChoose }: PhotoCropSheetProps) {
  const toast = useToast()
  const stageRef = useRef<HTMLDivElement>(null)
  const photoRef = useRef<HTMLDivElement>(null)
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const scale = useMotionValue(0)
  const [diameter, setDiameter] = useState(0)
  const [zoom, setZoom] = useState(0)
  const [moving, setMoving] = useState(false)
  const [busy, setBusy] = useState(false)
  const diameterRef = useRef(0)
  const gesture = useRef<Gesture | null>(null)
  const lastTap = useRef<{ at: number; point: Point } | null>(null)
  const running = useRef<Array<{ stop: () => void }>>([])

  const current = (): Crop => ({ x: x.get(), y: y.get(), scale: scale.get() })
  const stop = () => {
    for (const a of running.current) a.stop()
    running.current = []
  }
  const show = (crop: Crop) => {
    stop()
    x.set(crop.x)
    y.set(crop.y)
    scale.set(crop.scale)
  }
  const settle = (crop: Crop) => {
    stop()
    // No overshoot: past "fill" it would open a gap at the circle's edge for a few frames.
    const t = transitionFor('navigation')
    running.current = [animate(x, crop.x, t), animate(y, crop.y, t), animate(scale, crop.scale, t)]
  }
  const limit = (crop: Crop) => clampCrop(crop, image, diameterRef.current)

  // The working canvas itself goes on screen: a copy of up to 2048 px would double the memory.
  useLayoutEffect(() => {
    const holder = photoRef.current
    if (!holder) return
    holder.appendChild(image.canvas)
    return () => {
      image.canvas.remove()
      // Freed once the sheet is gone for good (StrictMode's remount puts it straight back).
      setTimeout(() => {
        if (!image.canvas.isConnected) image.release()
      }, 0)
    }
  }, [image])

  // The circle fills the stage, keeping the framing when the stage resizes (rotation).
  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = () => {
      const d = Math.floor(Math.min(stage.clientWidth - 2 * INSET, stage.clientHeight - 2 * INSET, MAX_DIAMETER))
      const before = diameterRef.current
      if (d <= 0 || d === before) return
      diameterRef.current = d
      show(before ? clampCrop(resizeCrop(current(), before, d), image, d) : initialCrop(image, d))
      setDiameter(d)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(stage)
    return () => ro.disconnect()
    // show/current only touch motion values, which are stable.
  }, [image])

  // The slider follows every zoom, whatever caused it.
  useEffect(() => scale.on('change', (s) => diameterRef.current && setZoom(sliderOf(s, image, diameterRef.current))), [scale, image])

  /** A pointer's position from the circle's center. */
  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = stageRef.current!.getBoundingClientRect()
    return { x: e.clientX - (r.left + r.width / 2), y: e.clientY - (r.top + r.height / 2) }
  }

  // Trackpad pinch and the mouse wheel; a passive React listener couldn't keep the page from zooming.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (!diameterRef.current || gesture.current) return
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002))
      show(limit(zoomAt(current(), factor, local(e))))
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
    // Everything else it reads is a ref or a motion value.
  }, [image])

  // Fingers (or the mouse): one moves the photo, two pinch it about their midpoint.
  const rebase = (g: Gesture) => {
    const points = [...g.pointers.values()].slice(0, 2)
    g.base = g.wanted
    g.center = centroid(points)
    g.distance = points.length > 1 ? distance(points[0], points[1]) : 0
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (busy || !diameterRef.current || (e.pointerType === 'mouse' && e.button !== 0)) return
    e.currentTarget.setPointerCapture(e.pointerId)
    let g = gesture.current
    if (!g) {
      const start = limit(current())
      g = { pointers: new Map(), base: start, wanted: start, center: { x: 0, y: 0 }, distance: 0, moved: false }
      gesture.current = g
      show(start)
      setMoving(true)
    }
    g.pointers.set(e.pointerId, local(e))
    if (g.pointers.size > 1) g.moved = true
    rebase(g)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    if (!g || !g.pointers.has(e.pointerId)) return
    g.pointers.set(e.pointerId, local(e))
    const points = [...g.pointers.values()].slice(0, 2)
    const center = centroid(points)
    let wanted = g.base
    if (points.length > 1 && g.distance > 0) wanted = zoomAt(wanted, distance(points[0], points[1]) / g.distance, g.center)
    wanted = { ...wanted, x: wanted.x + center.x - g.center.x, y: wanted.y + center.y - g.center.y }
    if (!g.moved && distance(center, g.center) > 6) g.moved = true
    g.wanted = wanted
    show(rubberCrop(wanted, image, diameterRef.current))
  }

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    if (!g || !g.pointers.delete(e.pointerId)) return
    if (g.pointers.size > 0) {
      rebase(g)
      return
    }
    gesture.current = null
    setMoving(false)
    if (!g.moved && e.type === 'pointerup') {
      const point = local(e)
      const before = lastTap.current
      if (before && e.timeStamp - before.at < DOUBLE_TAP_MS && distance(before.point, point) < DOUBLE_TAP_PX) {
        lastTap.current = null
        settle(doubleTapCrop(limit(current()), point, image, diameterRef.current))
        return
      }
      lastTap.current = { at: e.timeStamp, point }
    }
    settle(limit(g.wanted))
  }

  const onSlider = (t: number) => {
    if (!diameterRef.current) return
    const now = limit(current())
    show(limit(zoomAt(now, scaleOfSlider(t, image, diameterRef.current) / now.scale, { x: 0, y: 0 })))
  }

  // Arrow keys move the photo (like dragging it), + and − zoom it: the stage works without a pointer too.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 12
    const moves: Record<string, Point> = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } }
    const now = limit(current())
    if (moves[e.key]) show(limit({ ...now, x: now.x + moves[e.key].x, y: now.y + moves[e.key].y }))
    else if (e.key === '+' || e.key === '=') show(limit(zoomAt(now, 1.15, { x: 0, y: 0 })))
    else if (e.key === '-' || e.key === '−') show(limit(zoomAt(now, 1 / 1.15, { x: 0, y: 0 })))
    else return
    e.preventDefault()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, close])

  const choose = () => {
    const d = diameterRef.current
    if (busy || !d) return
    setBusy(true)
    stop()
    // Let the disabled button paint before the encode holds the main thread for a moment.
    requestAnimationFrame(() =>
      setTimeout(() => {
        try {
          onChoose(renderPhoto(image, limit(current()), d))
          close()
        } catch (e) {
          setBusy(false)
          const known = e instanceof PhotoError
          toast({ title: known ? e.title : 'Couldn’t use this photo', message: known ? e.message : 'Try a different one.', tone: 'error' })
        }
      }, 0),
    )
  }

  const percent = Math.round(100 * MAX_ZOOM ** zoom)

  return (
    // The editor never drags like a sheet, wherever a drag starts (the bars too): only the photo moves.
    <div className="p-crop" data-sheet-nodrag>
      <header className="p-crop__top">
        <h2 className="p-crop__title">Move and Scale</h2>
      </header>

      <div
        ref={stageRef}
        className={cx('p-crop__stage', moving && 'is-moving')}
        tabIndex={0}
        role="group"
        aria-roledescription="photo"
        aria-label="Your photo. Drag to move it, pinch to zoom."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={onKeyDown}
      >
        <motion.div
          ref={photoRef}
          className="p-crop__photo"
          style={{ x, y, scale, width: image.width, height: image.height, marginLeft: -image.width / 2, marginTop: -image.height / 2 }}
        />
        {diameter > 0 && (
          <>
            <div className="p-crop__dim" style={{ width: diameter, height: diameter }} aria-hidden />
            <div className="p-crop__ring" style={{ width: diameter, height: diameter }} aria-hidden />
          </>
        )}
      </div>

      <div className="p-crop__bottom">
        <div className="p-crop__zoom">
          <Icon name="person" size={14} className="p-crop__zoom-icon" />
          <input
            className="p-crop__slider"
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={zoom}
            onChange={(e) => onSlider(Number(e.currentTarget.value))}
            aria-label="Zoom"
            aria-valuetext={`${percent}%`}
            disabled={busy || !diameter}
            style={{ '--t': zoom } as CSSProperties}
          />
          <Icon name="person" size={22} className="p-crop__zoom-icon" />
        </div>
        <div className="p-crop__actions">
          <GlassButton className="p-crop__action" onClick={close} disabled={busy}>
            Cancel
          </GlassButton>
          <GlassButton className="p-crop__action" prominent onClick={choose} disabled={busy || !diameter}>
            Choose
          </GlassButton>
        </div>
      </div>
    </div>
  )
}
