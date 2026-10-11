// Monogram avatars like Contacts: initials in SF Rounded on the person's color with a soft top light.
import type { CSSProperties } from 'react'
import { cx } from './press.ts'
import './avatar.css'

/** "Marco Rossi" → "MR"; with max 1 → "M". */
export function initialsFor(name: string, max: 1 | 2 = 2): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = [...words[0]][0] ?? ''
  const last = max > 1 && words.length > 1 ? ([...words[words.length - 1]][0] ?? '') : ''
  return (first + last).toUpperCase()
}

export interface AvatarProps {
  name: string
  /** Background color, e.g. from colorForUid(uid) or the user's profile color. */
  color: string
  /** Diameter in px (default 36). */
  size?: number
  className?: string
  style?: CSSProperties
}

export function Avatar({ name, color, size = 36, className, style }: AvatarProps) {
  return (
    <span
      className={cx('ui-avatar', className)}
      role="img"
      aria-label={name}
      style={{ '--avatar-color': color, width: size, height: size, fontSize: Math.round(size * 0.4), ...style } as CSSProperties}
    >
      {initialsFor(name, size < 32 ? 1 : 2)}
    </span>
  )
}

export interface AvatarStackProps {
  people: Array<{ id?: string; name: string; color: string }>
  /** Show at most this many; the rest collapse into "+N" (default 4). */
  max?: number
  size?: number
  className?: string
}

export function AvatarStack({ people, max = 4, size = 28, className }: AvatarStackProps) {
  const shown = people.slice(0, max)
  const extra = people.length - shown.length
  return (
    <span className={cx('ui-avatar-stack', className)} style={{ '--stack-size': `${size}px` } as CSSProperties}>
      {shown.map((p, i) => (
        <Avatar key={p.id ?? `${p.name}-${i}`} name={p.name} color={p.color} size={size} className="ui-avatar-stack__item" />
      ))}
      {extra > 0 && (
        <span className="ui-avatar-stack__more" style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}>
          +{extra}
        </span>
      )}
    </span>
  )
}
