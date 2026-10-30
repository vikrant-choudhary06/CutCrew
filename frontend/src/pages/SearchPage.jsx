import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import Icon from '../components/Icon'
import { Grid, Row } from '../components/Rows'
import { getJSON, GENRES } from '../lib/api'

const RECENT_KEY = 'cutcrew-recent-searches'
const readRecent = () => { try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, 8) : [] } catch { return [] } }
const saveRecent = list => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8))) } catch { /* fine */ } }

export default function SearchPage() {
  const [params, setParams] = useSearchParams()
  const [text, setText] = useState(params.get('q') || '')
  const [result, setResult] = useState({ key: '', items: [], error: '' })
  const [retry, setRetry] = useState(0)
  const [recent, setRecent] = useState(readRecent)
  const input = useRef(null)
  const query = (params.get('q') || '').trim()

  useEffect(() => { input.current?.focus() }, [])
  // Update the URL shortly after typing stops, so results can be shared and Back works.
  useEffect(() => {
    const t = setTimeout(() => { if (text.trim() !== query) setParams(text.trim() ? { q: text.trim() } : {}, { replace: true }) }, 300)
    return () => clearTimeout(t)
  }, [text]) // eslint-disable-line react-hooks/exhaustive-deps
  const key = query ? `${query}#${retry}` : ''
  useEffect(() => {
    if (!key) return
    const controller = new AbortController()
    getJSON('/api/movies/search?query=' + encodeURIComponent(query), { signal: controller.signal, timeout: 30000, fresh: retry > 0 })
      .then(body => {
        const items = (body.data || []).filter(x => x.imdb_id)
        setResult({ key, items, error: '' })
        if (items.length) { const next = [query, ...readRecent().filter(x => x.toLowerCase() !== query.toLowerCase())]; saveRecent(next); setRecent(next.slice(0, 8)) }
      })
      .catch(error => { if (!controller.signal.aborted) setResult({ key, items: [], error: error.name === 'TimeoutError' ? 'Search took too long. Try again.' : 'Search is unavailable right now. Try again in a moment.' }) })
    return () => controller.abort()
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const state = result.key === key ? { ...result, loading: false } : { items: [], error: '', loading: !!key }

  const use = value => { setText(value); setParams({ q: value }, { replace: true }) }
  return <main id="main" className="page search-page">
    <h1 className="sr-only">Search</h1>
    <form className="search-field" role="search" onSubmit={e => { e.preventDefault(); use(text.trim()) }}>
      <Icon name="search" size={22} />
      <input ref={input} type="search" value={text} onChange={e => setText(e.target.value)} placeholder="Search movies and series" aria-label="Search movies and series" enterKeyHint="search" autoComplete="off" />
      {text && <button type="button" className="icon-button" aria-label="Clear search" onClick={() => { setText(''); setParams({}, { replace: true }); input.current?.focus() }}><Icon name="close" /></button>}
    </form>

    {!query && <>
      {recent.length > 0 && <section className="search-section" aria-label="Recent searches">
        <div className="row-head"><h2>Recent searches</h2><button className="text-button" onClick={() => { saveRecent([]); setRecent([]) }}>Clear</button></div>
        <div className="chips">{recent.map(r => <button key={r} className="chip" onClick={() => use(r)}>{r}</button>)}</div>
      </section>}
      <section className="search-section" aria-label="Browse by genre">
        <div className="row-head"><h2>Browse by genre</h2></div>
        <div className="chips">{GENRES.map(g => <Link key={g} className="chip" to={`/movies?genre=${encodeURIComponent(g)}`}>{g}</Link>)}</div>
      </section>
      <Row title="Popular right now" path="/api/movies/trending" eager />
    </>}

    {query && <section aria-live="polite" aria-busy={state.loading}>
      {state.error ? <p className="inline-error">{state.error} <button className="text-button" onClick={() => setRetry(n => n + 1)}>Try again</button></p>
        : !state.loading && !state.items.length ? <div className="notice"><h2>No results for “{query}”.</h2><p>Check the spelling, try a shorter title, or browse a genre.</p></div>
          : <><p className="muted result-count">{state.loading ? 'Searching…' : `${state.items.length} result${state.items.length === 1 ? '' : 's'} for “${query}”`}</p><Grid items={state.items} loading={state.loading} count={6} /></>}
    </section>}
  </main>
}
