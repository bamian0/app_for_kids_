// Single source of "now" for the app. In dev builds, `?now=2026-10-16T10:00` shifts the clock
// so screens can be checked in any week phase. Firestore rules still use real server time.

let offsetMs = 0

export function initClockFromUrl(search: string, allowOverride: boolean): void {
  if (!allowOverride) return
  const value = new URLSearchParams(search).get('now')
  if (!value) return
  const target = Date.parse(value)
  if (!Number.isNaN(target)) offsetMs = target - Date.now()
}

export function now(): number {
  return Date.now() + offsetMs
}
