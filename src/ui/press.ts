// Press feedback like UIKit: touches inside scroll views highlight after a short delay so a scroll
// doesn't flash rows, a quick tap still flashes on release, and moving the finger cancels.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export interface PressHandlers {
  onPointerDown: (e: ReactPointerEvent) => void
  onPointerMove: (e: ReactPointerEvent) => void
  onPointerUp: () => void
  onPointerCancel: () => void
  onPointerLeave: () => void
}

export function usePress(enabled: boolean, touchDelayMs = 70): { pressed: boolean; handlers: PressHandlers } {
  const [pressed, setPressed] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const shown = useRef(false)

  const clear = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = undefined
  }, [])

  const cancel = useCallback(() => {
    clear()
    origin.current = null
    shown.current = false
    setPressed(false)
  }, [clear])

  useEffect(() => clear, [clear])

  const handlers: PressHandlers = {
    onPointerDown(e) {
      if (!enabled || (e.pointerType === 'mouse' && e.button !== 0)) return
      origin.current = { x: e.clientX, y: e.clientY }
      shown.current = false
      clear()
      const show = () => {
        shown.current = true
        setPressed(true)
      }
      if (e.pointerType === 'mouse') show()
      else timer.current = window.setTimeout(show, touchDelayMs)
    },
    onPointerMove(e) {
      const o = origin.current
      if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > 10) cancel()
    },
    onPointerUp() {
      if (!origin.current) return
      clear()
      origin.current = null
      if (shown.current) {
        setPressed(false)
      } else {
        // Quick tap: flash the highlight so the press still reads.
        setPressed(true)
        timer.current = window.setTimeout(() => setPressed(false), 90)
      }
      shown.current = false
    },
    onPointerCancel: cancel,
    onPointerLeave() {
      if (origin.current) cancel()
    },
  }
  return { pressed, handlers }
}
