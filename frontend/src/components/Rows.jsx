import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from './Icon'
import { getJSON, posterUrl, backdropUrl, isAnime, typeLabel, titlePath, watchPath, prefersReducedMotion } from '../lib/api'
import { useInstant } from '../lib/instant'
import { useLibrary } from './LibraryContext'

function InstantBadge() {
  return <span className="instant-badge" title="Plays from CutCrew's own copy"><Icon name="bolt" size={12} />Instant</span>
}

// Image with a calm placeholder and a text fallback when artwork is missing.
export function Art({ src, alt, className = '', fallback, eager = false }) {
  // Status is remembered per src, so a new src starts as "loading" without an effect.
  const [seen, setSeen] = useState({ src: null, status: 'loading' })
  const state = !src ? 'failed' : seen.src === src ? seen.status : 'loading'
  return <span className={`art ${className} art--${state}`}>
    {src && state !== 'failed' && <img src={src} alt={alt} loading={eager ? 'eager' : 'lazy'} decoding="async" onLoad={() => setSeen({ src, status: 'ready' })} onError={() => setSeen({ src, status: 'failed' })} />}
    {state === 'failed' && <span className="art-fallback">{fallback ?? alt}</span>}
  </span>
}

export function PosterCard({ item }) {
  const instant = useInstant().has(item.imdb_id)
  const library = useLibrary()
  const saved = library.library.watchlist.some(x => x.imdb_id === item.imdb_id)
  return <article className="poster-card">
    <Link to={titlePath(item)} state={{ item }} className="poster-link">
      <Art src={posterUrl(item)} alt={item.title} className="poster-art" />
      {instant && <InstantBadge />}
      <span className="poster-title">{item.title}</span>
      <span className="poster-meta"><span>{item.release_year || ''}</span><span>{item.relation || typeLabel(item)}</span></span>
    </Link>
    <button className="poster-save" aria-pressed={saved} aria-label={saved ? `Remove ${item.title} from My List` : `Add ${item.title} to My List`} onClick={() => library.toggleWatchlist(item)}>
      <Icon name={saved ? 'check' : 'plus'} size={16} />
    </button>
  </article>
}

// Continue watching: wide frame, progress bar, where you are, and Remove.
export function ContinueCard({ entry }) {
  const library = useLibrary()
  const item = entry.data
  const left = entry.duration > 0 ? Math.max(0, Math.round((entry.duration - entry.position) / 60)) : null
  const where = entry.episode > 0 && isAnime(item) ? `Episode ${entry.episode}` : entry.season > 0 ? `S${entry.season} E${entry.episode}` : ''
  return <article className="wide-card">
    <Link to={watchPath(item, entry.season || undefined, entry.episode || undefined)} className="wide-link" aria-label={`Resume ${item.title}${where ? ' ' + where : ''}`}>
      <Art src={backdropUrl(item, 'small')} alt="" className="wide-art" fallback={item.title} />
      <span className="wide-play"><Icon name="play" size={18} /></span>
      {entry.duration > 0 && <span className="wide-progress" aria-hidden="true"><span style={{ width: `${Math.min(100, (entry.position / entry.duration) * 100)}%` }} /></span>}
    </Link>
    <div className="wide-text">
      <Link to={titlePath(item)} state={{ item }} className="wide-title">{item.title}</Link>
      <span className="wide-meta">{[where, left !== null ? `${left} min left` : `${Math.floor(entry.position / 60)} min watched`].filter(Boolean).join('  ')}</span>
    </div>
    <button className="wide-remove" aria-label={`Remove ${item.title} from Continue watching`} onClick={() => library.removeProgress(item.imdb_id)}><Icon name="close" size={16} /></button>
  </article>
}

export function TopCard({ item, rank }) {
  const instant = useInstant().has(item.imdb_id)
  return <article className="top-card">
    <Link to={titlePath(item)} state={{ item }} className="top-link" aria-label={`Number ${rank}: ${item.title}`}>
      <span className="top-rank" aria-hidden="true">{rank}</span>
      <Art src={posterUrl(item)} alt="" className="top-art" fallback={item.title} />
      {instant && <InstantBadge />}
    </Link>
  </article>
}

