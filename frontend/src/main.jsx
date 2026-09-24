import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Fade out and remove the initial splash screen (see index.html) once React
// has mounted and painted. The short minimum-display delay keeps the logo
// from just flashing on screen on fast/warm loads, then the CSS transition
// on #initial-loader (index.html) handles the fade before it's removed.
window.setTimeout(() => {
  requestAnimationFrame(() => {
    const loader = document.getElementById('initial-loader')
    if (!loader) return
    loader.classList.add('loader-hidden')
    window.setTimeout(() => loader.remove(), 450)
  })
}, 400)