import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import { installEssentialMotion } from './essential-motion'
import './index.css'

installEssentialMotion()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
