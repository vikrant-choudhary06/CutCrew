import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Hero from '../components/Hero'
import { Row } from '../components/Rows'
import { useLibrary } from '../components/LibraryContext'
import { getJSON, isSeries, GENRES } from '../lib/api'

// "Because you watched X": a genre row seeded by something finished or well under way.
function BecauseYouWatched({ progress }) {
  const watched = progress.filter(p => p.completed || p.position >= 600)
  const seed = watched[0]?.data
  const [genre, setGenre] = useState(null)
  useEffect(() => {
    if (!seed?.imdb_id) return
    const controller = new AbortController()
    getJSON('/api/movies/' + seed.imdb_id, { signal: controller.signal, timeout: 60000 })
      .then(body => setGenre((body.data?.genres || []).find(g => GENRES.includes(g)) || null)).catch(() => {})
    return () => controller.abort()
  }, [seed?.imdb_id])
  if (!seed || !genre) return null
  const type = isSeries(seed) ? 'series' : 'movie'
  const exclude = new Set(watched.map(w => w.imdb_id))
  return <Row title={`Because you watched ${seed.title}`} path={`/api/discover?type=${type}&genre=${encodeURIComponent(genre)}&limit=24`} filter={items => items.filter(x => !exclude.has(x.imdb_id))} more={`/${type === 'series' ? 'series' : 'movies'}?genre=${encodeURIComponent(genre)}`} />
}

export default function Home() {
  const library = useLibrary()
  const seen = new Set()
  const continuing = library.library.progress
    .filter(p => !p.completed && p.position >= 10 && p.data?.imdb_id)
    .filter(p => (seen.has(p.imdb_id) ? false : seen.add(p.imdb_id)))
    .slice(0, 12)
  return <main id="main" className="home">
    <Hero />
    <div className="rows">
      {continuing.length > 0 && <Row title="Continue watching" items={continuing} kind="wide" more="/my-list?tab=continue" />}
      <Row title="Top 10 movies right now" path="/api/movies/trending" kind="top" limit={10} eager />
      <Row title="New in India" path="/api/discover/new?type=movie&country=IN&limit=24" more="/movies?sort=new&country=IN" eager />
      <Row title="New releases worldwide" path="/api/discover/new?type=movie&limit=24" more="/movies?sort=new" />
      <Row title="Popular series right now" path="/api/series/trending" more="/series" />
      <Row title="New Indian series" path="/api/discover/new?type=series&country=IN&limit=24" more="/series?sort=new&country=IN" />
      <Row title="Trending anime" path="/api/anime/browse?kind=trending" more="/anime" />
      <BecauseYouWatched progress={library.library.progress} />
      <Row title="Action movies" path="/api/discover?type=movie&genre=Action&limit=24" more="/movies?genre=Action" />
      <Row title="Comedies" path="/api/discover?type=movie&genre=Comedy&limit=24" more="/movies?genre=Comedy" />
      <Row title="Thrillers" path="/api/discover?type=movie&genre=Thriller&limit=24" more="/movies?genre=Thriller" />
      <Row title="Crime series" path="/api/discover?type=series&genre=Crime&limit=24" more="/series?genre=Crime" />
      <Row title="Animated movies" path="/api/discover?type=movie&genre=Animation&limit=24" more="/movies?genre=Animation" />
      <Row title="Romance" path="/api/discover?type=movie&genre=Romance&limit=24" more="/movies?genre=Romance" />
      <Row title="Horror" path="/api/discover?type=movie&genre=Horror&limit=24" more="/movies?genre=Horror" />
      <section className="row genre-row" aria-label="Browse by genre">
        <header className="row-head"><h2>Browse by genre</h2></header>
        <div className="chips">{GENRES.map(g => <Link key={g} to={`/movies?genre=${encodeURIComponent(g)}`} className="chip">{g}</Link>)}</div>
      </section>
    </div>
  </main>
}
