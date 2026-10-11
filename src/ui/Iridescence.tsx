// Light-through-a-prism moments, used sparingly: a Siri-style glow hugging the display edges, and a
// one-shot prism sweep across any element. Both animate only opacity, transform and filters.
import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, Ref } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useRequiredUI } from './context.ts'
import { prefersReducedMotion } from './motion.ts'
import { cx } from './press.ts'
import './iridescence.css'

export interface EdgeGlowHandle {
  play: (durationMs?: number) => void
}

export interface IridescentEdgeGlowProps {
  /** Plays whenever this changes to a new truthy value (e.g. the revealed week id). */
  trigger?: unknown
  /** How long the glow holds before fading out (default 2400ms). */
  durationMs?: number
  ref?: Ref<EdgeGlowHandle>
}

/** Full-screen overlay; UIProvider already mounts one, reachable through useEdgeGlow(). */
export function IridescentEdgeGlow({ trigger, durationMs = 2400, ref }: IridescentEdgeGlowProps) {
  const [run, setRun] = useState<{ id: number; ms: number } | null>(null)
  const timer = useRef<number | undefined>(undefined)

  const play = (ms = durationMs) => {
    window.clearTimeout(timer.current)
    setRun({ id: Date.now(), ms })
    timer.current = window.setTimeout(() => setRun(null), ms)
  }
  useImperativeHandle(ref, () => ({ play }))

  useEffect(() => {
    if (trigger) play()
    // Only a new trigger value should replay.
  }, [trigger])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const reduced = prefersReducedMotion()
  return (
    <AnimatePresence>
      {run && (
        <motion.div
          key="glow"
          className={cx('ui-edge-glow', reduced && 'ui-edge-glow--still')}
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.45, ease: 'easeOut' } }}
          exit={{ opacity: 0, transition: { duration: 1.1, ease: 'easeInOut' } }}
        >
          <motion.div
            className="ui-edge-glow__bloom"
            initial={{ scale: 1.06 }}
            animate={{ scale: 1, transition: { duration: 0.9, ease: [0.22, 1, 0.36, 1] } }}
          />
          <div className="ui-edge-glow__rim" />
          <div className="ui-edge-glow__sheen" />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** Play the shared edge glow (Friday reveal, month verdict). Needs <UIProvider>. */
export function useEdgeGlow(): EdgeGlowHandle {
  const ui = useRequiredUI('useEdgeGlow()')
  return { play: ui.playEdgeGlow }
}

export interface ShimmerHandle {
  play: () => void
}

export interface ShimmerProps {
  /** Sweeps once whenever this changes to a new truthy value. */
  trigger?: unknown
  /** Corner radius of the clipped sweep (default none: inside a Section the group already clips). */
  radius?: number | string
  /** inline wraps inline content (default block). */
  inline?: boolean
  className?: string
  style?: CSSProperties
  children?: ReactNode
  ref?: Ref<ShimmerHandle>
}

/** A one-shot diagonal prism sweep over its child, e.g. when a task is completed. */
export function Shimmer({ trigger, radius, inline, className, style, children, ref }: ShimmerProps) {
  const [runId, setRunId] = useState(0)
  useImperativeHandle(ref, () => ({ play: () => setRunId((n) => n + 1) }))
  useEffect(() => {
    if (trigger) setRunId((n) => n + 1)
  }, [trigger])

  return (
    <span
      className={cx('ui-shimmer', inline && 'ui-shimmer--inline', className)}
      style={radius != null ? { borderRadius: radius, ...style } : style}
    >
      {children}
      {runId > 0 && !prefersReducedMotion() && <span key={runId} className="ui-shimmer__sweep" aria-hidden />}
    </span>
  )
}
