import { useEffect, useRef, useState } from 'react'
import PlaybackPanel from './components/LazyPlaybackPanel'
import Catalogue from './components/Catalogue'
import { useLibrary } from './components/LibraryContext'
import LibraryPanel from './components/LibraryPanel'
import AccountPanel from './components/AccountPanel'
import {orderFeatured,toFeatured} from './components/featuredSelection'

const fallbackFilms = [
  { key: 'dune', id: 'tt15239678', title: 'Dune: Part Two', short: 'Dune: Part Two', year: '2024', genre: 'Adventure · Sci-fi', runtime: '2h 47m', rating: 'PG-13', accent: '#e6b583', description: 'Paul Atreides unites with Chani and the Fremen on a path of revenge, facing a choice between the love of his life and the fate of the universe.' },
  { key: 'spiderverse', id: 'tt9362722', title: 'Spider-Man: Across the Spider-Verse', short: 'Across the Spider-Verse', year: '2023', genre: 'Animation · Adventure', runtime: '2h 20m', rating: 'PG', accent: '#e779a8', description: 'Miles Morales travels across the multiverse, where a team of Spider-People challenges what it means to be a hero.' },
  { key: 'batman', id: 'tt1877830', title: 'The Batman', short: 'The Batman', year: '2022', genre: 'Crime · Mystery', runtime: '2h 57m', rating: 'PG-13', accent: '#e56b58', description: 'A trail of cryptic clues leads Batman into the shadows of Gotham, where he must confront corruption and bring justice to the city.' },
  { key: 'interstellar', id: 'tt0816692', title: 'Interstellar', short: 'Interstellar', year: '2014', genre: 'Adventure · Sci-fi', runtime: '2h 49m', rating: 'PG-13', accent: '#a4c4db', description: 'A team of explorers travels beyond this galaxy to discover whether mankind has a future among the stars.' },
  { key: 'johnwick', id: 'tt10366206', title: 'John Wick: Chapter 4', short: 'John Wick: Chapter 4', year: '2023', genre: 'Action · Thriller', runtime: '2h 50m', rating: 'R', accent: '#a8b8ec', description: 'John Wick takes his fight against the High Table global as old friends become enemies and a new adversary emerges.' },
]
const art = (film, type) => film[type] || `/artwork/${film.key}-${type}.jpg`
const base = (import.meta.env.VITE_BACKEND_URL || '').replace(/\/$/, '')
function preloadArtwork(url, landscape, signal) {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(false); return }
    const image = new Image()
    const finish = ok => { clearTimeout(timer); image.onload=null; image.onerror=null; signal.removeEventListener('abort',abort); resolve(ok) }
    const abort = () => { finish(false); image.src='' }
    const timer = setTimeout(abort, 5000)
    image.onload = () => finish(landscape ? image.naturalWidth>=900 && image.naturalWidth/image.naturalHeight>=1.35 : image.naturalWidth>=100 && image.naturalHeight>image.naturalWidth)
    image.onerror = () => finish(false)
    signal.addEventListener('abort',abort,{once:true}); image.src=url
  })
}
function Icon({ name, ...props }) {
  const paths = {
    home: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    bookmark: <path d="M6 3h12v18l-6-4-6 4Z" />,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v1" /></>,
    arrow: <path d="m9 5 7 7-7 7" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    account: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>,
    grid: <><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="15" y="3" width="6" height="6" rx="1" /><rect x="3" y="15" width="6" height="6" rx="1" /><rect x="15" y="15" width="6" height="6" rx="1" /></>,
  }
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>
}

