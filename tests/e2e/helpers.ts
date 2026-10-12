// Browser helpers shared by the end-to-end specs: an iPhone-sized phone per person, screenshots, and
// lookups that only see what is on screen.
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test'
import { iPhone } from './device.ts'

const SHOTS = process.env.E2E_SCREENSHOTS
const WIDTHS = (process.env.E2E_WIDTHS ?? '')
  .split(',')
  .map(Number)
  .filter((w) => w > 0)

/** `intro`: a phone that has never seen the intro. Otherwise it was seen long ago, as on most phones. */
export async function phone(browser: Browser, opts: { intro?: boolean } = {}): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext(iPhone)
  if (!opts.intro) await context.addInitScript(() => localStorage.setItem('stakes.introSeen', '1'))
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

/** Light and dark screenshots to $E2E_SCREENSHOTS, plus light ones at the widths in $E2E_WIDTHS. */
export async function snap(page: Page, name: string, settle = 700): Promise<void> {
  if (!SHOTS) return
  await page.waitForTimeout(settle)
  await page.screenshot({ path: `${SHOTS}/${name}-light.png` })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(250)
  await page.screenshot({ path: `${SHOTS}/${name}-dark.png` })
  await page.emulateMedia({ colorScheme: 'light' })
  if (WIDTHS.length === 0) return
  const size = page.viewportSize() ?? iPhone.viewport
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: Math.round((width * 844) / 390) })
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOTS}/${name}-light-${width}.png` })
  }
  await page.setViewportSize(size)
  await page.waitForTimeout(300)
}

/** The top-most sheet. Pages under it stay mounted (inert), so sheet controls are looked up inside it. */
export const sheet = (page: Page) => page.getByRole('dialog').last()

/** Visible text only: screens lower in a navigation stack, and other tabs, stay mounted, just hidden. */
export const shown = (scope: Page | Locator, text: string | RegExp, exact = false) => scope.getByText(text, { exact }).filter({ visible: true }).first()
export const score = (scope: Page | Locator, value: string) => scope.locator('.s-mini-score__value', { hasText: value }).filter({ visible: true }).first()
