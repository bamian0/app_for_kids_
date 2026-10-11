// An invite link (?join=CODE) may arrive before the user has an account. Remember the code until
// they are signed in, and clean it out of the address bar right away.
import { readSession, writeSession } from './storage.ts'

const KEY = 'pendingJoin'
let pending: string | null = null
let captured = false

/** Reads ?join= once at startup and removes it from the URL (other params like ?now= stay). */
export function captureJoinParam(): void {
  if (captured || typeof window === 'undefined') return
  captured = true
  const url = new URL(window.location.href)
  const code = url.searchParams.get('join')
  if (code === null) {
    // A reload before sign-in finished: keep the code from this tab's session.
    pending = readSession(KEY)
    return
  }
  pending = code.trim() || null
  writeSession(KEY, pending)
  url.searchParams.delete('join')
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

export function hasPendingJoin(): boolean {
  return pending !== null
}

/** The pending code without taking it (the welcome screen previews the invite). */
export function peekPendingJoin(): string | null {
  return pending
}

/** The pending code, cleared so it opens the join flow only once. */
export function takePendingJoin(): string | null {
  const code = pending
  pending = null
  writeSession(KEY, null)
  return code
}
