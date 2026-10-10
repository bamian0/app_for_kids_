import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Relative base so the build works at any path (GitHub Pages serves it under /app_for_kids_/).
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { host: true },
})
