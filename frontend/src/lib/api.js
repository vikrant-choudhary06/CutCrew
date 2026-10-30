// Backend access, artwork URLs and small formatting helpers shared by pages.
export const base = (import.meta.env.VITE_BACKEND_URL || '').replace(/\/$/, '')

const cache = new Map()
const CACHE_MS = 5 * 60 * 1000

// GET JSON with a timeout. Successful responses are cached for a few minutes
// so moving between pages (title -> player -> back) doesn't refetch.
export async function getJSON(path, { signal, timeout = 30000, fresh = false } = {}) {
  const hit = cache.get(path)
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.body
  const response = await fetch(base + path, { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeout)]) })
  let body = null
  try { body = await response.json() } catch { /* handled below */ }
  if (!response.ok || !body) throw new Error(body?.message || body?.error || 'The server did not respond. Check your connection and try again.')
  cache.set(path, { body, at: Date.now() })
  return body
}

export const peekJSON = path => cache.get(path)?.body

export const isSeries = item => /series|episode/i.test(item?.title_type || '')

// Cinemeta artwork exists for every IMDb title: posters, wide backgrounds
// and transparent title logos.
const art = (kind, size, id) => `https://images.metahub.space/${kind}/${size}/${id}/img`
export const posterUrl = (item, size = 'small') => (size === 'small' && item?.poster_url) || (item?.imdb_id ? art('poster', size, item.imdb_id) : '')
export const backdropUrl = (item, size = 'medium') => (size !== 'small' && item?.backdrop_url) || (item?.imdb_id ? art('background', size, item.imdb_id) : '')
export const logoUrl = (item, size = 'medium') => (item?.imdb_id ? art('logo', size, item.imdb_id) : '')

export function runtimeLabel(minutes) {
  const m = Number(minutes)
  if (!(m > 0)) return ''
  const h = Math.floor(m / 60)
  return h ? `${h}h ${m % 60}m` : `${m}m`
}

export const ratingLabel = rating => (Number(rating) > 0 ? Number(rating).toFixed(1) : '')

// Known genre names the discover API accepts.
export const GENRES = ['Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Music', 'Mystery', 'Romance', 'Sci-Fi', 'Thriller', 'War', 'Western']

export const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

export function titlePath(item) { return `/title/${item.imdb_id || item.id}` }
export function watchPath(item, season, episode) {
  const params = new URLSearchParams()
  if (season) params.set('season', season)
  if (episode) params.set('episode', episode)
  const q = params.toString()
  return `/watch/${item.imdb_id || item.id}${q ? '?' + q : ''}`
}
