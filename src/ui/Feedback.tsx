// Small status pieces: spinner, pills, badges, progress, empty states.
import type { CSSProperties, ReactNode } from 'react'
import { Icon } from './icons.tsx'
import type { IconName } from './icons.tsx'
import { cx } from './press.ts'
import './feedback.css'

export interface ActivityIndicatorProps {
  /** Pixel size, or 'medium' (20) / 'large' (36). */
  size?: number | 'medium' | 'large'
  /** Defaults to currentColor inside buttons; set e.g. 'var(--secondary-label)' elsewhere. */
  color?: string
  label?: string
  className?: string
}

/** The iOS 8-spoke spinner. */
export function ActivityIndicator({ size = 'medium', color, label = 'Loading', className }: ActivityIndicatorProps) {
  const px = size === 'medium' ? 20 : size === 'large' ? 36 : size
  return (
    <svg
      className={cx('ui-spinner', className)}
      width={px}
      height={px}
      viewBox="0 0 20 20"
      role="progressbar"
      aria-label={label}
      style={color ? { color } : undefined}
    >
      {Array.from({ length: 8 }, (_, i) => {
        const trail = (8 - i) % 8
        return (
          <rect
            key={i}
            x="8.8"
            y="1.2"
            width="2.4"
            height="5.1"
            rx="1.2"
            fill="currentColor"
            opacity={Math.max(0.2, 1 - trail * 0.115)}
            transform={`rotate(${i * 45} 10 10)`}
          />
        )
      })}
    </svg>
  )
}

export type PillTone = 'gray' | 'filled' | 'red' | 'green' | 'iridescent'

export interface PillProps {
  children: ReactNode
  icon?: IconName
  tone?: PillTone
  size?: 'small' | 'regular'
  className?: string
  style?: CSSProperties
}

/** Capsule label, e.g. "Locks in 5h 12m". Numbers are tabular so countdowns don't jitter. */
export function Pill({ children, icon, tone = 'gray', size = 'regular', className, style }: PillProps) {
  return (
    <span className={cx('ui-pill', `ui-pill--${tone}`, size === 'small' && 'ui-pill--small', className)} style={style}>
      {icon && <Icon name={icon} size={size === 'small' ? 12 : 14} weight={2} />}
      <span className="ui-pill__text">{children}</span>
    </span>
  )
}

export interface BadgeProps {
  count: number
  /** Hide when count is 0 (default true). */
  hideZero?: boolean
  tone?: 'label' | 'red'
  className?: string
}

export function Badge({ count, hideZero = true, tone = 'label', className }: BadgeProps) {
  if (hideZero && count === 0) return null
  return (
    <span className={cx('ui-badge', `ui-badge--${tone}`, className)} aria-label={`${count}`}>
      {count > 99 ? '99+' : count}
    </span>
  )
}

export interface ProgressBarProps {
  /** 0..1 */
  value: number
  tone?: 'label' | 'green' | 'iridescent'
  className?: string
  label?: string
}

export function ProgressBar({ value, tone = 'label', className, label }: ProgressBarProps) {
  const v = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
  return (
    <div
      className={cx('ui-progress', className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
    >
      <div className={cx('ui-progress__fill', `ui-progress__fill--${tone}`)} style={{ transform: `scaleX(${v})` }} />
    </div>
  )
}

export interface EmptyStateProps {
  icon?: IconName
  title: ReactNode
  message?: ReactNode
  /** Usually a <Button>. */
  action?: ReactNode
  className?: string
}

/** Like SwiftUI's ContentUnavailableView. */
export function EmptyState({ icon, title, message, action, className }: EmptyStateProps) {
  return (
    <div className={cx('ui-empty', className)}>
      {icon && (
        <div className="ui-empty__icon">
          <Icon name={icon} size={52} weight={1.5} />
        </div>
      )}
      <h2 className="ui-empty__title">{title}</h2>
      {message && <p className="ui-empty__message">{message}</p>}
      {action && <div className="ui-empty__action">{action}</div>}
    </div>
  )
}
