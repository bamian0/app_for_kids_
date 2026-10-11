// Reminders-style completion circle: the ring fills, the checkmark draws itself, a prism glint sweeps
// across, and the circle gives a small spring bounce.
import { useRef } from 'react'
import type { CSSProperties } from 'react'
import { haptic } from './haptics.ts'
import { prefersReducedMotion } from './motion.ts'
import { cx } from './press.ts'
import './check.css'

export interface CheckCircleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  /** Circle diameter in px (default 24); the hit target is always at least 44px. */
  size?: number
  'aria-label'?: string
  className?: string
}

export function CheckCircle({ checked, onChange, disabled, size = 24, 'aria-label': ariaLabel, className }: CheckCircleProps) {
  const circle = useRef<HTMLSpanElement>(null)
  const sweep = useRef<HTMLSpanElement>(null)
  const halo = useRef<HTMLSpanElement>(null)

  const celebrate = () => {
    if (prefersReducedMotion()) return
    circle.current?.animate(
      [
        { transform: 'scale(1)' },
        { transform: 'scale(0.82)', offset: 0.22 },
        { transform: 'scale(1.12)', offset: 0.58 },
        { transform: 'scale(0.98)', offset: 0.82 },
        { transform: 'scale(1)' },
      ],
      { duration: 520, easing: 'ease-out' },
    )
    sweep.current?.animate(
      [
        { transform: 'translateX(-120%) rotate(20deg)', opacity: 0 },
        { opacity: 1, offset: 0.25 },
        { transform: 'translateX(120%) rotate(20deg)', opacity: 0 },
      ],
      { duration: 640, delay: 120, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'both' },
    )
    halo.current?.animate(
      [
        { transform: 'scale(0.9)', opacity: 0.9 },
        { transform: 'scale(1.75)', opacity: 0 },
      ],
      { duration: 620, delay: 90, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'both' },
    )
  }

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={cx('ui-check', checked && 'is-checked', className)}
      style={{ '--check-size': `${size}px` } as CSSProperties}
      onClick={() => {
        const next = !checked
        if (next) {
          haptic()
          celebrate()
        }
        onChange(next)
      }}
    >
      <span ref={halo} className="ui-check__halo" aria-hidden />
      <span ref={circle} className="ui-check__circle" aria-hidden>
        <svg viewBox="0 0 24 24" className="ui-check__svg">
          <circle className="ui-check__ring" cx="12" cy="12" r="10.75" />
          <circle className="ui-check__fill" cx="12" cy="12" r="11.5" />
          <path className="ui-check__tick" d="M7.4 12.3l3.15 3.15 6.05-6.7" pathLength={1} />
        </svg>
        <span className="ui-check__clip">
          <span ref={sweep} className="ui-check__sweep" />
        </span>
      </span>
    </button>
  )
}
