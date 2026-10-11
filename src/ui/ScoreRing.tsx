// Activity-ring score: sweeps in from zero, marks the threshold with a gap in the track, and at/above
// it turns into an iridescent arc with a soft glow. Round caps are drawn as discs, so near 100% the
// end cap passes over the start and shades it, like Apple's Activity rings.
import { useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { animate, motion, useMotionValue, useTransform } from 'motion/react'
import { prefersReducedMotion } from './motion.ts'
import { cx } from './press.ts'
import { capShadowOpacity, irisAt, polar, ringMet, wholePercent } from './ringMath.ts'
import './ring.css'

export interface ScoreRingProps {
  /** 0..100, or null when there is no score yet (track only). */
  value: number | null
  /** Percent where the arc turns iridescent (default 90). */
  threshold?: number
  /** false keeps the arc graphite even at or above the threshold, e.g. for a provisional score (default true). */
  iridescent?: boolean
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

/** One wedge per degree: neighbouring colors differ by less than a shade, so the sweep never steps. */
const WEDGES = 360
const PAD = 7 // room outside the ring for the glow
/** Width of the threshold gap in the track, along the ring. */
const GAP = 2.5

export function ScoreRing({
  value,
  threshold = 90,
  iridescent = true,
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
  const met = ringMet(value, threshold, iridescent)
  const c = size / 2
  const r = c - PAD - stroke / 2
  const circumference = 2 * Math.PI * r
  const id = useId().replace(/:/g, '')

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
  const rounded = useTransform(progress, wholePercent)

  // The end cap moves with the sweep; attributes are written directly, once per frame. It is placed
  // again whenever it mounts (a first value after null), or a 0 that never sweeps leaves it at the corner.
  const endCap = useRef<SVGCircleElement>(null)
  const endShadow = useRef<SVGCircleElement>(null)
  const hasValue = value != null
  useLayoutEffect(() => {
    const place = (p: number) => {
      const turn = p / 100
      const [x, y] = polar(c, r, turn)
      for (const el of [endCap.current, endShadow.current]) {
        el?.setAttribute('cx', x.toFixed(2))
        el?.setAttribute('cy', y.toFixed(2))
      }
      if (met) endCap.current?.style.setProperty('fill', irisAt(turn))
      else endCap.current?.style.removeProperty('fill')
      endShadow.current?.setAttribute('opacity', capShadowOpacity(turn).toFixed(2))
      const hidden = p < 0.4
      endCap.current?.setAttribute('visibility', hidden ? 'hidden' : 'visible')
    }
    place(progress.get())
    return progress.on('change', place)
  }, [progress, c, r, met, hasValue])

  const wedges = useMemo(() => {
    if (!met) return null
    const out: ReactNode[] = []
    for (let i = 0; i < WEDGES; i++) {
      const a0 = i / WEDGES
      // Overlap the next wedge so antialiased edges never show a seam.
      const [x0, y0] = polar(c, c, a0)
      const [x1, y1] = polar(c, c, (i + 1.6) / WEDGES)
      out.push(
        <path
          key={i}
          d={`M${c} ${c}L${x0.toFixed(2)} ${y0.toFixed(2)}A${c} ${c} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}Z`}
          style={{ fill: irisAt(a0 + 0.5 / WEDGES) }}
        />,
      )
    }
    return out
  }, [c, met])

  // Track: a full circle, or with a value, an arc that leaves a small gap at the threshold.
  const track = (() => {
    if (value == null) return <circle cx={c} cy={c} r={r} fill="none" strokeWidth={stroke} className="ui-ring__track" />
    const half = GAP / 2 / circumference
    const t = threshold / 100
    const [x0, y0] = polar(c, r, t + half)
    const [x1, y1] = polar(c, r, t - half + 1)
    return (
      <path
        d={`M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 1 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`}
        fill="none"
        strokeWidth={stroke}
        className="ui-ring__track"
      />
    )
  })()

  const [sx, sy] = polar(c, r, 0)
  const arcProps = {
    cx: c,
    cy: c,
    r,
    fill: 'none',
    strokeWidth: stroke,
    strokeDasharray: circumference,
    transform: `rotate(-90 ${c} ${c})`,
  }
  const shadowRadius = stroke / 2 + Math.max(1.5, stroke * 0.22)
  // The end cap only shades the start of the ring (where it passes over it), never its own trail.
  const [ex, ey] = polar(c, r, (shadowRadius + 2) / circumference)
  const startRegion = `M${sx.toFixed(2)} ${sy.toFixed(2)}A${r} ${r} 0 0 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`

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
      aria-label={ariaLabel ?? (value == null ? 'No score yet' : `${wholePercent(target)} percent`)}
    >
      {met && (
        <motion.div className="ui-ring__glow" style={{ opacity: glowOpacity, inset: PAD - 2 }} aria-hidden>
          <div className="ui-ring__glow-ring" style={{ '--ring-stroke': `${stroke + 4}px` } as CSSProperties} />
        </motion.div>
      )}
      <svg className="ui-ring__svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <defs>
          {met && (
            <mask id={`${id}-arc`} maskUnits="userSpaceOnUse" x="0" y="0" width={size} height={size}>
              <motion.circle {...arcProps} stroke="#fff" style={{ strokeDashoffset: dashOffset, opacity: arcOpacity }} />
              <motion.circle cx={sx} cy={sy} r={stroke / 2} fill="#fff" style={{ opacity: arcOpacity }} />
            </mask>
          )}
          <mask id={`${id}-start`} maskUnits="userSpaceOnUse" x="0" y="0" width={size} height={size}>
            <path d={startRegion} fill="none" stroke="#fff" strokeWidth={stroke} />
            {/* A hair smaller than the cap, so at exactly 100% no shadow fringe peeks out around it. */}
            <circle cx={sx} cy={sy} r={stroke / 2 - 0.5} fill="#fff" />
          </mask>
          <radialGradient id={`${id}-shadow`}>
            <stop offset={(stroke / 2 / shadowRadius).toFixed(3)} stopColor="#000" stopOpacity={0.26} />
            <stop offset="1" stopColor="#000" stopOpacity={0} />
          </radialGradient>
        </defs>
        {track}
        {value != null &&
          (met ? (
            <g mask={`url(#${id}-arc)`}>{wedges}</g>
          ) : (
            <>
              <motion.circle {...arcProps} className="ui-ring__arc" style={{ strokeDashoffset: dashOffset, opacity: arcOpacity }} />
              <motion.circle cx={sx} cy={sy} r={stroke / 2} className="ui-ring__cap" style={{ opacity: arcOpacity }} />
            </>
          ))}
        {value != null && (
          <>
            <g mask={`url(#${id}-start)`}>
              <circle ref={endShadow} r={shadowRadius} fill={`url(#${id}-shadow)`} opacity={0} />
            </g>
            <circle ref={endCap} r={stroke / 2} className="ui-ring__cap" />
          </>
        )}
      </svg>
      {label && <div className="ui-ring__label">{label}</div>}
    </div>
  )
}
