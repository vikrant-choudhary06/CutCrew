import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { LibraryProvider } from './components/LibraryContext'
import { InstantProvider } from './lib/instant'
import './index.css'
import './styles/player.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <LibraryProvider>
        <InstantProvider><App /></InstantProvider>
      </LibraryProvider>
    </BrowserRouter>
  </StrictMode>,
)
