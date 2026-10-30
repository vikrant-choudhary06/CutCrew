import { useEffect, useState } from 'react'
const base = (import.meta.env.VITE_BACKEND_URL || '').replace(/\/$/, '')
const genres = ['Action','Adventure','Animation','Comedy','Crime','Documentary','Drama','Family','Fantasy','History','Horror','Music','Mystery','Romance','Sci-Fi','Thriller','War','Western']
export default function BrowseCollection({ collection, onSelect, renderCard }) {
  const [type, setType] = useState(collection.kind || 'movie')
  const [genre, setGenre] = useState(collection.genre || '')
  const [year, setYear] = useState('')
  const [language, setLanguage] = useState('')
  const [page, setPage] = useState(1)
  const [retry, setRetry] = useState(0)
  const [state, setState] = useState({ loading: true, items: [], error: '', hasMore: false })
  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const params = new URLSearchParams({ type, genre, page: String(page), limit: '18' })
        const response = await fetch(`${base}/api/discover?${params}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]) })
        const body = await response.json()
        if (!response.ok) throw new Error(body.message || 'Could not load this collection. Please retry.')
        if (controller.signal.aborted) return
        setState(previous => {
          const old = page === 1 ? [] : previous.items, ids = new Set(old.map(item => item.imdb_id))
          const fresh = (body.data || []).filter(item => !ids.has(item.imdb_id))
          return { items: [...old, ...fresh], loading: false, error: '', hasMore: !!body.hasMore && fresh.length > 0 && page < 100 }
        })
      } catch (error) { if (!controller.signal.aborted) setState(previous => ({ ...previous, loading: false, error: error.name === 'TimeoutError' ? 'Loading took too long. Please retry.' : error.message })) }
    }
    load()
    return () => controller.abort()
  }, [type, genre, page, retry])
  function filter(nextType, nextGenre) {
    setType(nextType); setGenre(nextGenre); setYear(''); setLanguage(''); setPage(1)
    setState({ loading: true, items: [], error: '', hasMore: false })
  }
  const languages = [...new Set(state.items.flatMap(item => item.languages || []))].sort()
  const visible = state.items.filter(item => (!year || Number(item.release_year) === Number(year)) && (!language || item.languages?.includes(language)) && (!collection.recent || item.release_year>=new Date().getFullYear()-1&&item.release_year<=new Date().getFullYear()&&(!item.release_date||new Date(item.release_date)<=new Date())))
  return <><span className="eyebrow">A DIFFERENT WORLD, EVERY TIME</span><h2 id="browse-collection-heading">{collection.recent?'Recent releases':'Discover your next escape'}<span className="accent-dot">.</span></h2>
    <div className="browse-filters"><div className="type-tabs" aria-label="Title type"><button aria-pressed={type === 'movie'} onClick={() => { if (type !== 'movie') filter('movie', genre) }}>Movies</button><button aria-pressed={type === 'series'} onClick={() => { if (type !== 'series') filter('series', genre) }}>Series</button></div><label className="genre-filter">Genre<select aria-label="Filter by genre" value={genre} onChange={event => filter(type, event.target.value)}><option value="">All genres</option>{genres.map(name => <option key={name}>{name}</option>)}</select></label><span className="browse-count" role="status">{state.loading && !state.items.length ? 'Finding stories…' : `${state.items.length} titles${genre ? ` · ${genre}` : ''}`}</span></div>
<div className="extra-filters"><label>Year<select aria-label="Filter loaded titles by year" value={year} onChange={e => setYear(e.target.value)}><option value="">All years</option>{Array.from({ length: 80 }, (_, i) => new Date().getFullYear() - i).map(value => <option key={value}>{value}</option>)}</select></label><label>Language<select aria-label="Filter loaded titles by language" disabled={!languages.length} value={language} onChange={e => setLanguage(e.target.value)}><option value="">{languages.length ? 'All languages' : 'Not supplied by source'}</option>{languages.map(value => <option key={value}>{value}</option>)}</select></label><span>Applies to loaded titles · {visible.length} matches</span></div>
    <div className="browse-grid" aria-busy={state.loading}>{visible.map(movie => renderCard(movie, onSelect))}{state.loading && !state.items.length && Array.from({ length: 6 }, (_, index) => <div className="catalogue-skeleton" key={`loading-${index}`} />)}</div>
    {!state.loading && state.items.length > 0 && visible.length === 0 && <p className="status-message">No matches in the loaded titles. Load more titles or change these filters.</p>}
    {state.error && <div className="browse-feedback" role="alert"><p>{state.error}</p><button className="panel-action" onClick={() => { setState(previous => ({ ...previous, loading: true, error: '' })); setRetry(value => value + 1) }}>Retry collection</button></div>}
    {!state.loading && !state.error && !state.items.length && <div className="browse-feedback"><h3>No titles here yet.</h3><p>Try another genre or switch between Movies and Series.</p><button className="panel-action" onClick={() => filter('movie', '')}>Reset filters</button></div>}
    {state.items.length > 0 && !state.error && <div className="load-more-area">{state.hasMore ? <button className="panel-action load-more" disabled={state.loading} onClick={() => { setState(previous => ({ ...previous, loading: true, error: '' })); setPage(value => value + 1) }}>{state.loading ? 'Loading more…' : 'Load more titles'}<span aria-hidden="true">↓</span></button> : <p className="status-message">You’ve reached the end of this collection.</p>}</div>}
  </>
}
