import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import Icon from '../components/Icon'
import { Art, Grid } from '../components/Rows'
import { Notice } from '../components/Shell'
import { useLibrary, titleSummary } from '../components/LibraryContext'
import { useInstant } from '../lib/instant'
import { getJSON, peekJSON, backdropUrl, logoUrl, runtimeLabel, ratingLabel, isSeries, watchPath, GENRES } from '../lib/api'

// The page is keyed by title ID, so this state always belongs to one title.
function useTitle(id, initial) {
  const path = '/api/movies/' + id
  const [state, setState] = useState(() => ({ data: peekJSON(path)?.data || (initial?.imdb_id === id ? initial : null), done: !!peekJSON(path), error: '', attempt: 0 }))
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    getJSON(path, { signal: controller.signal, timeout: 90000, fresh: retry > 0 })
      .then(body => { if (!controller.signal.aborted) setState({ data: body.data, done: true, error: '', attempt: retry }) })
      .catch(error => { if (!controller.signal.aborted) setState(s => ({ ...s, done: true, attempt: retry, error: error.name === 'TimeoutError' ? 'Loading this title is taking too long.' : 'Title details could not load.' })) })
    return () => controller.abort()
  }, [path, retry])
  const loading = !state.done || state.attempt !== retry
  return { data: state.data, loading, error: loading ? '' : state.error, retry: () => setRetry(n => n + 1) }
}

function MoreLikeThis({ item }) {
  const [state, setState] = useState({ loading: true, items: [] })
  const type = isSeries(item) ? 'series' : 'movie'
  const genre = (item.genres || []).find(g => GENRES.includes(g)) || ''
  useEffect(() => {
    const controller = new AbortController()
    getJSON(`/api/discover?type=${type}&limit=24${genre ? '&genre=' + encodeURIComponent(genre) : ''}`, { signal: controller.signal, timeout: 60000 })
      .then(body => setState({ loading: false, items: (body.data || []).filter(x => x.imdb_id !== item.imdb_id).slice(0, 12) }))
      .catch(() => setState({ loading: false, items: [] }))
    return () => controller.abort()
  }, [type, genre, item.imdb_id])
  if (!state.loading && !state.items.length) return <p className="muted">No similar titles to suggest right now.</p>
  return <Grid items={state.items} loading={state.loading} count={6} />
}

function Episodes({ data, progress }) {
  const seasons = useMemo(() => [...(data.seasons || [])].filter(s => s.season_number >= 1).sort((a, b) => a.season_number - b.season_number), [data.seasons])
  const latest = progress.filter(p => p.imdb_id === data.imdb_id && p.season > 0).sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0))[0]
  const [season, setSeason] = useState(latest?.season || seasons[0]?.season_number)
  const current = seasons.find(s => s.season_number === season) || seasons[0]
  if (!seasons.length) return <p className="muted">Episodes aren't available for this series yet. Try again later.</p>
  const episodes = [...(current.episodes || [])].sort((a, b) => a.episode_number - b.episode_number)
  const meta = new Map((data.episode_metadata || []).map(e => [`${e.season}:${e.episode}`, e]))
  return <div className="episodes">
    {seasons.length > 1 && <div className="chips season-chips" role="tablist" aria-label="Seasons">
      {seasons.map(s => <button key={s.season_number} role="tab" aria-selected={s.season_number === current.season_number} className="chip" onClick={() => setSeason(s.season_number)}>Season {s.season_number}</button>)}
    </div>}
    <ol className="episode-list">
      {episodes.map(ep => {
        const info = meta.get(`${current.season_number}:${ep.episode_number}`)
        const p = progress.find(x => x.imdb_id === data.imdb_id && x.season === current.season_number && x.episode === ep.episode_number)
        const title = info?.title || ep.title || `Episode ${ep.episode_number}`
        return <li key={ep.episode_number}>
          <Link to={watchPath(data, current.season_number, ep.episode_number)} className="episode">
            <span className="episode-art"><Art src={info?.thumbnail} alt="" fallback={`Episode ${ep.episode_number}`} />
              <span className="episode-play"><Icon name="play" size={16} /></span>
              {p?.duration > 0 && <span className="wide-progress"><span style={{ width: `${p.completed ? 100 : Math.min(100, (p.position / p.duration) * 100)}%` }} /></span>}
            </span>
            <span className="episode-text"><span className="episode-number">Episode {ep.episode_number}</span><span className="episode-title">{title}</span>{p?.completed && <span className="muted">Watched</span>}</span>
          </Link>
        </li>
      })}
    </ol>
  </div>
}

export default function TitleRoute() {
  const { id } = useParams()
  return <TitlePage key={id} id={id} />
}

