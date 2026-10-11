// iOS swipe actions: drag a row left to reveal Delete, or swipe all the way to delete at once.
import { useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { animate, motion, useMotionValue, useTransform } from 'motion/react'
import { haptic, springs } from '../../ui/index.ts'

const ACTION_WIDTH = 84
const SLOP = 10

interface Gesture {
  id: number
  x0: number
  y0: number
  base: number
  mode: 'pending' | 'swipe' | 'scroll'
}

export interface SwipeToDeleteProps {
  children: ReactNode
  onDelete: () => void
  disabled?: boolean
  label?: string
}

export function SwipeToDelete({ children, onDelete, disabled, label = 'Delete' }: SwipeToDeleteProps) {
  const x = useMotionValue(0)
  const actionWidth = useTransform(x, (v) => Math.max(ACTION_WIDTH, -v))
  // Hidden at rest so its red never bleeds through the group's anti-aliased rounded corners.
  const actionVisibility = useTransform(x, (v) => (v < -0.5 ? 'visible' : 'hidden'))
  const wrap = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const swallowClick = useRef(false)
  const [open, setOpen] = useState(false)
  const pastFull = useRef(false)

  const width = () => wrap.current?.offsetWidth ?? 320

  const settle = (to: number) => {
    setOpen(to !== 0)
    animate(x, to, springs.snappy)
  }

  const remove = () => {
    animate(x, -width(), { duration: 0.18, ease: 'easeIn' }).then(onDelete)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return
    gesture.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, base: x.get(), mode: 'pending' }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    if (!g || g.id !== e.pointerId || g.mode === 'scroll') return
    const dx = e.clientX - g.x0
    const dy = e.clientY - g.y0
    if (g.mode === 'pending') {
      if (Math.abs(dy) > SLOP && Math.abs(dy) >= Math.abs(dx)) {
        g.mode = 'scroll'
        return
      }
      if (Math.abs(dx) <= SLOP || Math.abs(dx) < Math.abs(dy) * 1.2 || (dx > 0 && g.base === 0)) return
      g.mode = 'swipe'
      g.x0 = e.clientX
      swallowClick.current = true
      e.currentTarget.setPointerCapture(e.pointerId)
      // A field being edited would otherwise keep the keyboard up mid-swipe.
      if (document.activeElement instanceof HTMLElement && e.currentTarget.contains(document.activeElement)) document.activeElement.blur()
    }
    const w = width()
    let next = g.base + (e.clientX - g.x0)
    if (next > 0) next /= 4
    next = Math.max(next, -w)
    x.set(next)
    const full = next < -w * 0.6
    if (full !== pastFull.current) {
      pastFull.current = full
      if (full) haptic()
    }
  }

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    if (!g || g.id !== e.pointerId) return
    gesture.current = null
    if (g.mode !== 'swipe') return
    const v = x.get()
    pastFull.current = false
    if (v < -width() * 0.6) remove()
    else settle(v < -ACTION_WIDTH / 2 ? -ACTION_WIDTH : 0)
  }

  return (
    <div ref={wrap} className="s-swipe">
      <motion.button
        type="button"
        className="s-swipe__action"
        style={{ width: actionWidth, visibility: actionVisibility }}
        tabIndex={open ? 0 : -1}
        aria-hidden={!open}
        onClick={remove}
      >
        {label}
      </motion.button>
      <motion.div
        className="s-swipe__content"
        style={{ x }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={(e) => {
          onPointerEnd(e)
          if (x.get() !== 0 && !open) settle(0)
        }}
        onClickCapture={(e) => {
          // The click that ends a swipe, or a tap on an open row, only closes it.
          if (swallowClick.current || open) {
            e.preventDefault()
            e.stopPropagation()
            swallowClick.current = false
            if (open) settle(0)
          }
        }}
        onPointerDownCapture={() => {
          swallowClick.current = false
        }}
      >
        {children}
      </motion.div>
    </div>
  )
}
