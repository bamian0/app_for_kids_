// Segmented control with a sliding capsule thumb, and the 3-way review MarkPicker built on the same track.
import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import type { Mark } from '../domain/types.ts'
import { Icon } from './icons.tsx'
import type { IconName } from './icons.tsx'
import { haptic } from './haptics.ts'
import { springs } from './motion.ts'
import { cx } from './press.ts'
import './segmented.css'

export interface SegmentOption<T extends string> {
  value: T
  label: ReactNode
  'aria-label'?: string
}

export interface SegmentedControlProps<T extends string> {
  options: Array<SegmentOption<T>>
  value: T
  onChange: (value: T) => void
  /** Stretch to the container width (default true). */
  fullWidth?: boolean
  size?: 'regular' | 'small'
  disabled?: boolean
  className?: string
  'aria-label'?: string
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  fullWidth = true,
  size = 'regular',
  disabled,
  className,
  'aria-label': ariaLabel,
}: SegmentedControlProps<T>) {
  const index = Math.max(0, options.findIndex((o) => o.value === value))
  const n = Math.max(1, options.length)
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={cx('ui-segmented', `ui-segmented--${size}`, fullWidth && 'ui-segmented--full', className)}
      style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
    >
      <motion.span
        className="ui-segmented__thumb"
        style={{ width: `calc((100% - 6px) / ${n})` }}
        initial={false}
        animate={{ x: `${index * 100}%` }}
        transition={springs.snappy}
        aria-hidden
      />
      {options.map((o) => {
        const selected = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={o['aria-label']}
            disabled={disabled}
            className={cx('ui-segmented__option', selected && 'is-selected')}
            onClick={() => {
              if (selected) return
              haptic()
              onChange(o.value)
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

const MARKS: Array<{ value: Mark; label: string; icon: IconName }> = [
  { value: 1, label: 'Done', icon: 'checkmark' },
  { value: 0.5, label: 'Half', icon: 'halfCircle' },
  { value: 0, label: 'Not done', icon: 'xmark' },
]

export interface MarkPickerProps {
  /** null until the reviewer picks. */
  value: Mark | null
  onChange: (mark: Mark) => void
  /** compact: icons only (≈132px), for trailing placement in a row. */
  size?: 'regular' | 'compact'
  disabled?: boolean
  className?: string
  /** Names the task for screen readers, e.g. "Mark for: Edit the reel". */
  'aria-label'?: string
}

/** Friday review control: Done (1) / Half (0.5) / Not done (0). */
export function MarkPicker({ value, onChange, size = 'regular', disabled, className, 'aria-label': ariaLabel }: MarkPickerProps) {
  const index = MARKS.findIndex((m) => m.value === value)
  const compact = size === 'compact'
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel ?? 'Mark'}
      className={cx('ui-segmented ui-mark', compact ? 'ui-mark--compact' : 'ui-segmented--full', className)}
      data-mark={value ?? undefined}
    >
      <motion.span
        className="ui-segmented__thumb ui-mark__thumb"
        style={{ width: 'calc((100% - 6px) / 3)' }}
        initial={false}
        animate={{ x: `${Math.max(0, index) * 100}%`, opacity: index < 0 ? 0 : 1, scale: index < 0 ? 0.85 : 1 }}
        transition={springs.snappy}
        aria-hidden
      />
      {MARKS.map((m) => {
        const selected = m.value === value
        return (
          <button
            key={m.label}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={m.label}
            disabled={disabled}
            className={cx('ui-segmented__option ui-mark__option', selected && 'is-selected')}
            data-value={m.value}
            onClick={() => {
              if (selected) return
              haptic()
              onChange(m.value)
            }}
          >
            <Icon name={m.icon} size={compact ? 17 : 15} weight={m.icon === 'halfCircle' ? 1.8 : 2.4} />
            {!compact && <span>{m.label}</span>}
          </button>
        )
      })}
    </div>
  )
}
