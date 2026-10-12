// Avatars like Contacts: the person's photo, or initials in SF Rounded on their color with a soft top light.
import { useState } from 'react'
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
  /** Photo URL, e.g. the profile's data URL. Missing, or failing to load, shows the initials. */
  photo?: string
  /** Diameter in px (default 36). */
  size?: number
  className?: string
  style?: CSSProperties
}

export function Avatar({ name, color, photo, size = 36, className, style }: AvatarProps) {
  // The photo that failed to load: initials from then on, until a different photo arrives.
  const [broken, setBroken] = useState<string | null>(null)
  const showPhoto = !!photo && photo !== broken
  return (
    <span
      className={cx('ui-avatar', showPhoto && 'ui-avatar--photo', className)}
      role="img"
      aria-label={name}
      style={{ '--avatar-color': color, width: size, height: size, fontSize: Math.round(size * 0.4), ...style } as CSSProperties}
    >
      {showPhoto ? (
        <img className="ui-avatar__photo" src={photo} alt={name} decoding="async" draggable={false} onError={() => setBroken(photo)} />
      ) : (
        initialsFor(name, size < 32 ? 1 : 2)
      )}
    </span>
  )
}

export interface AvatarStackProps {
  people: Array<{ id?: string; name: string; color: string; photo?: string }>
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
        <Avatar key={p.id ?? `${p.name}-${i}`} name={p.name} color={p.color} photo={p.photo} size={size} className="ui-avatar-stack__item" />
      ))}
      {extra > 0 && (
        <span className="ui-avatar-stack__more" style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}>
          +{extra}
        </span>
      )}
    </span>
  )
}
