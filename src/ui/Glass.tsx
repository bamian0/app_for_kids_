// Liquid Glass-inspired material: blur + saturation, rim light, and a static specular highlight that
// follows the mouse on desktop. The light is set per element, so moving it never restyles the page.
import type { ButtonHTMLAttributes, CSSProperties, ElementType, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { Icon } from './icons.tsx'
import type { IconName } from './icons.tsx'
import { cx, usePress } from './press.ts'
import './glass.css'

/**
 * @deprecated Device tilt is gone: it cost an iOS permission prompt and a full-page restyle per
 * sensor event. Always resolves false; delete the call.
 */
export async function requestMotionPermission(): Promise<boolean> {
  return false
}

// ---- Pointer-follow highlight (desktop) ----

function trackPointer(e: ReactPointerEvent<HTMLElement>) {
  if (e.pointerType !== 'mouse') return
  const el = e.currentTarget
  const r = el.getBoundingClientRect()
  const x = ((e.clientX - r.left) / r.width) * 100
  const y = ((e.clientY - r.top) / r.height) * 100
  el.style.setProperty('--spec-x', `${x.toFixed(1)}%`)
  el.style.setProperty('--spec-y', `${y.toFixed(1)}%`)
  el.style.setProperty('--light-angle', `${(180 - (x - 50) * 1.2).toFixed(1)}deg`)
}

function resetPointer(e: ReactPointerEvent<HTMLElement>) {
  const s = e.currentTarget.style
  s.removeProperty('--spec-x')
  s.removeProperty('--spec-y')
  s.removeProperty('--light-angle')
}

export interface GlassSurfaceProps {
  children?: ReactNode
  /** Corner radius in px (default: capsule). */
  radius?: number
  /** Highlight follows the mouse (desktop). Default true. */
  interactive?: boolean
  as?: ElementType
  className?: string
  style?: CSSProperties
}

/** A floating glass panel. Keep these few per screen: each one is a backdrop blur. */
export function GlassSurface({ children, radius, interactive = true, as: Tag = 'div', className, style }: GlassSurfaceProps) {
  return (
    <Tag
      className={cx('ui-glass', className)}
      style={radius != null ? { borderRadius: radius, ...style } : style}
      onPointerMove={interactive ? trackPointer : undefined}
      onPointerLeave={interactive ? resetPointer : undefined}
    >
      {children}
    </Tag>
  )
}

export interface GlassButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon?: IconName
  /** Text label; without it the button is a 44px circle (pass aria-label). */
  children?: ReactNode
  size?: 'small' | 'regular' | 'large'
  /** Label-tinted glass for the primary action in a bar (inverted glyph). */
  prominent?: boolean
}

/** Bar button in a glass capsule, like iOS 26 navigation and toolbar items. */
export function GlassButton({ icon, children, size = 'regular', prominent, className, disabled, type = 'button', ...rest }: GlassButtonProps) {
  const { pressed, handlers } = usePress(!disabled, 30)
  const iconSize = size === 'small' ? 17 : size === 'large' ? 24 : 21
  return (
    <button
      {...rest}
      {...handlers}
      type={type}
      disabled={disabled}
      data-pressed={pressed || undefined}
      className={cx(
        'ui-glass ui-glass-button',
        `ui-glass-button--${size}`,
        !children && 'ui-glass-button--round',
        prominent && 'ui-glass-button--prominent',
        className,
      )}
      onPointerMove={(e) => {
        handlers.onPointerMove(e)
        trackPointer(e)
      }}
      onPointerLeave={(e) => {
        handlers.onPointerLeave()
        resetPointer(e)
      }}
    >
      {icon && <Icon name={icon} size={iconSize} weight={2} />}
      {children != null && <span className="ui-glass-button__label">{children}</span>}
    </button>
  )
}
