// Names and avatars for members, with sensible fallbacks while profiles load.
import { colorForUid } from '../../domain/ids.ts'
import type { UID, UserProfile } from '../../domain/types.ts'

export type Profiles = Record<UID, UserProfile>

export function nameOf(profiles: Profiles, uid: UID): string {
  return profiles[uid]?.name?.trim() || 'Someone'
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name
}

/** First name, or "You" for the current user. */
export function shortName(profiles: Profiles, uid: UID, me: UID | null): string {
  return uid === me ? 'You' : firstName(nameOf(profiles, uid))
}

/** Only a plain hex color reaches CSS: anything else in a profile could load a URL from every viewer. */
const HEX_COLOR = /^#[0-9a-f]{6}$/i

export function personOf(profiles: Profiles, uid: UID) {
  const color = profiles[uid]?.color
  return { id: uid, name: nameOf(profiles, uid), color: color && HEX_COLOR.test(color) ? color : colorForUid(uid) }
}

/** "Alex", "Alex and Sam", "Alex, Sam and Kim". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** Short list for buttons: names up to three people, then a count. */
export function compactNames(names: string[], noun = 'friends'): string {
  return names.length > 3 ? `${names.length} ${noun}` : listNames(names)
}
