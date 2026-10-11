import { defineConfig } from 'vitest/config'

// Data-layer integration tests against their own emulator suite (auth :9199, firestore :8180):
// npx firebase emulators:exec --config tests/data/firebase.data.json --only auth,firestore --project demo-stakes "npx vitest run --config vitest.data.config.ts"
export default defineConfig({
  test: {
    include: ['tests/data/**/*.test.ts'],
    environment: 'node',
    // One shared emulator; each file clears it first.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
