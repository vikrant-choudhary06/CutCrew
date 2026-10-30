import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import BrowseCollection from './BrowseCollection'
import { useLibrary, titleSummary } from './LibraryContext'
import SeriesPlayer from './SeriesPlayer'
import RelatedTitles from './RelatedTitles'

const base = (import.meta.env.VITE_BACKEND_URL || '').replace(/\/$/, '')
const genres = [
  ['Action', '01', '#ba7551'], ['Sci-Fi', '02', '#678cb2'], ['Thriller', '03', '#a56066'],
  ['Drama', '04', '#a28a6d'], ['Animation', '05', '#8b79a8'], ['Comedy', '06', '#9a9b66'],
]
const isSeries = item => /series|episode/i.test(item.title_type || '')
async function getTitles(path, signal) {
  const response = await fetch(base + path, { signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]) })
  if (!response.ok) throw new Error('The catalogue is unavailable right now. Please retry.')
  const body = await response.json()
  return body.data || []
}
function Cover({ movie }) {
  const [failed, setFailed] = useState(false),[loaded,setLoaded]=useState(false)
  return <span className={`catalogue-cover ${movie.poster_url&&!loaded&&!failed?'poster-loading':''}`}>{movie.poster_url && !failed ? <img src={movie.poster_url} alt="" loading="lazy" className={loaded?'poster-ready':'poster-pending'} onLoad={()=>setLoaded(true)} onError={() => setFailed(true)} /> : <span className="cover-placeholder">{movie.title}</span>}<span className="cover-open" aria-hidden="true">↗</span>{movie.rating > 0 && <span className="cover-rating">★ {Number(movie.rating).toFixed(1)}</span>}</span>
}
function Card({ movie, onSelect }) {
  const library=useLibrary(),saved=library.library.watchlist.some(item=>item.imdb_id===movie.imdb_id)
  return <article className="catalogue-card"><button className="card-details" onClick={()=>onSelect(movie)} aria-label={`View ${movie.title}`}><Cover movie={movie}/><span className="catalogue-title">{movie.title}</span><span className="catalogue-meta">{movie.release_year||'Year unavailable'}<i/>{isSeries(movie)?'Series':'Movie'}</span></button><div className="card-quick-actions"><button aria-label={`Play ${movie.title}`} onClick={()=>onSelect({...movie,autoplay:true})}>▶ <span>Play</span></button><button aria-label={`${saved?'Remove':'Save'} ${movie.title}${saved?' from':' to'} watchlist`} aria-pressed={saved} onClick={()=>library.toggleWatchlist(movie)}>{saved?'✓':'+'}</button></div></article>
}
function MovieRow({ name, subtitle, path, onSelect, onViewAll, recent=false, excluded='' }) {
  const [state, setState] = useState({ loading: true, items: [], error: '' })
  const [retry, setRetry] = useState(0)
  const rail = useRef(null)
  useEffect(() => {
    const controller = new AbortController()
    getTitles(path, controller.signal).then(items => { const hidden=new Set(excluded.split(','));items=items.filter(item=>!hidden.has(item.imdb_id));if(recent){const year=new Date().getFullYear();items=items.filter(item=>item.release_year>=year-1&&item.release_year<=year&&(!item.release_date||new Date(item.release_date)<=new Date())).sort((a,b)=>Number(b.release_year)-Number(a.release_year))}if (!controller.signal.aborted) setState({ items:items.slice(0,12), loading: false, error: '' }) })
      .catch(err => { if (!controller.signal.aborted) setState({ items: [], loading: false, error: err.message }) })
    return () => controller.abort()
  }, [path, retry, recent, excluded])
  function scroll(direction) { rail.current?.scrollBy({ left: direction * rail.current.clientWidth * .8, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }) }
  return <section className="catalogue-section" aria-label={name}>
    <header className="catalogue-heading"><div><span className="eyebrow">{subtitle}</span><h2>{name}<span>.</span></h2></div><div className="catalogue-controls"><button className="view-all" onClick={onViewAll}>View all <span>↗</span></button><button aria-label={`Scroll ${name} left`} onClick={() => scroll(-1)} disabled={!state.items.length}>‹</button><button aria-label={`Scroll ${name} right`} onClick={() => scroll(1)} disabled={!state.items.length}>›</button></div></header>
    {state.loading && <div className="catalogue-rail" aria-label={`Loading ${name}`} role="status">{Array.from({ length: 6 }, (_, index) => <div className="catalogue-skeleton" key={index} />)}</div>}
    {!state.loading && state.error && <div className="catalogue-empty" role="alert"><p>{state.error}</p><button className="panel-action" onClick={() => { setState({ loading: true, items: [], error: '' }); setRetry(value => value + 1) }}>Retry</button></div>}
    {!state.loading && !state.error && !state.items.length && <div className="catalogue-empty"><p>No {name === 'Popular Series' ? 'series' : 'movies'} in the catalogue yet.</p><span>New titles will appear here as they are added.</span></div>}
    {!state.loading && state.items.length > 0 && <div ref={rail} className="catalogue-rail">{state.items.map(movie => <Card key={movie.imdb_id} movie={movie} onSelect={onSelect} />)}</div>}
  </section>
}
function PersonalPicks({progress,onSelect,onViewAll}){
 const watched=progress.filter(item=>item.completed||item.position>=60),seed=watched[0]?.data,seedId=seed?.imdb_id
 const [recommendation,setRecommendation]=useState(null)
 useEffect(()=>{if(watched.length<2||!seedId)return;const controller=new AbortController();fetch(base+'/api/movies/'+seedId,{signal:controller.signal}).then(r=>r.ok?r.json():null).then(body=>{const genre=body?.data?.genres?.find(g=>['Action','Adventure','Animation','Comedy','Crime','Documentary','Drama','Family','Fantasy','History','Horror','Music','Mystery','Romance','Sci-Fi','Thriller','War','Western'].includes(g));if(genre&&!controller.signal.aborted)setRecommendation({id:seedId,genre})}).catch(()=>{});return()=>controller.abort()},[seedId,watched.length])
 if(!seed||watched.length<2||recommendation?.id!==seed.imdb_id)return null
 return <MovieRow name={`Because you watched ${seed.title}`} subtitle="MORE OF WHAT YOU ENJOY" path={'/api/discover?type='+ (isSeries(seed)?'series':'movie')+'&limit=12&genre='+encodeURIComponent(recommendation.genre)} excluded={watched.map(item=>item.imdb_id).join(',')} onSelect={onSelect} onViewAll={()=>onViewAll({title:'More like '+seed.title,kind:isSeries(seed)?'series':'movie',genre:recommendation.genre})}/>
}
function TitleDetails({ movie, onPlaying, onSelect }) {
  const library = useLibrary()
  const [data, setData] = useState(movie)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [season, setSeason] = useState(movie.resume?.season || null)
  const [episode, setEpisode] = useState(movie.resume?.episode || null)
  const [playing, setPlaying] = useState(!!movie.autoplay)
  useEffect(() => {
    const controller = new AbortController()
    fetch(`${base}/api/movies/${movie.imdb_id}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]) }).then(async response => {
      if (!response.ok) throw new Error('Could not load the title details. Please retry.')
      const result = await response.json()
      if (!controller.signal.aborted) setData(result.data)
    }).catch(err => { if (!controller.signal.aborted) setError(err.name === 'TimeoutError' ? 'Loading this title took too long. Please retry.' : err.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [movie.imdb_id, retry])
  const series = isSeries(data)
  const seasons = [...(data.seasons || [])].filter(item => item.season_number >= 1).sort((a,b) => a.season_number - b.season_number)
  const currentSeason = seasons.find(item => item.season_number === season) || seasons[0]
  const episodes = [...(currentSeason?.episodes || [])].sort((a,b) => a.episode_number - b.episode_number)
  const currentEpisode = episodes.find(item => item.episode_number === episode) || episodes[0]
  const saved = library.library.watchlist.some(item => item.imdb_id === data.imdb_id)
  const entry = library.library.progress.find(item => item.imdb_id === data.imdb_id && (item.season || 0) === (series ? currentSeason?.season_number || 0 : 0) && (item.episode || 0) === (series ? currentEpisode?.episode_number || 0 : 0))
  const episodeInfo = data.episode_metadata?.find(item => item.season === currentSeason?.season_number && item.episode === currentEpisode?.episode_number)
  const playable = !loading && !error && (!series || currentEpisode)
  if (playing && playable) return <SeriesPlayer data={data} season={series ? currentSeason?.season_number : undefined} episode={series ? currentEpisode?.episode_number : undefined} onBack={() => { setPlaying(false); onPlaying(false) }} onEpisodeChange={next => { setSeason(next.season); setEpisode(next.episode) }} />
  return <><span className="eyebrow">YOUR NEXT ESCAPE</span><h2 id="browse-heading">{data.title}</h2><div className="title-details-layout"><Cover movie={data} /><div><p className="panel-meta">{data.release_year} · {data.title_type}{data.runtime_minutes ? ` · ${data.runtime_minutes} min` : ''}</p><p className="title-genres">{(data.genres || []).join(' · ')}</p><p className="title-plot">{data.plot || (loading ? 'Loading movie details…' : 'No synopsis is available for this title.')}</p>{data.rating > 0 && <p className="title-rating">★ {Number(data.rating).toFixed(1)} <span>/ 10</span></p>}
    {loading && <p className="status-message" role="status">Loading details{series ? ' and episodes' : ''}…</p>}{error && <div role="alert"><p>{error}</p><button className="panel-action" onClick={() => { setError(''); setLoading(true); setRetry(value => value + 1) }}>Retry details</button></div>}
    {series && !loading && !error && <div className="episode-picker">{seasons.length > 0 ? <><label>Season<select aria-label="Choose season" value={currentSeason?.season_number} onChange={event => { setSeason(Number(event.target.value)); setEpisode(null) }}>{seasons.map(item => <option key={item.season_number} value={item.season_number}>Season {item.season_number}</option>)}</select></label><label>Episode<select aria-label="Choose episode" value={currentEpisode?.episode_number || ''} onChange={event => setEpisode(Number(event.target.value))}>{!episodes.length && <option value="">No episodes</option>}{episodes.map(item => <option key={item.episode_number} value={item.episode_number}>{item.episode_number}. {item.title || `Episode ${item.episode_number}`}</option>)}</select></label></> : <p className="status-message">No episodes were found from the available providers. Please try again later.</p>}</div>}
    {series && episodeInfo && <div className="episode-preview">{episodeInfo.thumbnail && <img src={episodeInfo.thumbnail} alt="" loading="lazy" />}<span>{episodeInfo.title || currentEpisode?.title}</span></div>}
    <button className="explore-button title-play" disabled={!playable} onClick={() => { setPlaying(true); onPlaying(true) }}>{entry?.position > 10 && !entry.completed ? 'Resume' : 'Play'} {series ? 'episode' : 'film'} <span>▶</span></button>
    <div className="title-library-actions"><button className="panel-action" onClick={() => library.toggleWatchlist(data)}>{saved ? 'Remove from watchlist' : 'Add to watchlist'}</button><button className="panel-action" disabled={loading} onClick={() => library.saveProgress({ data: titleSummary(data), season: series ? currentSeason?.season_number || 0 : 0, episode: series ? currentEpisode?.episode_number || 0 : 0, position: entry?.position || 0, duration: entry?.duration || null, completed: !entry?.completed })}>{entry?.completed ? 'Mark unwatched' : 'Mark watched'}</button></div>
  </div></div><RelatedTitles movie={data} onSelect={onSelect} /></>
}
export default function Catalogue({ ref }) {
  const library = useLibrary()
  const seen = new Set()
  const continuing = library.library.progress.filter(item => !item.completed && item.position >= 10).filter(item => { if (seen.has(item.imdb_id)) return false; seen.add(item.imdb_id); return true }).slice(0,12)
  const [selection, setSelection] = useState(null)
  const [wide, setWide] = useState(false)
  const dialog = useRef(null)
  const close = useRef(null)
  const collectionScroll = useRef(0)
  useEffect(() => {
    if (!selection) return
    const previous = document.activeElement
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    close.current?.focus()
    if (dialog.current) dialog.current.scrollTop = selection.movie ? 0 : collectionScroll.current
    const onKey = event => {
      if (event.key === 'Escape' && !document.fullscreenElement) setSelection(null)
      if (event.key !== 'Tab') return
      const nodes = [...dialog.current.querySelectorAll('button, select, a, input, video')].filter(node => !node.disabled && node.getClientRects().length > 0)
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus() }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', onKey); previous?.focus() }
  }, [selection])
  function open(value) { if (!value.movie) collectionScroll.current = 0; setWide(false); setSelection(value) }
  const choose = movie => { collectionScroll.current = dialog.current?.scrollTop || 0; open({ collection: selection?.collection, movie }) }
  useImperativeHandle(ref, () => ({ showTitle: movie => open({ movie }), showBrowse: (kind='movie') => open({ collection: { title: 'Discover', kind } }) }))
  return <>
    <div className="catalogue" id="discover"><div className="discover-intro"><span className="eyebrow">THE STORY DOESN’T END HERE</span><button className="browse-all-button" onClick={() => open({ collection: { title: 'Discover', kind: 'movie' } })}>Browse all titles <span>↗</span></button></div>
      {continuing.length > 0 && <section className="catalogue-section" aria-label="Continue Watching"><header className="catalogue-heading"><div><span className="eyebrow">RIGHT WHERE YOU LEFT OFF</span><h2>Continue Watching<span>.</span></h2></div></header><div className="catalogue-rail">{continuing.map(item => <div className="continue-card" key={item.imdb_id}><Card movie={item.data} onSelect={movie => choose({ ...movie, resume: { season: item.season, episode: item.episode } })} />{item.duration > 0 && <progress max={item.duration} value={item.position} />}<span className="status-message">{Math.floor(item.position / 60)} min{item.season > 0 ? ' · S' + item.season + ' E' + item.episode : ''}</span><button className="remove-saved" aria-label={'Remove '+item.data.title+' from Continue Watching'} onClick={() => library.removeProgress(item.imdb_id)}>Remove</button></div>)}</div></section>}
      <MovieRow name="Trending Movies" subtitle="THE FILMS MAKING AN IMPRESSION" path="/api/movies/trending" onSelect={choose} onViewAll={() => open({ collection: { title: 'All movies', kind: 'movie', path: '/api/movies?limit=40' } })} />
      <MovieRow name="Recent releases" subtitle="SOMETHING NEW FOR TONIGHT" recent path="/api/discover?type=movie&limit=24" onSelect={choose} onViewAll={()=>open({collection:{title:'Recent releases',kind:'movie',recent:true}})}/>
      <MovieRow name="Popular Series" subtitle="ONE MORE EPISODE. ALWAYS." path="/api/series/trending" onSelect={choose} onViewAll={() => open({ collection: { title: 'All series', kind: 'series', path: '/api/movies?limit=40' } })} />
      <PersonalPicks progress={library.library.progress} onSelect={choose} onViewAll={collection=>open({collection})}/>
      <section className="catalogue-section" aria-label="Browse by Genre"><header className="catalogue-heading"><div><span className="eyebrow">FOLLOW YOUR MOOD</span><h2>Browse by Genre<span>.</span></h2></div><span className="genre-note">A different world for every mood.</span></header><div className="genre-rail">{genres.map(([name,number,color]) => <button key={name} className="genre-card" style={{ '--genre-color': color }} onClick={() => open({ collection: { title: name, genre: name, path: `/api/movies?genre=${encodeURIComponent(name)}&limit=40` } })}><span className="genre-number">{number} / COLLECTION</span><span className="genre-orbit" aria-hidden="true" /><span className="genre-name">{name}<span>↗</span></span></button>)}</div></section>
      <footer className="catalogue-footer"><span>CUTCREW</span><p>For the love of a good story.</p><a href="#top">Back to top ↑</a></footer>
    </div>
    {selection && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) setSelection(null) }}><section ref={dialog} className={`panel catalogue-panel ${wide ? 'panel--player' : ''}`} role="dialog" aria-modal="true" aria-labelledby={wide ? 'panel-heading' : selection.movie ? 'browse-heading' : 'browse-collection-heading'}><button ref={close} className="close-panel" aria-label="Close catalogue panel" onClick={() => setSelection(null)}>×</button>{selection.collection && <div hidden={!!selection.movie}><BrowseCollection key={`${selection.collection.kind}:${selection.collection.genre || ''}`} collection={selection.collection} onSelect={choose} renderCard={(movie, select) => <Card key={movie.imdb_id} movie={movie} onSelect={select} />} /></div>}{selection.movie && <>{selection.collection && <button className="back-to-details" onClick={() => { setWide(false); setSelection({ collection: selection.collection }) }}>← Back to collection</button>}<TitleDetails key={selection.movie.imdb_id} movie={selection.movie} onPlaying={setWide} onSelect={choose} /></>}</section></div>}
  </>
}
