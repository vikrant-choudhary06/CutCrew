import { useEffect, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import Icon from '../components/Icon'
import { Art, Grid } from '../components/Rows'
import { Notice } from '../components/Shell'
import { useLibrary } from '../components/LibraryContext'
import { getJSON, peekJSON, backdropUrl, runtimeLabel, ratingLabel, watchPath } from '../lib/api'

const STATUS = { FINISHED: 'Finished', RELEASING: 'Airing', NOT_YET_RELEASED: 'Coming soon', CANCELLED: 'Cancelled', HIATUS: 'On hiatus' }
const PAGE = 100

function useAnime(id, initial) {
  const path = '/api/anime/' + id
  const [state, setState] = useState(() => ({ data: peekJSON(path)?.data || (initial?.anilist_id === Number(id) ? initial : null), done: !!peekJSON(path), error: '', attempt: 0 }))
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    getJSON(path, { signal: controller.signal, timeout: 60000, fresh: retry > 0 })
      .then(body => { if (!controller.signal.aborted) setState({ data: body.data, done: true, error: '', attempt: retry }) })
      .catch(error => { if (!controller.signal.aborted) setState(s => ({ ...s, done: true, attempt: retry, error: error.name === 'TimeoutError' ? 'Loading this anime is taking too long.' : 'Anime details could not load.' })) })
    return () => controller.abort()
  }, [path, retry])
  const loading = !state.done || state.attempt !== retry
  return { data: state.data, loading, error: loading ? '' : state.error, retry: () => setRetry(n => n + 1) }
}

// Long shows are split into blocks of 100 episodes so the page stays light.
function Episodes({ data, progress }) {
  const list = data.episode_metadata || []
  const latest = progress.filter(p => p.imdb_id === data.imdb_id && p.episode > 0).sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0))[0]
  const [block, setBlock] = useState(() => Math.floor(Math.max(0, (latest?.episode || 1) - 1) / PAGE))
  if (!list.length) return <p className="muted">{data.status === 'NOT_YET_RELEASED' ? 'This anime hasn\'t started airing yet.' : 'Episodes aren\'t available for this anime yet. Try again later.'}</p>
  const blocks = Math.ceil(list.length / PAGE)
  const shown = list.slice(block * PAGE, block * PAGE + PAGE)
  return <div className="episodes">
    {blocks > 1 && <div className="chips season-chips" role="tablist" aria-label="Episode ranges">
      {Array.from({ length: blocks }, (_, i) => <button key={i} role="tab" aria-selected={i === block} className="chip" onClick={() => setBlock(i)}>{i * PAGE + 1}–{Math.min(list.length, (i + 1) * PAGE)}</button>)}
    </div>}
    <ol className="episode-list">
      {shown.map(ep => {
        const p = progress.find(x => x.imdb_id === data.imdb_id && x.episode === ep.episode)
        const named = ep.title && !/^Episode \d+$/.test(ep.title)
        return <li key={ep.episode}>
          <Link to={watchPath(data, 1, ep.episode)} className="episode">
            <span className="episode-art"><Art src={ep.thumbnail || data.backdrop_url} alt="" fallback={`Episode ${ep.episode}`} />
              <span className="episode-play"><Icon name="play" size={16} /></span>
              {p?.duration > 0 && <span className="wide-progress"><span style={{ width: `${p.completed ? 100 : Math.min(100, (p.position / p.duration) * 100)}%` }} /></span>}
            </span>
            <span className="episode-text"><span className="episode-number">Episode {ep.episode}</span>{named && <span className="episode-title">{ep.title}</span>}{p?.completed && <span className="muted">Watched</span>}</span>
          </Link>
        </li>
      })}
    </ol>
  </div>
}

export default function AnimeTitleRoute() {
  const { id } = useParams()
  return <AnimeTitlePage key={id} id={id} />
}