// Loads when it nears the viewport. `path` returns { data: [...] }.
// Returns [ref, { loading, items, error, retry }]. The result is tagged with the
// request it answers, so "loading" is derived instead of set inside an effect.
function useLazyItems(path, { filter, limit = 18, eager = false }) {
  const ref = useRef(null)
  const [visible, setVisible] = useState(eager)
  const [retry, setRetry] = useState(0)
  const [result, setResult] = useState({ key: null, items: [], error: '' })
  const key = visible && path ? `${path}#${retry}` : null
  useEffect(() => {
    if (visible || !ref.current) return
    const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) setVisible(true) }, { rootMargin: '600px 0px' })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [visible])
  useEffect(() => {
    if (!key) return
    const controller = new AbortController()
    getJSON(path, { signal: controller.signal, timeout: 60000 })
      .then(body => { let items = body.data || []; if (filter) items = filter(items); if (!controller.signal.aborted) setResult({ key, items: items.slice(0, limit), error: '' }) })
      .catch(error => { if (!controller.signal.aborted) setResult({ key, items: [], error: error.name === 'TimeoutError' ? 'This row took too long to load.' : 'This row could not load.' }) })
    return () => controller.abort()
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  // Not yet visible counts as loading, so the row keeps its skeleton height.
  const current = key !== null && result.key === key
  return [ref, { loading: !current, items: current ? result.items : [], error: current ? result.error : '', retry: () => setRetry(n => n + 1) }]
}

export function Row({ title, path, items: given, kind = 'poster', more, filter, limit, eager, emptyHidden = true }) {
  const [sectionRef, lazy] = useLazyItems(given ? null : path, { filter, limit, eager })
  const items = given || lazy.items
  const loading = !given && lazy.loading
  const rail = useRef(null)
  const [edges, setEdges] = useState({ start: true, end: false })
  const update = () => { const r = rail.current; if (r) setEdges({ start: r.scrollLeft < 8, end: r.scrollLeft + r.clientWidth >= r.scrollWidth - 8 }) }
  useEffect(update, [items.length])
  const scroll = dir => rail.current?.scrollBy({ left: dir * rail.current.clientWidth * 0.85, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  if (!loading && !lazy.error && !items.length && emptyHidden) return <div ref={sectionRef} />
  return <section ref={sectionRef} className={`row row--${kind}`} aria-label={title}>
    <header className="row-head">
      <h2>{title}</h2>
      {more && <Link to={more} className="row-more">See all</Link>}
    </header>
    {lazy.error && !given ? <p className="row-error">{lazy.error} <button className="text-button" onClick={lazy.retry}>Try again</button></p> :
      <div className="rail-wrap">
        <button className="rail-arrow rail-arrow--left" hidden={edges.start || loading} onClick={() => scroll(-1)} aria-label={`Scroll ${title} back`}><Icon name="left" /></button>
        <div ref={rail} className="rail" onScroll={update} aria-busy={loading}>
          {loading ? Array.from({ length: kind === 'wide' ? 4 : 7 }, (_, i) => <span key={i} className={`skeleton skeleton--${kind}`} />) :
            items.map((item, i) => kind === 'wide' ? <ContinueCard key={item.imdb_id + (item.season || '') + (item.episode || '')} entry={item} /> :
              kind === 'top' ? <TopCard key={item.imdb_id} item={item} rank={i + 1} /> : <PosterCard key={item.imdb_id} item={item} />)}
        </div>
        <button className="rail-arrow rail-arrow--right" hidden={edges.end || loading} onClick={() => scroll(1)} aria-label={`Scroll ${title} forward`}><Icon name="right" /></button>
      </div>}
  </section>
}

export function Grid({ items, loading, count = 12 }) {
  return <div className="grid" aria-busy={loading}>
    {items.map(item => <PosterCard key={item.imdb_id} item={item} />)}
    {loading && Array.from({ length: count }, (_, i) => <span key={'s' + i} className="skeleton skeleton--poster" />)}
  </div>
}
