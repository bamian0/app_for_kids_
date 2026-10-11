// Inset grouped lists: List > Section > Row, like UITableView.Style.insetGrouped.
import type { CSSProperties, ReactNode } from 'react'
import { Icon } from './icons.tsx'
import type { IconName } from './icons.tsx'
import { Toggle } from './Toggle.tsx'
import { cx, usePress } from './press.ts'
import './list.css'

export interface ListProps {
  children: ReactNode
  className?: string
  style?: CSSProperties
}

/** Vertical stack of Sections with iOS spacing. Optional: Sections also work on their own. */
export function List({ children, className, style }: ListProps) {
  return (
    <div className={cx('ui-list', className)} style={style}>
      {children}
    </div>
  )
}

export interface SectionProps {
  header?: ReactNode
  /** default: secondary text above the group. prominent: bold title3 header (e.g. "This Week"). */
  headerStyle?: 'default' | 'prominent'
  /** Trailing element in the header row, e.g. a plain "See All" button or a Pill. */
  headerAccessory?: ReactNode
  footer?: ReactNode
  /** Wrap children in 16px padding (for free-form content such as a ScoreRing card). */
  padded?: boolean
  /** Render children without the rounded background group. */
  bare?: boolean
  children?: ReactNode
  className?: string
  style?: CSSProperties
}

export function Section({ header, headerStyle = 'default', headerAccessory, footer, padded, bare, children, className, style }: SectionProps) {
  return (
    <section className={cx('ui-section', className)} style={style}>
      {(header || headerAccessory) && (
        <div className={cx('ui-section__header', headerStyle === 'prominent' && 'ui-section__header--prominent')}>
          <h2 className="ui-section__header-text">{header}</h2>
          {headerAccessory && <div className="ui-section__header-accessory">{headerAccessory}</div>}
        </div>
      )}
      {bare ? children : <div className={cx('ui-section__group', padded && 'ui-section__group--padded')}>{children}</div>}
      {footer && <div className="ui-section__footer">{footer}</div>}
    </section>
  )
}

export interface RowProps {
  title: ReactNode
  subtitle?: ReactNode
  /** Trailing secondary text (value), e.g. "3 of 5". */
  detail?: ReactNode
  /** Custom leading view: Avatar, CheckCircle… */
  leading?: ReactNode
  /** Settings-style icon tile. */
  icon?: IconName
  /** Tile color for `icon` (default systemGray). */
  iconBackground?: string
  chevron?: boolean
  /** Trailing selection checkmark. */
  checked?: boolean
  /** Renders an iOS switch as the accessory. */
  toggle?: boolean
  onToggle?: (checked: boolean) => void
  accessory?: ReactNode
  onPress?: () => void
  disabled?: boolean
  /** Red title, for actions like "Leave Space". */
  destructive?: boolean
  /** Title as a tappable action (semibold graphite), for rows like "Invite Friends". */
  action?: boolean
  /** Clamp the title to N lines (default: wraps freely). */
  titleLines?: number
  className?: string
  style?: CSSProperties
  'aria-label'?: string
}

export function Row({
  title,
  subtitle,
  detail,
  leading,
  icon,
  iconBackground,
  chevron,
  checked,
  toggle,
  onToggle,
  accessory,
  onPress,
  disabled,
  destructive,
  action,
  titleLines,
  className,
  style,
  'aria-label': ariaLabel,
}: RowProps) {
  const pressable = !!onPress && !disabled
  const { pressed, handlers } = usePress(pressable)

  const lead =
    leading ??
    (icon ? (
      <span className="ui-row__icon-tile" style={iconBackground ? { background: iconBackground } : undefined}>
        <Icon name={icon} size={19} weight={1.9} />
      </span>
    ) : null)

  const body = (
    <>
      {lead && <span className="ui-row__leading">{lead}</span>}
      <span className="ui-row__main">
        <span className="ui-row__text">
          <span
            className="ui-row__title"
            style={titleLines ? ({ WebkitLineClamp: titleLines, lineClamp: titleLines } as CSSProperties) : undefined}
            data-clamp={titleLines ? true : undefined}
          >
            {title}
          </span>
          {subtitle && <span className="ui-row__subtitle">{subtitle}</span>}
        </span>
        {detail != null && <span className="ui-row__detail">{detail}</span>}
        {accessory && <span className="ui-row__accessory">{accessory}</span>}
        {toggle !== undefined && onToggle && (
          <span className="ui-row__accessory">
            <Toggle checked={toggle} onChange={onToggle} disabled={disabled} aria-label={typeof title === 'string' ? title : ariaLabel} />
          </span>
        )}
        {checked && <Icon name="checkmark" size={18} weight={2.6} className="ui-row__check" />}
        {chevron && <Icon name="chevronRight" size={20} weight={2.6} className="ui-row__chevron" />}
      </span>
    </>
  )

  const classes = cx(
    'ui-row',
    subtitle != null && 'ui-row--subtitle',
    destructive && 'ui-row--destructive',
    action && 'ui-row--action',
    disabled && 'ui-row--disabled',
    className,
  )

  if (onPress) {
    return (
      <button
        type="button"
        className={classes}
        style={style}
        disabled={disabled}
        aria-label={ariaLabel}
        data-pressed={pressed || undefined}
        onClick={pressable ? onPress : undefined}
        {...handlers}
      >
        {body}
      </button>
    )
  }
  return (
    <div className={classes} style={style} aria-label={ariaLabel} aria-disabled={disabled || undefined}>
      {body}
    </div>
  )
}
