// Dev-only entry for gallery.html (not part of the production build).
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Gallery } from './Gallery.tsx'
import './global.css'

const theme = new URLSearchParams(location.search).get('theme')
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
)
