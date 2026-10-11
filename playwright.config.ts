import { defineConfig } from '@playwright/test'
import { iPhone } from './tests/e2e/device.ts'

// End-to-end tests against the Firebase emulators and the Vite dev server (see tests/e2e/flow.spec.ts):
//   npx firebase emulators:exec --only auth,firestore --project demo-stakes "npx playwright test"
// Playwright starts the dev server itself, on its own port so it never reuses a server without VITE_EMULATORS.
const PORT = 5199

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 300_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    browserName: 'chromium',
    ...iPhone,
    // Software GL, so backdrop blurs render like on a device instead of leaving text sharp.
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort --host 127.0.0.1`,
    env: { VITE_EMULATORS: '1' },
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
