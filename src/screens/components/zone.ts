// Time zone helpers for the small "times are in Rome time" notes.

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
export function zoneNote(spaceZone: string): string | null {
  const device = deviceZone()
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
