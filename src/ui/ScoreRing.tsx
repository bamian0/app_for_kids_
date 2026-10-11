// Activity-ring score: sweeps in from zero, marks the threshold, and at/above it turns into an
// iridescent conic arc with a soft glow.
import { useEffect, useId, useMemo } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { animate, motion, useMotionValue, useTransform } from 'motion/react'
import { prefersReducedMotion } from './motion.ts'
import { cx } from './press.ts'
import './ring.css'

export interface ScoreRingProps {
  /** 0..100, or null when there is no score yet (track only). */
  value: number | null
  /** Percent where the arc turns iridescent (default 90). */
  threshold?: number
  /** Diameter in px (default 140). */
  size?: number
  /** Ring thickness in px (default 14). */
  stroke?: number
  /** Sweep in from 0 on mount and on change (default true). */
  animate?: boolean
  /** Seconds before the sweep starts. */
  delay?: number
  /** Render the animated percentage in the middle (ignored when children are given). */
  showValue?: boolean
  /** Center label slot. */
  children?: ReactNode
  className?: string
  style?: CSSProperties
  'aria-label'?: string
}

const IRIS_COUNT = 7
const WEDGES = 90
const PAD = 7 // room outside the ring for the threshold tick and glow
/** Below this the outer threshold tick is too small to read as a mark and looks like a stray pixel. */
const TICK_MIN_SIZE = 120

function irisAt(turn: number): string {
  const t = (((turn % 1) + 1) % 1) * IRIS_COUNT
  const i = Math.floor(t)
  const f = t - i
  return `color-mix(in oklab, var(--iris-${i + 1}) ${((1 - f) * 100).toFixed(1)}%, var(--iris-${((i + 1) % IRIS_COUNT) + 1}))`
}

function polar(c: number, r: number, turn: number): [number, number] {
  const a = turn * 2 * Math.PI
  return [c + r * Math.sin(a), c - r * Math.cos(a)]
}

export function ScoreRing({
  value,
  threshold = 90,
  size = 140,
  stroke = 14,
  animate: shouldAnimate = true,
  delay = 0,
  showValue,
  children,
  className,
  style,
  'aria-label': ariaLabel,
}: ScoreRingProps) {
  const target = value == null || !Number.isFinite(value) ? 0 : Math.min(100, Math.max(0, value))
  const met = value != null && target >= threshold
  const c = size / 2
  const r = c - PAD - stroke / 2
  const circumference = 2 * Math.PI * r
  const maskId = useId().replace(/:/g, '')

  const progress = useMotionValue(shouldAnimate ? 0 : target)
  useEffect(() => {
    if (!shouldAnimate || prefersReducedMotion()) {
      progress.set(target)
      return
    }
    const controls = animate(progress, target, { duration: 1.25, delay, ease: [0.16, 0.84, 0.3, 1] })
    return () => controls.stop()
  }, [target, shouldAnimate, delay, progress])

  const dashOffset = useTransform(progress, (p) => circumference * (1 - p / 100))
  const arcOpacity = useTransform(progress, (p) => (p < 0.4 ? 0 : 1))
  const glowOpacity = useTransform(progress, [threshold - 6, threshold + 2], [0, 1])
  const rounded = useTransform(progress, (p) => Math.round(p))

  const wedges = useMemo(() => {
    const out: ReactNode[] = []
    const R = c
    for (let i = 0; i < WEDGES; i++) {
      const a0 = i / WEDGES
      const a1 = (i + 1.35) / WEDGES
      const [x0, y0] = polar(c, R, a0)
      const [x1, y1] = polar(c, R, a1)
      out.push(
        <path
          key={i}
          d={`M${c} ${c}L${x0.toFixed(2)} ${y0.toFixed(2)}A${R} ${R} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}Z`}
          style={{ fill: irisAt(a0 + 0.5 / WEDGES) }}
        />,
      )
    }
    return out
  }, [c])

  const tick = (() => {
    const turn = threshold / 100
    // Exactly the track's width: any overhang shows as specks of card color around the ring.
    const [nx0, ny0] = polar(c, r - stroke / 2, turn)
    const [nx1, ny1] = polar(c, r + stroke / 2, turn)
    const [tx0, ty0] = polar(c, r + stroke / 2 + 2.5, turn)
    const [tx1, ty1] = polar(c, r + stroke / 2 + 6, turn)
    return { notch: [nx0, ny0, nx1, ny1], outer: [tx0, ty0, tx1, ty1] }
  })()

  const arcProps = {
    cx: c,
    cy: c,
    r,
    fill: 'none',
    strokeWidth: stroke,
    strokeLinecap: 'round' as const,
    strokeDasharray: circumference,
    transform: `rotate(-90 ${c} ${c})`,
  }

  const label = children ?? (showValue && value != null ? (
    <span className="ui-ring__value">
      <motion.span>{rounded}</motion.span>
      <span className="ui-ring__percent">%</span>
    </span>
  ) : showValue ? (
    <span className="ui-ring__value ui-ring__value--empty">—</span>
  ) : null)

  return (
    <div
      className={cx('ui-ring', met && 'ui-ring--met', className)}
      style={{ width: size, height: size, ...style }}
      role="img"
      aria-label={ariaLabel ?? (value == null ? 'No score yet' : `${Math.round(target)} percent`)}
    >
      {met && (
        <motion.div className="ui-ring__glow" style={{ opacity: glowOpacity, inset: PAD - 2 }} aria-hidden>
          <div className="ui-ring__glow-ring" style={{ '--ring-stroke': `${stroke + 4}px` } as CSSProperties} />
        </motion.div>
      )}
      <svg className="ui-ring__svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        {met && (
          <defs>
            <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={size} height={size}>
              <motion.circle {...arcProps} stroke="#fff" style={{ strokeDashoffset: dashOffset, opacity: arcOpacity }} />
            </mask>
          </defs>
        )}
        <circle cx={c} cy={c} r={r} fill="none" strokeWidth={stroke} className="ui-ring__track" />
        <line
          className="ui-ring__notch"
          x1={tick.notch[0]}
          y1={tick.notch[1]}
          x2={tick.notch[2]}
          y2={tick.notch[3]}
        />
        {met ? (
          <g mask={`url(#${maskId})`}>{wedges}</g>
        ) : (
          <motion.circle {...arcProps} className="ui-ring__arc" style={{ strokeDashoffset: dashOffset, opacity: arcOpacity }} />
        )}
        {size >= TICK_MIN_SIZE && (
          <line
            className="ui-ring__tick"
            x1={tick.outer[0]}
            y1={tick.outer[1]}
            x2={tick.outer[2]}
            y2={tick.outer[3]}
          />
        )}
      </svg>
      {label && <div className="ui-ring__label">{label}</div>}
    </div>
  )
}
