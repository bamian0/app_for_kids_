import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// One id per build, shared by the page (import.meta.env.VITE_BUILD_ID) and sw.js. A new deploy is then
// a byte-different worker, which a resumed app finds, and the page can tell it is out of date.
const BUILD_ID = process.env.GITHUB_SHA?.slice(0, 12) || Date.now().toString(36)

/** sw.js is copied from public/ untouched; write the build id into the copy in dist/. */
function stampServiceWorker(): Plugin {
  let outDir = 'dist'
  return {
    name: 'stakes:stamp-sw',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    writeBundle() {
      const file = join(outDir, 'sw.js')
      const source = readFileSync(file, 'utf8')
      const stamped = source.replace("const BUILD = 'dev'", `const BUILD = ${JSON.stringify(BUILD_ID)}`)
      if (stamped === source) throw new Error(`${file}: the BUILD placeholder is missing`)
      writeFileSync(file, stamped)
    },
  }
}

// Relative base so the build works at any path (GitHub Pages serves it under /app_for_kids_/).
export default defineConfig({
  base: './',
  plugins: [react(), stampServiceWorker()],
  define: { 'import.meta.env.VITE_BUILD_ID': JSON.stringify(BUILD_ID) },
  resolve: {
    // Only Firestore's client-side pipeline regex functions use re2js (144 kB); the app has no pipelines.
    alias: { re2js: fileURLToPath(new URL('./src/stubs/re2js.ts', import.meta.url)) },
  },
  build: {
    rolldownOptions: {
      output: {
        // Libraries change far less often than the app: a typical deploy then re-downloads only the
        // app chunk (~45 kB gzip) instead of everything. Screens stay in one chunk on purpose: a
        // resumed old client would 404 on lazy chunks deleted by the next deploy.
        codeSplitting: {
          groups: [
            { name: 'firebase', test: /node_modules[\\/](@firebase|firebase|idb)[\\/]/ },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'motion', test: /node_modules[\\/](motion|motion-dom|motion-utils|framer-motion)[\\/]/ },
            { name: 'luxon', test: /node_modules[\\/]luxon[\\/]/ },
          ],
        },
      },
    },
  },
  server: { host: true },
})
