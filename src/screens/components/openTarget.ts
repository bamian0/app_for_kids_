// A notification can open the app on one space, and on one month of it (the verdict push):
// ./?space=<spaceId>&month=YYYY-MM. Read once at startup and removed from the address bar.

export interface OpenTarget {
  spaceId: string
  monthId: string | null
}

let target: OpenTarget | null = null
let captured = false

export function parseOpenTarget(search: string): OpenTarget | null {
  const params = new URLSearchParams(search)
  const spaceId = params.get('space')
  if (!spaceId || !/^[A-Za-z0-9_-]{1,128}$/.test(spaceId)) return null
  const month = params.get('month')
  return { spaceId, monthId: month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : null }
}

export function captureOpenParam(): void {
  if (captured || typeof window === 'undefined') return
  captured = true
  const url = new URL(window.location.href)
  if (!url.searchParams.has('space')) return
  target = parseOpenTarget(url.search)
  url.searchParams.delete('space')
  url.searchParams.delete('month')
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

/** The target, cleared so it opens only once. */
export function takeOpenTarget(): OpenTarget | null {
  const t = target
  target = null
  return t
}
