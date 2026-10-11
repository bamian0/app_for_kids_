import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Icon } from './icons.tsx'
import type { IconName } from './icons.tsx'
import { ActivityIndicator } from './Feedback.tsx'
import { cx, usePress } from './press.ts'
import './button.css'

export type ButtonVariant = 'filled' | 'gray' | 'plain' | 'destructive'
export type ButtonSize = 'small' | 'medium' | 'large'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** filled: label-colored capsule with inverted text (primary). gray: neutral fill. plain: text only. destructive: red on gray. */
  variant?: ButtonVariant
  /** small 32px, medium 44px (default), large 52px. */
  size?: ButtonSize
  fullWidth?: boolean
  /** Shows a spinner, keeps the button's width, and ignores taps. */
  loading?: boolean
  /** Leading SF-style icon. */
  icon?: IconName
  children?: ReactNode
}

export function Button({
  variant = 'filled',
  size = 'medium',
  fullWidth,
  loading,
  icon,
  children,
  className,
  disabled,
  type = 'button',
  onClick,
  ...rest
}: ButtonProps) {
  const inactive = disabled || loading
  const { pressed, handlers } = usePress(!inactive, 40)
  const iconSize = size === 'small' ? 16 : 20
  return (
    <button
      {...rest}
      {...handlers}
      type={type}
      disabled={disabled}
      aria-busy={loading || undefined}
      data-pressed={pressed || undefined}
      data-loading={loading || undefined}
      className={cx('ui-button', `ui-button--${variant}`, `ui-button--${size}`, fullWidth && 'ui-button--full', !children && 'ui-button--icon-only', className)}
      onClick={inactive ? undefined : onClick}
    >
      <span className="ui-button__content">
        {icon && <Icon name={icon} size={iconSize} />}
        {children != null && <span className="ui-button__label">{children}</span>}
      </span>
      {loading && (
        <span className="ui-button__spinner">
          <ActivityIndicator size={size === 'small' ? 16 : 20} />
        </span>
      )}
    </button>
  )
}
