import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initClockFromUrl } from './domain/clock.ts'
import { registerServiceWorker } from './push/index.ts'
import App from './App.tsx'
import './ui/global.css'

initClockFromUrl(location.search, import.meta.env.DEV)
registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
