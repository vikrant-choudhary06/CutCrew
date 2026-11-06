import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Grid, Row } from '../components/Rows'
import { Notice } from '../components/Shell'
import { getJSON, ANIME_GENRES } from '../lib/api'

// Lists the anime API serves, with the heading each one gets.
const LISTS = {
  trending: 'Trending now',
  season: 'New this season',
  airing: 'Airing now',
  popular: 'Most popular',
  top: 'Top rated',
  movies: 'Anime movies',
}
const GENRE_ROWS = ['Action', 'Romance', 'Comedy', 'Fantasy', 'Slice of Life', 'Sports']

// Grid of one list (and genre), loaded a page at a time.
function AnimeGrid({ kind, genre }) {
  const filterKey = `${kind}|${genre}`
  const [view, setView] = useState({ filterKey, pages: 1, items: [], loaded: 0, error: '', hasMore: false, retry: 0 })
  if (view.filterKey !== filterKey) setView({ filterKey, pages: 1, items: [], loaded: 0, error: '', hasMore: false, retry: 0 })
  const page = view.filterKey === filterKey ? view.pages : 1
  const loading = view.loaded < page && !view.error

  useEffect(() => {
    if (view.loaded >= page) return
    const controller = new AbortController()
    const q = new URLSearchParams({ kind, page: String(page), limit: '24' })
    if (genre) q.set('genre', genre)
    getJSON('/api/anime/browse?' + q, { signal: controller.signal, timeout: 60000 }).then(body => {
      setView(v => {
        if (v.filterKey !== filterKey) return v
        const seen = new Set(v.items.map(x => x.imdb_id))
        return { ...v, items: [...v.items, ...(body.data || []).filter(x => !seen.has(x.imdb_id))], loaded: page, error: '', hasMore: !!body.hasMore && page < 20 }
      })
    }).catch(error => { if (!controller.signal.aborted) setView(v => (v.filterKey === filterKey ? { ...v, error: error.name === 'TimeoutError' ? 'Loading took too long.' : 'Anime could not load.' } : v)) })
    return () => controller.abort()
  }, [filterKey, page, view.retry]) // eslint-disable-line react-hooks/exhaustive-deps

  const retry = () => setView(v => ({ ...v, error: '', retry: v.retry + 1 }))
  if (view.error && !view.items.length) return <Notice title={view.error} action={<button className="button button--quiet" onClick={retry}>Try again</button>}>Check your connection, then try again.</Notice>
  if (!loading && !view.items.length) return <Notice title="No anime found.">Try another genre.</Notice>
  return <>
    <Grid items={view.items} loading={loading} />
    {view.items.length > 0 && <div className="load-more">
      {view.error ? <button className="button button--quiet" onClick={retry}>Couldn't load more. Try again</button>
        : view.hasMore ? <button className="button button--quiet" disabled={loading} onClick={() => setView(v => ({ ...v, pages: v.pages + 1 }))}>{loading ? 'Loading…' : 'Load more'}</button>
          : !loading && <p className="muted">That's everything in this list.</p>}
    </div>}
  </>
}

export default function AnimePage() {
  const [params, setParams] = useSearchParams()
  const kind = LISTS[params.get('list')] ? params.get('list') : ''
  const genre = ANIME_GENRES.includes(params.get('genre')) ? params.get('genre') : ''
  const browsing = kind || genre
  const pick = g => setParams(g ? { genre: g } : {}, { replace: true })

  if (browsing) {
    const listKind = kind || 'popular'
    const heading = genre ? `${genre} anime` : LISTS[listKind]
    return <main id="main" className="page browse">
      <h1 className="page-title">{heading}</h1>
      <div className="chips browse-chips" role="group" aria-label="Filter by genre">
        <button className="chip" aria-pressed={!genre} onClick={() => pick('')}>All anime</button>
        {ANIME_GENRES.map(g => <button key={g} className="chip" aria-pressed={genre === g} onClick={() => pick(g)}>{g}</button>)}
      </div>
      <AnimeGrid kind={listKind} genre={genre} />
    </main>
  }

  return <main id="main" className="anime-home">
    <header className="anime-head">
      <h1 className="page-title">Anime</h1>
      <p className="muted">Japanese audio with subtitles. Titles and episode guides come from AniList.</p>
    </header>
    <div className="chips anime-genres" role="group" aria-label="Browse anime by genre">
      {ANIME_GENRES.map(g => <button key={g} className="chip" onClick={() => pick(g)}>{g}</button>)}
    </div>
    <div className="rows">
      {Object.entries(LISTS).map(([key, title], i) => <Row key={key} title={title} path={`/api/anime/browse?kind=${key}`} kind={key === 'trending' ? 'top' : 'poster'} limit={key === 'trending' ? 10 : 18} eager={i < 2} more={`/anime?list=${key}`} />)}
      {GENRE_ROWS.map(g => <Row key={g} title={`${g} anime`} path={`/api/anime/browse?kind=popular&genre=${encodeURIComponent(g)}`} more={`/anime?genre=${encodeURIComponent(g)}`} />)}
    </div>
  </main>
}
