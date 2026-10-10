import { defineConfig } from 'vitest/config'

// Security rules tests. They need the Firestore emulator: run them with `npm run test:rules`.
export default defineConfig({
  test: {
    include: ['tests/rules/**/*.test.ts'],
    environment: 'node',
    // All files share one emulator and clear it between tests.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
