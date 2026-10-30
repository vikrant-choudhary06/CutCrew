// Which titles have a Ready Telegram-stored copy ("Instant"). Fetched once per
// page load; failures simply mean no badges.
/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useState } from 'react'
import { getJSON } from './api'

const InstantContext = createContext(new Set())

export function InstantProvider({ children }) {
  const [ids, setIds] = useState(() => new Set())
  useEffect(() => {
    const controller = new AbortController()
    getJSON('/api/stored/available', { signal: controller.signal, timeout: 8000 })
      .then(body => { if (Array.isArray(body.data)) setIds(new Set(body.data)) })
      .catch(() => {})
    return () => controller.abort()
  }, [])
  return <InstantContext.Provider value={ids}>{children}</InstantContext.Provider>
}

export const useInstant = () => useContext(InstantContext)
