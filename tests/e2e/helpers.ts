// Browser helpers shared by the end-to-end specs: an iPhone-sized phone per person, screenshots, and
// lookups that only see what is on screen.
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test'
import { iPhone } from './device.ts'

const SHOTS = process.env.E2E_SCREENSHOTS
const WIDTHS = (process.env.E2E_WIDTHS ?? '')
  .split(',')
  .map(Number)
  .filter((w) => w > 0)

/** `intro`: a phone that has never seen the intro. Otherwise it was seen long ago, as on most phones.
 *  `installed`: the app opened from the Home Screen. `userAgent`: another kind of phone. */
export async function phone(
  browser: Browser,
  opts: { intro?: boolean; installed?: boolean; userAgent?: string } = {},
): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ ...iPhone, userAgent: opts.userAgent ?? iPhone.userAgent })
  if (!opts.intro) await context.addInitScript(() => localStorage.setItem('stakes.introSeen', '1'))
  // How iOS tells a page it runs as a Home Screen app.
  if (opts.installed) await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true }))
  // Counts every mount of the Siri-style edge glow (it is gone again a few seconds later).
  await context.addInitScript(() => {
    const w = window as unknown as { __edgeGlows: number }
    w.__edgeGlows = 0
    new MutationObserver((records) => {
      for (const r of records)
        r.addedNodes.forEach((node) => {
          if (node instanceof Element && (node.matches('.ui-edge-glow') || node.querySelector('.ui-edge-glow'))) w.__edgeGlows++
        })
    }).observe(document, { childList: true, subtree: true })
  })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  return { context, page, errors }
}

export const edgeGlows = (page: Page) => page.evaluate(() => (window as unknown as { __edgeGlows: number }).__edgeGlows)

type Block = 'start' | 'center' | 'end' | 'nearest'
/** What the next `snap` of a page keeps in view at each width. */
const inView = new WeakMap<Page, { target: Locator; block: Block }>()
const scrollTo = (target: Locator, block: Block) => target.evaluate((el, b) => el.scrollIntoView({ block: b }), block, { timeout: 2000 })

async function lightAndDark(page: Page, path: string): Promise<void> {
  await page.screenshot({ path: `${path}-light.png` })
  // Colors cross-fade in 0.2s; software rendering needs longer before every layer has caught up.
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${path}-dark.png` })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.waitForTimeout(700)
}

/** Light and dark screenshots to $E2E_SCREENSHOTS: at the phone's own size, or, when $E2E_WIDTHS is set
 *  (e.g. "375,430"), at each of those widths instead (`${name}-375-light.png`). `viewport` shoots exactly
 *  that size once (e.g. 375 × 667, the smallest iPhone in use). */
export async function snap(page: Page, name: string, settle = 700, viewport?: { width: number; height: number }): Promise<void> {
  if (!SHOTS) return
  await page.waitForTimeout(settle)
  const sizes = viewport ? [viewport] : WIDTHS.map((width) => ({ width, height: Math.round((width * 844) / 390) }))
  if (sizes.length === 0) return lightAndDark(page, `${SHOTS}/${name}`)
  const size = page.viewportSize() ?? iPhone.viewport
  const keep = inView.get(page)
  for (const s of sizes) {
    await page.setViewportSize(s)
    await page.waitForTimeout(400)
    // Another width reflows the page: bring back what the shot is about.
    if (keep) await scrollTo(keep.target, keep.block).catch(() => {})
    await lightAndDark(page, `${SHOTS}/${name}-${s.width}${viewport ? `x${s.height}` : ''}`)
  }
  inView.delete(page)
  await page.setViewportSize(size)
  await page.waitForTimeout(300)
}

/** Scrolls its screen so `target` sits mid-screen (or, with `block: 'end'`, ends at the bottom), for a
 *  screenshot of something below the fold. The next `snap` scrolls to it again at each width it shoots. */
export async function centerOn(target: Locator, block: Block = 'center'): Promise<void> {
  await target.evaluate((el, b) => el.scrollIntoView({ block: b }), block)
  inView.set(target.page(), { target, block })
}

/** The top-most sheet. Pages under it stay mounted (inert), so sheet controls are looked up inside it. */
export const sheet = (page: Page) => page.getByRole('dialog').last()

/** Visible text only: screens lower in a navigation stack, and other tabs, stay mounted, just hidden. */
export const shown = (scope: Page | Locator, text: string | RegExp, exact = false) => scope.getByText(text, { exact }).filter({ visible: true }).first()
export const score = (scope: Page | Locator, value: string) => scope.locator('.s-mini-score__value', { hasText: value }).filter({ visible: true }).first()
