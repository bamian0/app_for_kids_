import type { BrowserContextOptions } from '@playwright/test'

/** An iPhone 15-sized phone in Rome. Every e2e browser context uses it. */
export const iPhone = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  locale: 'en-US',
  timezoneId: 'Europe/Rome',
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
} satisfies BrowserContextOptions