function AnimeTitlePage({ id }) {
  const location = useLocation()
  const { data, loading, error, retry } = useAnime(id, location.state?.item)
  const library = useLibrary()
  const [tab, setTab] = useState(null)

  if (!data) {
    if (loading) return <main id="main" className="title-page"><div className="title-hero skeleton-hero" aria-busy="true" /></main>
    return <main id="main" className="page"><Notice title="This anime couldn't be found." action={<button className="button button--quiet" onClick={retry}>Try again</button>}>{error}</Notice></main>
  }
  const progress = library.library.progress
  const entries = progress.filter(p => p.imdb_id === data.imdb_id)
  const resume = entries.filter(p => !p.completed && p.position > 10).sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0))[0]
  const available = data.episodes_available ?? (data.episode_metadata || []).length
  const movie = data.format === 'MOVIE' && available <= 1
  const canPlay = data.playback !== false && available > 0 && !loading
  const playTarget = resume ? watchPath(data, 1, resume.episode) : watchPath(data, 1, 1)
  const playLabel = resume ? (movie ? 'Resume' : `Resume episode ${resume.episode}`) : movie ? 'Play' : 'Play episode 1'
  const saved = library.library.watchlist.some(x => x.imdb_id === data.imdb_id)
  const episodesFact = movie ? runtimeLabel(data.runtime_minutes) : available ? `${available}${data.episodes && data.episodes !== available ? ` of ${data.episodes}` : ''} episodes` : ''
  const facts = [data.release_year, data.format_label, episodesFact, STATUS[data.status], (data.genres || []).slice(0, 3).join(', ')].filter(Boolean)
  const tabs = [...(movie ? [] : [['episodes', 'Episodes']]), ...(data.relations?.length ? [['related', 'Seasons and related']] : []), ['more', 'More like this'], ['details', 'Details']]
  const active = tab || tabs[0][0]
  const why = data.playback === false ? 'Anime playback is turned off right now.' : data.status === 'NOT_YET_RELEASED' ? 'This anime hasn\'t started airing yet.' : !available ? 'No episodes are out yet.' : ''

  return <main id="main" className="title-page anime-title">
    <section className="title-hero">
      <div className="title-media" aria-hidden="true"><img src={backdropUrl(data)} alt="" fetchPriority="high" decoding="async" onLoad={e => e.currentTarget.classList.add('is-loaded')} onError={e => { e.currentTarget.style.visibility = 'hidden' }} /></div>
      <div className="title-body">
        <h1 className="hero-title">{data.title}</h1>
        {data.native_title && data.native_title !== data.title && <p className="anime-native" lang="ja">{data.native_title}</p>}
        <p className="facts">{facts.map(f => <span key={f}>{f}</span>)}{ratingLabel(data.rating) && <span className="rating"><Icon name="star" size={13} />{ratingLabel(data.rating)}</span>}</p>
        {data.plot ? <p className="title-plot anime-plot">{data.plot}</p> : loading ? <span className="skeleton skeleton--text" /> : null}
        {data.studios?.length > 0 && <p className="cast-line"><span className="muted">Studio</span> {data.studios.join(', ')}</p>}
        <div className="actions">
          {canPlay ? <Link to={playTarget} className="button button--play"><Icon name="play" />{playLabel}</Link>
            : <span className="button button--play" aria-disabled="true"><Icon name="play" />Play</span>}
          <button className="button button--round" aria-pressed={saved} aria-label={saved ? 'Remove from My List' : 'Add to My List'} title={saved ? 'In My List' : 'Add to My List'} onClick={() => library.toggleWatchlist(data)}><Icon name={saved ? 'check' : 'plus'} /></button>
        </div>
        {!loading && why && <p className="muted anime-note">{why}</p>}
        {!loading && canPlay && <p className="muted anime-note">Hindi, Tamil, Telugu, Japanese and more · switch audio in the player</p>}
        {error && <p className="inline-error">{error} <button className="text-button" onClick={retry}>Try again</button></p>}
      </div>
    </section>
    <section className="title-tabs">
      <div className="tabs" role="tablist" aria-label="Anime sections">
        {tabs.map(([key, label]) => <button key={key} role="tab" aria-selected={active === key} onClick={() => setTab(key)}>{label}</button>)}
      </div>
      <div role="tabpanel" className="tab-panel" key={active}>
        {active === 'episodes' && (loading && !data.episode_metadata ? <div className="episode-list">{Array.from({ length: 4 }, (_, i) => <span key={i} className="skeleton skeleton--episode" />)}</div> : <Episodes data={data} progress={progress} />)}
        {active === 'related' && <Grid items={data.relations || []} loading={false} />}
        {active === 'more' && (data.recommendations?.length ? <Grid items={data.recommendations} loading={false} /> : <p className="muted">No similar anime to suggest right now.</p>)}
        {active === 'details' && <dl className="details">
          {data.romaji_title && data.romaji_title !== data.title && <><dt>Japanese title</dt><dd>{data.romaji_title}</dd></>}
          {data.format_label && <><dt>Type</dt><dd>{data.format_label}</dd></>}
          {data.status && <><dt>Status</dt><dd>{STATUS[data.status] || data.status}{data.next_episode && data.status === 'RELEASING' ? ` · episode ${data.next_episode} is next` : ''}</dd></>}
          {data.episodes > 0 && <><dt>Episodes</dt><dd>{data.episodes}</dd></>}
          {data.runtime_minutes > 0 && <><dt>{movie ? 'Runtime' : 'Episode length'}</dt><dd>{runtimeLabel(data.runtime_minutes)}</dd></>}
          {data.genres?.length > 0 && <><dt>Genres</dt><dd>{data.genres.join(', ')}</dd></>}
          {data.studios?.length > 0 && <><dt>Studio</dt><dd>{data.studios.join(', ')}</dd></>}
          {ratingLabel(data.rating) && <><dt>AniList score</dt><dd>{ratingLabel(data.rating)} / 10</dd></>}
          {data.external_links?.length > 0 && <><dt>Watch officially</dt><dd className="anime-links">{data.external_links.map(link => <a key={link.url} href={link.url} target="_blank" rel="noreferrer noopener">{link.site}</a>)}</dd></>}
          <dt>Source</dt><dd><a href={`https://anilist.co/anime/${data.anilist_id}`} target="_blank" rel="noreferrer noopener">AniList</a></dd>
        </dl>}
      </div>
    </section>
  </main>
}
