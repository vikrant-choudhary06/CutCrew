import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { LibraryProvider } from './components/LibraryContext'
import './index.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LibraryProvider><App /></LibraryProvider>
  </StrictMode>,
)
