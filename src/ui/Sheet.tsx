// iOS page sheets: card from the bottom with a grabber, medium/large detents, drag-to-dismiss with
// velocity, the presenting view scaling back behind it, and a full-screen variant for flows.
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { animate, motion, useMotionValue } from 'motion/react'
import { SheetScopeContext, useUI } from './context.ts'
import type { SheetDetent, SheetOptions, SheetScope } from './context.ts'
import { NavReset } from './NavigationStack.tsx'
import { blurFocusedField } from './keyboard.ts'
import { createVelocityTracker, prefersReducedMotion, rubberband, springs } from './motion.ts'
import { cx } from './press.ts'
import './sheet.css'

export type { SheetDetent, SheetOptions }

export interface SheetProps extends SheetOptions {
  open: boolean
  /** Called when the user drags down, taps the dimmed area, or presses Escape. Set open=false in response. */
  onClose: () => void
  /** After the dismiss animation finished and the sheet unmounted. */
  onClosed?: () => void
  className?: string
  children?: ReactNode
}

/**
 * Children fill the sheet; a <Screen titleDisplay="inline"> or a <NavigationStack> inside gives the
 * standard bar + scroll layout. React context flows through (it is a portal), but navigation starts fresh.
 */
export function Sheet(props: SheetProps) {
  const [mounted, setMounted] = useState(props.open)
  if (props.open && !mounted) setMounted(true)
  const { onClosed } = props
  const onExited = useCallback(() => {
    setMounted(false)
    onClosed?.()
  }, [onClosed])
  if (!mounted) return null
  return <SheetPresenter {...props} onExited={onExited} />
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** Outside a UIProvider there is no keyboard-aware shell to measure, so the window it is. */
function useWindowHeight(enabled: boolean) {
  const [h, setH] = useState(() => (typeof window === 'undefined' ? 800 : window.innerHeight))
  useEffect(() => {
    if (!enabled) return
    const onResize = () => setH(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [enabled])
  return h
}

function SheetPresenter({
  open,
  onClose,
  onExited,
  detents: detentsProp,
  presentation = 'card',
  dismissible,
  grabber,
  className,
  children,
  'aria-label': ariaLabel,
}: SheetProps & { onExited: () => void }) {
  const ui = useUI()
  const full = presentation === 'fullScreen'
  const detents = useMemo<SheetDetent[]>(
    () => (full ? ['large'] : detentsProp?.length ? detentsProp : ['large']),
    [full, detentsProp],
  )
  const canDismiss = dismissible ?? !full
  const showGrabber = grabber ?? !full
  // The app shell's height, which ends at the keyboard's top while it is up.
  const windowHeight = useWindowHeight(!ui)
  const H = ui?.appHeight || windowHeight

  // Registration order gives the stacking level; each sheet scales whatever sits right below it.
  const cover = useMotionValue(0)
  const dim = useMotionValue(0)
  const [myId, setMyId] = useState<number | null>(null)
  const registerSheet = ui?.registerSheet
  useLayoutEffect(() => {
    if (!registerSheet) return
    const reg = registerSheet(cover)
    setMyId(reg.id)
    return reg.unregister
  }, [registerSheet, cover])
  const sheets = ui?.sheets ?? []
  const level = Math.max(0, sheets.findIndex((s) => s.id === myId))
  const above = myId == null ? undefined : sheets[sheets.findIndex((s) => s.id === myId) + 1]?.cover

  const safeTop = ui?.safeTop ?? 0
  const largeTop = full ? 0 : safeTop + 10 + level * 10
  const positions = useMemo(
    () => ({ large: largeTop, medium: Math.max(largeTop, Math.round(H * 0.5)), hidden: H }),
    [largeTop, H],
  )
  const geo = useRef({ positions, detents, canDismiss, full })
  geo.current = { positions, detents, canDismiss, full }

  const [detent, setDetentState] = useState<SheetDetent>(detents[0])
  const detentRef = useRef(detent)
  detentRef.current = detent

  const y = useMotionValue(H)
  const anim = useRef<{ stop: () => void } | null>(null)
  const closingVelocity = useRef(0)
  const dragging = useRef(false)

  // Derive dim (scrim) and cover (presenting view scale) from the sheet's position.
  useEffect(() => {
    const update = (v: number) => {
      const { positions: p, detents: d, full: f } = geo.current
      if (f) {
        cover.set(0)
        dim.set(0)
        return
      }
      const firstStop = d.includes('medium') ? p.medium : p.large
      const ref = d.includes('medium') ? p.medium : p.hidden
      dim.set(clamp01((p.hidden - v) / Math.max(1, p.hidden - firstStop)))
      cover.set(clamp01((ref - v) / Math.max(1, ref - p.large)))
    }
    update(y.get())
    return y.on('change', update)
  }, [y, cover, dim])

  const runTo = useCallback(
    (target: number, velocity = 0, onDone?: () => void) => {
      anim.current?.stop()
      const transition = prefersReducedMotion() ? { duration: 0.2, ease: 'easeOut' as const } : { ...springs.sheet, velocity }
      anim.current = animate(y, target, { ...transition, onComplete: onDone })
    },
    [y],
  )

  // Present / dismiss when `open` changes. Callbacks go through refs so a parent re-render
  // (new inline handlers) never restarts an animation or drops a drag in progress.
  const onExitedRef = useRef(onExited)
  onExitedRef.current = onExited
  useEffect(() => {
    if (open) {
      runTo(geo.current.positions[detentRef.current], 0)
    } else {
      runTo(geo.current.positions.hidden, closingVelocity.current, () => onExitedRef.current())
      closingVelocity.current = 0
    }
  }, [open, runTo])

  // Follow layout changes (rotation, stacking level) while presented.
  useEffect(() => {
    if (open && !dragging.current) runTo(positions[detentRef.current], 0)
  }, [positions, open, runTo])

  const setDetent = useCallback(
    (d: SheetDetent) => {
      if (!geo.current.detents.includes(d)) return
      setDetentState(d)
      runTo(geo.current.positions[d], 0)
    },
    [runTo],
  )

  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const requestClose = useCallback((velocity = 0) => {
    closingVelocity.current = velocity
    onCloseRef.current()
  }, [])

  // Covered by a sheet above: shrink back like a stacked card.
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    const apply = (c: number) => {
      el.style.transform = c > 0.001 ? `translate3d(0, ${-c * 8}px, 0) scale(${1 - 0.06 * c})` : ''
    }
    if (!above) {
      apply(0)
      return
    }
    apply(above.get())
    return above.on('change', apply)
  }, [above])

  // ---- Drag gesture: touch (with scroll handoff) and mouse ----
  const sheetRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sheetRef.current
    if (!el) return
    const tracker = createVelocityTracker()
    let drag: { x0: number; y0: number; pos0: number; mode: 'pending' | 'drag' | 'scroll'; scroller: HTMLElement | null } | null = null

    const findScroller = (target: EventTarget | null): HTMLElement | null => {
      let n = target instanceof Element ? (target as HTMLElement) : null
      while (n && n !== el) {
        if (n.scrollHeight > n.clientHeight + 1) {
          const oy = getComputedStyle(n).overflowY
          if (oy === 'auto' || oy === 'scroll') return n
        }
        n = n.parentElement
      }
      return null
    }

    const begin = (x: number, yy: number, target: EventTarget | null) => {
      if (target instanceof Element && target.closest('input, textarea, select, [data-sheet-nodrag]')) return
      drag = { x0: x, y0: yy, pos0: y.get(), mode: 'pending', scroller: findScroller(target) }
    }

    const move = (x: number, yy: number, e: Event) => {
      if (!drag) return
      const { positions: p, detents: d, canDismiss: dismissOk } = geo.current
      const dy = yy - drag.y0
      if (drag.mode === 'pending') {
        if (Math.abs(dy) < 4 && Math.abs(x - drag.x0) < 4) return
        if (Math.abs(x - drag.x0) > Math.abs(dy)) {
          drag.mode = 'scroll'
          return
        }
        const atTop = !drag.scroller || drag.scroller.scrollTop <= 0
        const belowLarge = y.get() > p.large + 1
        drag.mode = (dy > 0 && atTop) || (dy < 0 && (belowLarge || !drag.scroller)) ? 'drag' : 'scroll'
        if (drag.mode === 'scroll') return
        // Commit an edit in progress (onBlur saves) before the sheet can go away.
        blurFocusedField()
        anim.current?.stop()
        dragging.current = true
        drag.y0 = yy
        drag.pos0 = y.get()
        tracker.reset()
      }
      if (drag.mode !== 'drag') return
      if (e.cancelable) e.preventDefault()
      let next = drag.pos0 + (yy - drag.y0)
      if (next < p.large) next = p.large + rubberband(next - p.large, H)
      const lowest = d.includes('medium') ? p.medium : p.large
      if (!dismissOk && next > lowest) next = lowest + rubberband(next - lowest, H)
      y.set(next)
      tracker.add(yy)
    }

    const end = () => {
      if (!drag) return
      const wasDrag = drag.mode === 'drag'
      drag = null
      if (!wasDrag) return
      dragging.current = false
      const { positions: p, detents: d, canDismiss: dismissOk } = geo.current
      const v = tracker.velocity()
      const projected = y.get() + v * 0.2
      const stops: Array<{ pos: number; detent: SheetDetent | null }> = d.map((k) => ({ pos: p[k], detent: k }))
      if (dismissOk) stops.push({ pos: p.hidden, detent: null })
      let best = stops[0]
      for (const s of stops) if (Math.abs(s.pos - projected) < Math.abs(best.pos - projected)) best = s
      if (best.detent === null) {
        runTo(p.hidden, v)
        requestClose(v)
      } else {
        setDetentState(best.detent)
        runTo(best.pos, v)
      }
    }

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) begin(e.touches[0].clientX, e.touches[0].clientY, e.target)
    }
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 1) move(e.touches[0].clientX, e.touches[0].clientY, e)
    }
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return
      begin(e.clientX, e.clientY, e.target)
      const onMove = (ev: PointerEvent) => move(ev.clientX, ev.clientY, ev)
      const onUp = () => {
        end()
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', end)
    el.addEventListener('touchcancel', end)
    el.addEventListener('pointerdown', onPointerDown)
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', end)
      el.removeEventListener('pointerdown', onPointerDown)
    }
  }, [y, H, runTo, requestClose])

  // Escape closes the top-most dismissible sheet.
  const isTop = myId != null && sheets.length > 0 && sheets[sheets.length - 1].id === myId
  useEffect(() => {
    if (!open || !isTop || !canDismiss) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose(0)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, isTop, canDismiss, requestClose])

  const scope = useMemo<SheetScope>(() => ({ dismiss: () => requestClose(0), detent, setDetent }), [requestClose, detent, setDetent])
  const hiddenBelow = Math.max(0, positions[detent] - positions.large)

  const node = (
    <div className="ui-sheet-layer" style={{ zIndex: 100 + level }}>
      {!full && (
        <motion.div
          className="ui-sheet-scrim"
          style={{ opacity: dim }}
          onClick={canDismiss ? () => requestClose(0) : undefined}
          aria-hidden
        />
      )}
      <motion.div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className={cx('ui-sheet', full ? 'ui-sheet--full' : 'ui-sheet--card', className)}
        style={{ y, height: H - largeTop, '--sheet-hidden': `${hiddenBelow}px` } as unknown as CSSProperties}
      >
        <div ref={panelRef} className="ui-sheet__panel">
          {showGrabber && <div className="ui-sheet__grabber" aria-hidden />}
          <div className="ui-sheet__content">
            <SheetScopeContext.Provider value={scope}>
              <NavReset>{children}</NavReset>
            </SheetScopeContext.Provider>
          </div>
        </div>
      </motion.div>
    </div>
  )

  const host = ui?.host ?? (typeof document !== 'undefined' ? document.body : null)
  return host ? createPortal(node, host) : null
}

export interface UseSheet {
  /** Present content in a new sheet (needs <UIProvider>). Returns a function that closes it. */
  present: (content: ReactNode | ((close: () => void) => ReactNode), options?: SheetOptions) => () => void
  /** Inside a sheet: close that sheet. Elsewhere: close the top-most sheet opened with present(). */
  dismiss: () => void
  /** True when called from inside a sheet. */
  inSheet: boolean
  /** Current detent of the enclosing sheet (inside a sheet only). */
  detent?: SheetDetent
  setDetent?: (detent: SheetDetent) => void
}

export function useSheet(): UseSheet {
  const ui = useUI()
  const scope = useContext(SheetScopeContext)
  return useMemo(
    () => ({
      present: (content, options) => (ui ? ui.presentSheet(content, options) : () => {}),
      dismiss: () => (scope ? scope.dismiss() : ui?.dismissTopSheet()),
      inSheet: !!scope,
      detent: scope?.detent,
      setDetent: scope?.setDetent,
    }),
    [ui, scope],
  )
}
