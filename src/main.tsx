import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    if (import.meta.env.DEV) {
      // Prevent an old production worker from masking Vite's live files.
      navigator.serviceWorker.getRegistrations().then((registrations) => registrations.forEach((registration) => registration.unregister())).catch(() => undefined)
      if ('caches' in window) caches.keys().then((keys) => keys.filter((key) => key.startsWith('stillpoint-')).forEach((key) => caches.delete(key))).catch(() => undefined)
    } else {
      navigator.serviceWorker.register('./sw.js').catch(() => undefined)
    }
  })
}
