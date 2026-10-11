// Time zone helpers: the "deadlines follow Rome time" note, and deadlines in words. A space's
// deadlines are midnights on its own clock; a friend on another clock gets the time on theirs.

export function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** "Europe/Rome" → "Rome", "America/Port_of_Spain" → "Port of Spain". */
export function cityOf(zone: string): string {
  return (zone.split('/').pop() ?? zone).replace(/_/g, ' ')
}

/** A note when this device runs on a different clock than the space, else null. */
export function zoneNote(spaceZone: string, device: string = deviceZone()): string | null {
  if (device === spaceZone) return null
  // Zones that keep the same clock (e.g. Europe/Rome and Europe/Berlin, summer and winter) need no note.
  const offsets = (zone: string) => {
    try {
      const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      const offsetAt = (ms: number) => fmt.formatToParts(ms).find((p) => p.type === 'timeZoneName')?.value
      return `${offsetAt(Date.now())}|${offsetAt(Date.now() + 182 * 86_400_000)}`
    } catch {
      return zone
    }
  }
  if (offsets(device) === offsets(spaceZone)) return null
  return `Deadlines follow ${cityOf(spaceZone)} time.`
}

/** The device's preferred clock: "3:00 PM" or "15:00". */
const HOUR_CYCLE = (() => {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle
  } catch {
    return undefined
  }
})()

function inZone(ms: number, zone: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone }).format(ms)
  } catch {
    return new Intl.DateTimeFormat('en-US', options).format(ms)
  }
}

/** "Mon 3:00 PM" (or "Mon 15:00") on this device's clock. */
export function deviceTime(ms: number, device: string = deviceZone()): string {
  return inZone(ms, device, { weekday: 'short', hour: 'numeric', minute: '2-digit', hourCycle: HOUR_CYCLE }).replace(/[\u202f\u00a0]/g, ' ')
}

/** The calendar day of `ms` in `zone`, as a UTC-midnight timestamp (for whole-day differences). */
function dayOf(ms: number, zone: string): number {
  const [month, day, year] = inZone(ms, zone, { year: 'numeric', month: 'numeric', day: 'numeric' }).split('/').map(Number)
  return Date.UTC(year, month - 1, day)
}

function isMidnight(ms: number, zone: string): boolean {
  return inZone(ms, zone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) === '00:00'
}

/**
 * A deadline in words. On the space's own clock it is a midnight: "tonight at midnight", "tomorrow at
 * midnight", "Friday at midnight", "next Monday at midnight". On another clock (or for a skewed week
 * that doesn't end at midnight) it is the time on this device: "Mon 3:00 PM".
 */
export function deadlineText(ms: number, spaceZone: string, nowMs: number, device: string = deviceZone()): string {
  if (zoneNote(spaceZone, device) !== null || !isMidnight(ms, spaceZone)) return deviceTime(ms, device)
  // The deadline ends the day before it.
  const day = ms - 1
  const ahead = Math.round((dayOf(day, spaceZone) - dayOf(nowMs, spaceZone)) / 86_400_000)
  const weekday = inZone(day, spaceZone, { weekday: 'long' })
  if (ahead <= 0) return 'tonight at midnight'
  if (ahead === 1) return 'tomorrow at midnight'
  return `${ahead >= 7 ? 'next ' : ''}${weekday} at midnight`
}

/** Short form for status lines: the day a deadline ends ("Mon"), or "Mon 3:00 PM" on another clock. */
export function deadlineDay(ms: number, spaceZone: string, device: string = deviceZone()): string {
  if (zoneNote(spaceZone, device) !== null || !isMidnight(ms, spaceZone)) return deviceTime(ms, device)
  return inZone(ms - 1, spaceZone, { weekday: 'short' })
}
