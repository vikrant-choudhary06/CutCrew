import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from './Icon'
import { getJSON, backdropUrl, logoUrl, runtimeLabel, isSeries, titlePath, watchPath, prefersReducedMotion } from '../lib/api'
import { orderFeatured } from './featuredSelection'
import { useInstant } from '../lib/instant'
import { useLibrary } from './LibraryContext'

// Shown until live picks load (and if they never do). Local artwork ships with the app.
const fallback = [
  { imdb_id: 'tt15239678', title: 'Dune: Part Two', title_type: 'Movie', release_year: 2024, runtime_minutes: 166, content_rating: 'PG-13', genres: ['Adventure', 'Sci-Fi'], plot: 'Paul Atreides unites with Chani and the Fremen on a path of revenge, facing a choice between the love of his life and the fate of the universe.', backdrop_url: '/artwork/dune-backdrop.jpg' },
  { imdb_id: 'tt9362722', title: 'Spider-Man: Across the Spider-Verse', title_type: 'Movie', release_year: 2023, runtime_minutes: 140, content_rating: 'PG', genres: ['Animation', 'Adventure'], plot: 'Miles Morales travels across the multiverse, where a team of Spider-People challenges what it means to be a hero.', backdrop_url: '/artwork/spiderverse-backdrop.jpg' },
  { imdb_id: 'tt1877830', title: 'The Batman', title_type: 'Movie', release_year: 2022, runtime_minutes: 176, content_rating: 'PG-13', genres: ['Crime', 'Mystery'], plot: 'A trail of cryptic clues leads Batman into the shadows of Gotham, where he must confront corruption and bring justice to the city.', backdrop_url: '/artwork/batman-backdrop.jpg' },
]

function loads(url, test) {
  return new Promise(resolve => {
    const image = new Image()
    const done = ok => { clearTimeout(timer); image.onload = image.onerror = null; resolve(ok) }
    const timer = setTimeout(() => done(false), 6000)
    image.onload = () => done(test ? test(image) : true)
    image.onerror = () => done(false)
    image.src = url
  })
}

export default function Hero() {
  const [items, setItems] = useState(fallback)
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [logoOk, setLogoOk] = useState({})
  const touched = useRef(false)
  const instant = useInstant()
  const library = useLibrary()

  useEffect(() => {
    const controller = new AbortController()
    getJSON('/api/featured', { signal: controller.signal, timeout: 25000 }).then(async body => {
      let previous = []
      try { previous = JSON.parse(localStorage.getItem('cutcrew-featured-last') || '[]') } catch { /* storage may be off */ }
      const ordered = orderFeatured(body.data || [], Array.isArray(previous) ? previous : [])
      const chosen = []
      // Only feature titles whose wide artwork really loads.
      for (let i = 0; i < ordered.length && chosen.length < 5 && !controller.signal.aborted; i += 5) {
        const batch = await Promise.all(ordered.slice(i, i + 5).map(async item => (await loads(backdropUrl(item), img => img.naturalWidth >= 900 && img.naturalWidth / img.naturalHeight >= 1.35)) ? item : null))
        chosen.push(...batch.filter(Boolean))
      }
      if (controller.signal.aborted || touched.current || !chosen.length) return
      setItems(chosen.slice(0, 5)); setIndex(0)
      try { localStorage.setItem('cutcrew-featured-last', JSON.stringify(chosen.slice(0, 5).map(x => x.imdb_id))) } catch { /* fine */ }
    }).catch(() => {})
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (paused || prefersReducedMotion() || items.length < 2) return
    const timer = setTimeout(() => setIndex(i => (i + 1) % items.length), 9000)
    return () => clearTimeout(timer)
  }, [index, paused, items.length])

  const item = items[index] || items[0]
  useEffect(() => {
    if (!item || logoOk[item.imdb_id] !== undefined) return
    loads(logoUrl(item), img => img.naturalWidth > 40).then(ok => setLogoOk(m => ({ ...m, [item.imdb_id]: ok })))
  }, [item, logoOk])
  if (!item) return null

  const saved = library.library.watchlist.some(x => x.imdb_id === item.imdb_id)
  const facts = [item.release_year, item.content_rating, runtimeLabel(item.runtime_minutes) || (isSeries(item) ? 'Series' : ''), (item.genres || []).slice(0, 2).join(', ')].filter(Boolean)
  const choose = i => { touched.current = true; setIndex(i) }

  return <section className="hero" aria-roledescription="carousel" aria-label="Featured" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
    <div className="hero-media" aria-hidden="true">
      {items.map((x, i) => <img key={x.imdb_id} src={backdropUrl(x)} alt="" className={i === index ? 'is-current' : ''} fetchPriority={i === 0 ? 'high' : 'low'} loading={i === 0 ? 'eager' : 'lazy'} />)}
    </div>
    <div className="hero-body" aria-live="polite">
      {logoOk[item.imdb_id] ? <h1 className="hero-logo"><img src={logoUrl(item)} alt={item.title} /></h1> : <h1 className="hero-title">{item.title}</h1>}
      <p className="facts">{facts.map(f => <span key={f}>{f}</span>)}{instant.has(item.imdb_id) && <span className="instant-badge"><Icon name="bolt" size={12} />Instant</span>}</p>
      {item.plot && <p className="hero-plot">{item.plot}</p>}
      <div className="actions">
        <Link to={watchPath(item)} className="button button--play"><Icon name="play" />Play</Link>
        <Link to={titlePath(item)} state={{ item }} className="button button--quiet"><Icon name="info" />More info</Link>
        <button className="button button--round" aria-pressed={saved} aria-label={saved ? 'Remove from My List' : 'Add to My List'} onClick={() => library.toggleWatchlist(item)}><Icon name={saved ? 'check' : 'plus'} /></button>
      </div>
    </div>
    {items.length > 1 && <div className="hero-pager" role="group" aria-label="Choose featured title">
      {items.map((x, i) => <button key={x.imdb_id} aria-label={`Show ${x.title}`} aria-current={i === index} className={i === index && !paused && !prefersReducedMotion() ? 'is-running' : ''} onClick={() => choose(i)}><span /></button>)}
    </div>}
  </section>
}
