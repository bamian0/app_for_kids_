// Liquid Glass-inspired material: blur + saturation, rim light, and a specular highlight that follows
// the pointer on desktop and device tilt on iPhone (after requestMotionPermission()).
import type { ButtonHTMLAttributes, CSSProperties, ElementType, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { Icon } from './icons.tsx'
import type { IconName } from './icons.tsx'
import { cx, usePress } from './press.ts'
import './glass.css'

// ---- Device tilt → global light direction ----

let tiltStarted = false

function startTilt() {
  if (tiltStarted || typeof window === 'undefined') return
  tiltStarted = true
  const root = document.documentElement.style
  let target = { x: 30, y: 0, angle: 160 }
  let current = { ...target }
  let frame = 0
  const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
  const tick = () => {
    // Low-pass filter so the highlight glides instead of jittering with sensor noise.
    current = {
      x: current.x + (target.x - current.x) * 0.18,
      y: current.y + (target.y - current.y) * 0.18,
      angle: current.angle + (target.angle - current.angle) * 0.18,
    }
    root.setProperty('--spec-x', `${current.x.toFixed(1)}%`)
    root.setProperty('--spec-y', `${current.y.toFixed(1)}%`)
    root.setProperty('--light-angle', `${current.angle.toFixed(1)}deg`)
    const settled = Math.abs(target.x - current.x) + Math.abs(target.y - current.y) + Math.abs(target.angle - current.angle) < 0.3
    frame = settled ? 0 : requestAnimationFrame(tick)
  }
  window.addEventListener('deviceorientation', (e) => {
    if (e.beta == null || e.gamma == null) return
    const gamma = clamp(e.gamma, -35, 35)
    const beta = clamp(e.beta - 50, -35, 35)
    target = { x: 50 - gamma * 1.25, y: 10 - beta * 0.9, angle: 180 - gamma * 2.2 }
    if (!frame) frame = requestAnimationFrame(tick)
  })
}

/**
 * Asks for motion access (iOS requires it) and starts tilt-driven glass highlights.
 * Must be called from a tap handler. Resolves false and does nothing on refusal or missing sensors.
 */
export async function requestMotionPermission(): Promise<boolean> {
  try {
    if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return false
    const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }
    if (typeof DOE.requestPermission === 'function') {
      const result = await DOE.requestPermission()
      if (result !== 'granted') return false
    }
    startTilt()
    return true
  } catch {
    return false
  }
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
