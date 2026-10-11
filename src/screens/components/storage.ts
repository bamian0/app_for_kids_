// Device-local memory (drafts, dismissed cards, moments already played). Private mode or blocked
// storage must never break a screen, so every access is guarded.

const PREFIX = 'stakes.'

export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key)
  } catch {
    return null
  }
}

export function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(PREFIX + key)
    else localStorage.setItem(PREFIX + key, value)
  } catch {
    // Storage full or blocked: the feature just doesn't persist.
  }
}

export function readJSON<T>(key: string): T | null {
  const raw = readLocal(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function writeJSON(key: string, value: unknown): void {
  writeLocal(key, value === null ? null : JSON.stringify(value))
}

/** True only the first time it is called for `key` on this device. */
export function firstTime(key: string): boolean {
  if (readLocal(key)) return false
  writeLocal(key, '1')
  return true
}

export function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(PREFIX + key)
  } catch {
    return null
  }
}

export function writeSession(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(PREFIX + key)
    else sessionStorage.setItem(PREFIX + key, value)
  } catch {
    // Ignored, as above.
  }
}