function TitlePage({ id }) {
  const location = useLocation()
  const { data, loading, error, retry } = useTitle(id, location.state?.item)
  const library = useLibrary()
  const instant = useInstant()
  const [tab, setTab] = useState(null)
  const [logoOk, setLogoOk] = useState(true)

  if (!data) {
    if (loading) return <main id="main" className="title-page"><div className="title-hero skeleton-hero" aria-busy="true" /></main>
    return <main id="main" className="page"><Notice title="This title couldn't be found." action={<button className="button button--quiet" onClick={retry}>Try again</button>}>{error}</Notice></main>
  }
  const series = isSeries(data)
  const progress = library.library.progress
  const entries = progress.filter(p => p.imdb_id === data.imdb_id)
  const resume = entries.filter(p => !p.completed && p.position > 10).sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0))[0]
  const firstSeason = [...(data.seasons || [])].filter(s => s.season_number >= 1).sort((a, b) => a.season_number - b.season_number)[0]
  const firstEpisode = firstSeason && [...(firstSeason.episodes || [])].sort((a, b) => a.episode_number - b.episode_number)[0]
  const playTarget = resume ? watchPath(data, resume.season || undefined, resume.episode || undefined)
    : series && firstEpisode ? watchPath(data, firstSeason.season_number, firstEpisode.episode_number) : watchPath(data)
  const playLabel = resume ? (series && resume.season ? `Resume S${resume.season} E${resume.episode}` : 'Resume') : series ? (firstEpisode ? `Play S${firstSeason.season_number} E${firstEpisode.episode_number}` : 'Play') : 'Play'
  const saved = library.library.watchlist.some(x => x.imdb_id === data.imdb_id)
  const watched = entries.some(p => p.completed && !p.season)
  const seasonsCount = (data.seasons || []).filter(s => s.season_number >= 1).length
  const facts = [data.release_year, data.content_rating, series ? (seasonsCount ? `${seasonsCount} season${seasonsCount > 1 ? 's' : ''}` : 'Series') : runtimeLabel(data.runtime_minutes), (data.genres || []).slice(0, 3).join(', ')].filter(Boolean)
  const tabs = [...(series ? [['episodes', 'Episodes']] : []), ['more', 'More like this'], ['details', 'Details']]
  const active = tab || tabs[0][0]
  const cast = (data.cast || []).map(c => c.name).filter(Boolean)

  return <main id="main" className="title-page">
    <section className="title-hero">
      <div className="title-media" aria-hidden="true"><img src={backdropUrl(data)} alt="" fetchPriority="high" onError={e => { e.currentTarget.style.visibility = 'hidden' }} /></div>
      <div className="title-body">
        {logoOk ? <h1 className="title-logo"><img src={logoUrl(data)} alt={data.title} onError={() => setLogoOk(false)} /></h1> : <h1 className="hero-title">{data.title}</h1>}
        <p className="facts">{facts.map(f => <span key={f}>{f}</span>)}{ratingLabel(data.rating) && <span className="rating"><Icon name="star" size={13} />{ratingLabel(data.rating)}</span>}{instant.has(data.imdb_id) && <span className="instant-badge"><Icon name="bolt" size={12} />Instant</span>}</p>
        {data.plot ? <p className="title-plot">{data.plot}</p> : loading ? <span className="skeleton skeleton--text" /> : null}
        {cast.length > 0 && <p className="cast-line"><span className="muted">Starring</span> {cast.slice(0, 4).join(', ')}</p>}
        <div className="actions">
          <Link to={playTarget} className="button button--play" aria-disabled={series && loading && !firstEpisode}><Icon name="play" />{playLabel}</Link>
          <button className="button button--round" aria-pressed={saved} aria-label={saved ? 'Remove from My List' : 'Add to My List'} title={saved ? 'In My List' : 'Add to My List'} onClick={() => library.toggleWatchlist(data)}><Icon name={saved ? 'check' : 'plus'} /></button>
          {!series && <button className="button button--quiet" onClick={() => library.saveProgress({ data: titleSummary(data), season: 0, episode: 0, position: 0, duration: null, completed: !watched })}>{watched ? 'Mark as unwatched' : 'Mark as watched'}</button>}
        </div>
        {error && <p className="inline-error">{error} <button className="text-button" onClick={retry}>Try again</button></p>}
      </div>
    </section>
    <section className="title-tabs">
      <div className="tabs" role="tablist" aria-label="Title sections">
        {tabs.map(([key, label]) => <button key={key} role="tab" aria-selected={active === key} onClick={() => setTab(key)}>{label}</button>)}
      </div>
      <div role="tabpanel" className="tab-panel">
        {active === 'episodes' && (loading && !firstEpisode ? <div className="episode-list">{Array.from({ length: 4 }, (_, i) => <span key={i} className="skeleton skeleton--episode" />)}</div> : <Episodes data={data} progress={progress} />)}
        {active === 'more' && <MoreLikeThis item={data} />}
        {active === 'details' && <dl className="details">
          {data.genres?.length > 0 && <><dt>Genres</dt><dd>{data.genres.join(', ')}</dd></>}
          {cast.length > 0 && <><dt>Cast</dt><dd>{cast.join(', ')}</dd></>}
          {data.release_date && <><dt>Released</dt><dd>{new Date(data.release_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</dd></>}
          {data.country?.length > 0 && <><dt>Country</dt><dd>{data.country.join(', ')}</dd></>}
          {ratingLabel(data.rating) && <><dt>IMDb rating</dt><dd>{ratingLabel(data.rating)} / 10</dd></>}
          {data.runtime_minutes > 0 && <><dt>{series ? 'Episode length' : 'Runtime'}</dt><dd>{runtimeLabel(data.runtime_minutes)}</dd></>}
        </dl>}
      </div>
    </section>
  </main>
}
