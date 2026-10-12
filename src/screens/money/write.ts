// Money writes show up at once (the local cache has them) and reach the server when they can, even
// after going offline. So a sheet doesn't wait for the server: it waits a beat for a quick refusal
// (a bad amount, no access) to show in place, then closes; anything refused later is a banner.

const QUICK_MS = 700

/** Resolves once `write` succeeds or has had QUICK_MS to fail; rejects only with a quick refusal. */
export function quickWrite(write: Promise<unknown>, onLateError: (error: unknown) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let waited = false
    const timer = window.setTimeout(() => {
      waited = true
      resolve()
    }, QUICK_MS)
    write.then(
      () => {
        window.clearTimeout(timer)
        resolve()
      },
      (error: unknown) => {
        if (waited) {
          onLateError(error)
          return
        }
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong. Try again.'
}