export default function App() {
  const library = useLibrary()
  const [films,setFilms]=useState(fallbackFilms)
  const heroInteracted=useRef(false)
  const [selected, setSelected] = useState(0)
  const [clock, setClock] = useState(new Date())
  const [panel, setPanel] = useState(() => library.accountAction ? 'account' : null)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState(null)
  const [detailsBusy, setDetailsBusy] = useState(false)
  const closeRef = useRef(null)
  const railRef = useRef(null)
  const catalogueRef = useRef(null)
  const previousFocus = useRef(null)
  const film = films[selected]
  useEffect(()=>{
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(25000)])
    async function loadFeatured(){
      try{
        const response=await fetch(base+'/api/featured',{signal})
        if(!response.ok)return
        const body=await response.json()
        if(!Array.isArray(body.data)||heroInteracted.current)return
        let previous=[]
        try{const value=JSON.parse(localStorage.getItem('cutcrew-featured-last')||'[]');if(Array.isArray(value))previous=value.filter(id=>typeof id==='string').slice(0,5)}catch{/* Private browsing can disable storage. */}
        const ordered=orderFeatured(body.data,previous),chosen=[]
        for(let i=0;i<ordered.length&&chosen.length<5&&!signal.aborted&&!heroInteracted.current;i+=5){
          const batch=await Promise.all(ordered.slice(i,i+5).map(async item=>{
            const loaded=await Promise.all([preloadArtwork(item.backdrop_url,true,signal),preloadArtwork(item.poster_url,false,signal)])
            return loaded.every(Boolean)?item:null
          }))
          chosen.push(...batch.filter(Boolean))
        }
        if(signal.aborted||heroInteracted.current||!chosen.length)return
        const next=chosen.slice(0,5).map(toFeatured)
        for(const fallback of fallbackFilms)if(next.length<5&&!next.some(item=>item.id===fallback.id))next.push(fallback)
        setFilms(next);setSelected(0)
        try{localStorage.setItem('cutcrew-featured-last',JSON.stringify(next.map(item=>item.id)))}catch{/* Rotation still works without persistence. */}
      }catch{/* Keep the local spotlight when metadata or artwork is unavailable. */}
    }
    loadFeatured();return()=>controller.abort()
  },[])
  useEffect(() => {
    const rail = railRef.current
    const card = rail?.children[selected]
    if (rail && card) rail.scrollTo({ left: Math.max(0, card.offsetLeft - rail.offsetLeft - 5), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }, [selected])
  useEffect(() => { const timer = setInterval(() => setClock(new Date()), 30000); return () => clearInterval(timer) }, [])
  useEffect(() => {
    if (!panel) return
    previousFocus.current = document.activeElement
    closeRef.current?.focus()
    const onKey = event => {
      if (event.key === 'Escape' && !document.fullscreenElement) setPanel(null)
      if (event.key === 'Tab') {
        const nodes = [...document.querySelectorAll('[role="dialog"] button, [role="dialog"] input, [role="dialog"] a, [role="dialog"] select, [role="dialog"] video')].filter(node => !node.disabled && node.getClientRects().length > 0)
        const first = nodes[0], last = nodes.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); previousFocus.current?.focus() }
  }, [panel])
  useEffect(() => {
    if (panel !== 'search' || !query.trim()) return
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setBusy(true); setError('')
      try {
        const response = await fetch(`${base}/api/movies/search?query=${encodeURIComponent(query.trim())}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) })
        if (!response.ok) throw new Error('Search is unavailable right now. Please try again.')
        const data = await response.json(); setResults(data.data || [])
      } catch (err) { if (err.name !== 'AbortError') setError(err.message) }
      finally { if (!controller.signal.aborted) setBusy(false) }
    }, 350)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, panel])
  useEffect(() => {
    if (panel !== 'details') return
    const controller = new AbortController()
    fetch(`${base}/api/movies/${film.id}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) }).then(async response => {
      if (!response.ok) throw new Error('Live details are unavailable. Showing the featured film information.')
      const body = await response.json(); setDetail(body.data)
    }).catch(err => { if (err.name !== 'AbortError') setError(err.message) }).finally(() => { if (!controller.signal.aborted) setDetailsBusy(false) })
    return () => controller.abort()
  }, [panel, film.id])
  function openPanel(value) { heroInteracted.current=true; setError(''); setPanel(value); if (value === 'details') { setDetail(null); setDetailsBusy(true) } }
  function goHome() {
    setPanel(null); setSelected(0)
    window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }
  function move(direction) { heroInteracted.current=true; setSelected(current => (current + direction + films.length) % films.length) }
  function toggleSaved() { library.toggleWatchlist({ ...film, imdb_id: film.id, poster_url: art(film, 'poster') }) }
  function playFeatured(){
    heroInteracted.current=true
    if(/series/i.test(film.title_type||'')){setPanel(null);catalogueRef.current?.showTitle({...film,imdb_id:film.id,poster_url:art(film,'poster'),release_year:film.year,autoplay:true})}
    else openPanel('play')
  }
  const isSaved = library.library.watchlist.some(item => item.imdb_id === film.id)
  return <main id="top" className="app-shell" style={{ '--accent': film.accent }}>
    <section className="cinema" aria-label="Featured films">
      <div className="backdrops" aria-hidden="true">{films.map((item, index) => <img key={item.id} className={`backdrop ${selected === index ? 'visible' : ''}`} src={art(item, 'backdrop')} alt="" fetchPriority={index === 0 ? 'high' : 'auto'} />)}</div>
      <div className="cinema-shade" />
      <header className="topbar">
        <a className="brand" href="/" aria-label="CutCrew home"><span className="brand-symbol">c<span>c</span></span><span>CUT<span>CREW</span><small>YOUR PRIVATE PICTURE HOUSE</small></span></a>
        <nav className="desktop-navigation" aria-label="Desktop navigation"><button onClick={goHome}>Home</button><button onClick={()=>catalogueRef.current?.showBrowse('movie')}>Movies</button><button onClick={()=>catalogueRef.current?.showBrowse('series')}>Series</button><button onClick={()=>openPanel('watchlist')}>My list</button></nav><div className="topbar-right"><button className="header-search" aria-label="Search catalogue" onClick={()=>openPanel('search')}><Icon name="search"/><span>Search</span></button><span className="live-label"><i /> ALL SET FOR MOVIE NIGHT</span><time>{clock.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</time><button className="avatar" aria-label="Account and profiles" onClick={() => openPanel('account')}>{library.auth ? (library.auth.profiles.find(p => p.id === library.profile)?.name || 'C').slice(0,1).toUpperCase() : 'C'}</button></div>
      </header>
      <div className="hero-bottom">
        <div className="collection-heading"><div><span className="eyebrow">{film.year} · {film.genre}</span><h1 key={film.id}>{film.title}</h1><p className="hero-description">{film.description}</p><div className="hero-facts"><span>{film.runtime}</span><span>{film.rating}</span><span>FEATURED COLLECTION</span></div></div><div className="rail-controls"><span className="position"><b>{String(selected + 1).padStart(2, '0')}</b> / {String(films.length).padStart(2,'0')}</span><button aria-label="Previous film" onClick={() => move(-1)}><Icon name="arrow" className="reverse" /></button><button aria-label="Next film" onClick={() => move(1)}><Icon name="arrow" /></button></div></div>
        <div ref={railRef} className="film-rail" aria-label="Choose a featured film" onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); move(event.key === 'ArrowRight' ? 1 : -1) } }}>
          {films.map((item, index) => <div className={`film-item ${selected === index ? 'selected' : ''}`} key={item.id}>
            <button className="film-card" aria-label={`Select ${item.title}`} aria-pressed={selected === index} onClick={() => {heroInteracted.current=true;setSelected(index)}}><img src={art(item, 'poster')} alt="" /><span className="poster-shade" /><span className="card-number">0{index + 1}</span>{selected === index && <span className="card-selected"><i /> IN THE SPOTLIGHT</span>}</button>
            <span className="film-name">{item.short}</span><span className="film-year">{item.year} <span>·</span> {item.genre.split(' · ')[0]}</span>
          </div>)}
        </div>
        <div className="selection-bar" aria-live="polite"><div className="selection-copy"><span className="selected-title">{film.title}</span><span className="selected-meta">{film.year}<i />{film.runtime}<i />{film.genre}</span></div><div className="selection-actions"><button className="more-info-button" onClick={()=>openPanel('details')}>More info</button><button className={`save-button ${isSaved ? 'saved' : ''}`} aria-label={isSaved ? 'Remove from watchlist' : 'Add to watchlist'} onClick={toggleSaved}><Icon name={isSaved ? 'check' : 'bookmark'} /></button><button className="explore-button" onClick={playFeatured}>{/series/i.test(film.title_type||'')?'Play series':'Play film'} <span>▶</span></button></div></div>
      </div>
      <footer className="console-footer"><span className="footer-note">GOOD STORIES. NO DISTRACTIONS.</span><span className="age-rating">{film.rating}</span></footer>
    </section>
    <Catalogue ref={catalogueRef} />
    <nav className="dock site-dock" aria-label="Main navigation">{[['home','Home'],['grid','Browse'],['search','Search'],['bookmark','Watchlist'],['account','Account'],['info','About CutCrew']].map(([icon,label]) => <button key={icon} className={!panel && icon === 'home' ? 'active' : ''} aria-label={label} title={label} onClick={() => icon === 'home' ? goHome() : icon === 'grid' ? (setPanel(null), catalogueRef.current?.showBrowse()) : openPanel(icon === 'bookmark' ? 'watchlist' : icon)}><Icon name={icon} />{icon === 'home' && <span className="dock-dot" />}</button>)}</nav>
    {panel === 'play' && <PlaybackPanel key={film.id} film={film} onBack={() => setPanel(null)} />}
    {panel && panel !== 'play' && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) setPanel(null) }}><section className={`panel ${panel === 'play' ? 'panel--player' : ''}`} role="dialog" aria-modal="true" aria-labelledby="panel-heading"><button ref={closeRef} className="close-panel" aria-label="Close panel" onClick={() => setPanel(null)}><Icon name="close" /></button>
      {panel === 'details' && <><span className="eyebrow">IN THE SPOTLIGHT</span><h2 id="panel-heading">{detail?.title || film.title}</h2><p className="panel-meta">{detail?.release_year || film.year} · {film.runtime} · {film.genre}</p><img className="detail-art" src={art(film,'backdrop')} alt={film.title} /><p>{detail?.plot || film.description}</p>{detailsBusy && <p className="status-message">Loading live movie details…</p>}{error && <p className="status-message">{error}</p>}<button className="explore-button" onClick={playFeatured}>{/series/i.test(film.title_type||'')?'Play series':'Play film'} <span>▶</span></button><button className="panel-action" onClick={toggleSaved}><Icon name={isSaved ? 'check' : 'bookmark'} />{isSaved ? 'In your watchlist' : 'Add to watchlist'}</button></>}
      {panel === 'search' && <><span className="eyebrow">FIND YOUR NEXT ESCAPE</span><h2 id="panel-heading">What are you in the mood for?</h2><label className="search-box"><Icon name="search" /><input aria-label="Search movies and series" placeholder="Search movies and series…" value={query} onChange={event => { setQuery(event.target.value); setResults([]); setError(''); setBusy(!!event.target.value.trim()) }} /></label>{busy && <p role="status">Searching the catalogue…</p>}{error && <p role="alert">{error}</p>}{!query.trim() && <p className="status-message">Search the catalogue by movie or series title.</p>}{query.trim() && !busy && !error && results.length === 0 && <p className="status-message">No titles to show yet.</p>}<div className="search-results">{results.map(item => <button className="search-result" key={item.imdb_id} aria-label={`View ${item.title}`} onClick={() => { setPanel(null); catalogueRef.current?.showTitle(item) }}><img src={item.poster_url} alt="" /><div><h3>{item.title}</h3><p>{item.release_year || 'Year unavailable'} · {item.title_type || 'Title'}</p></div><span className="search-result-arrow" aria-hidden="true">↗</span></button>)}</div></>}
      {panel === 'watchlist' && <LibraryPanel onSelect={item => { setPanel(null); catalogueRef.current?.showTitle(item) }} />}
      {panel === 'account' && <AccountPanel />}
      {panel === 'info' && <><span className="eyebrow">WELCOME TO CUTCREW</span><h2 id="panel-heading">A little less browsing.<br />A little more cinema.</h2><p>A quiet space for great stories. Explore the spotlight collection, discover a title, and build a watchlist for your next movie night.</p><p className="status-message">Choose Play film to start watching, browse the catalogue, or save a title for later. Sign in to sync watchlists and viewing progress across your profiles.</p></>}
    </section></div>}
  </main>
}



