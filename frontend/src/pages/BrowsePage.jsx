import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Grid } from '../components/Rows'
import { Notice } from '../components/Shell'
import { getJSON, GENRES } from '../lib/api'

export default function BrowsePage({ type }) {
  const [params, setParams] = useSearchParams()
  const genre = GENRES.includes(params.get('genre')) ? params.get('genre') : ''
  const newest = params.get('sort') === 'new'
  const india = newest && params.get('country') === 'IN'
  const filterKey = `${type}|${genre}|${newest}|${india}`
  // Pages and results belong to one filter; changing it starts again at page 1.
  const [view, setView] = useState({ filterKey, pages: 1, items: [], loaded: 0, error: '', hasMore: false, retry: 0 })
  if (view.filterKey !== filterKey) setView({ filterKey, pages: 1, items: [], loaded: 0, error: '', hasMore: false, retry: 0 })
  const page = view.filterKey === filterKey ? view.pages : 1
  const loading = view.loaded < page && !view.error

  useEffect(() => {
    if (view.loaded >= page) return
    const controller = new AbortController()
    const q = new URLSearchParams({ type, page: String(page), limit: '24' })
    if (genre) q.set('genre', genre)
    if (india) q.set('country', 'IN')
    // "New" lists recent releases by popularity; otherwise the full catalogue.
    getJSON((newest ? '/api/discover/new?' : '/api/discover?') + q, { signal: controller.signal, timeout: 60000 }).then(body => {
      const fresh = body.data || []
      setView(v => {
        if (v.filterKey !== filterKey) return v
        const seen = new Set(v.items.map(x => x.imdb_id))
        return { ...v, items: [...v.items, ...fresh.filter(x => !seen.has(x.imdb_id))], loaded: page, error: '', hasMore: !!body.hasMore && page < 40 }
      })
    }).catch(error => { if (!controller.signal.aborted) setView(v => (v.filterKey === filterKey ? { ...v, error: error.name === 'TimeoutError' ? 'Loading took too long.' : 'Titles could not load.' } : v)) })
    return () => controller.abort()
  }, [filterKey, page, view.retry]) // eslint-disable-line react-hooks/exhaustive-deps

  const retry = () => setView(v => ({ ...v, error: '', retry: v.retry + 1 }))
  const label = type === 'series' ? 'Series' : 'Movies'
  // Genre chips keep the "new" (and India) filter while it is on.
  const pick = g => setParams({ ...(g ? { genre: g } : {}), ...(newest ? { sort: 'new' } : {}), ...(india ? { country: 'IN' } : {}) }, { replace: true })
  return <main id="main" className="page browse">
    <h1 className="page-title">{[newest ? 'New' : '', india ? 'Indian' : '', genre, newest || genre || india ? label.toLowerCase() : label].filter(Boolean).join(' ')}</h1>
    <div className="chips browse-chips" role="group" aria-label="Filter by genre">
      <button className="chip" aria-pressed={!genre} onClick={() => pick('')}>All</button>
      {GENRES.map(g => <button key={g} className="chip" aria-pressed={genre === g} onClick={() => pick(g)}>{g}</button>)}
    </div>
    {view.error && !view.items.length ? <Notice title={view.error} action={<button className="button button--quiet" onClick={retry}>Try again</button>}>Check your connection, then try again.</Notice> :
      !loading && !view.items.length ? <Notice title={`No ${label.toLowerCase()} found.`} action={<button className="button button--quiet" onClick={() => pick('')}>Show all {label.toLowerCase()}</button>}>Try another genre.</Notice> :
        <Grid items={view.items} loading={loading} />}
    {view.items.length > 0 && <div className="load-more">
      {view.error ? <button className="button button--quiet" onClick={retry}>Couldn't load more. Try again</button>
        : view.hasMore ? <button className="button button--quiet" disabled={loading} onClick={() => setView(v => ({ ...v, pages: v.pages + 1 }))}>{loading ? 'Loading…' : 'Load more'}</button>
          : !loading && <p className="muted">That's everything in this list.</p>}
    </div>}
  </main>
}
