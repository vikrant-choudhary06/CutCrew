import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import SeriesPlayer from '../components/SeriesPlayer'
import { Notice } from '../components/Shell'
import { useLibrary } from '../components/LibraryContext'
import { getJSON, peekJSON } from '../lib/api'

// Plays one anime episode with the shared player. Anime has no seasons in
// CutCrew (each AniList entry is one season), so episodes sit in season 1.
export default function AnimeWatchPage() {
  const { id } = useParams()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const library = useLibrary()
  const path = '/api/anime/' + id
  const [state, setState] = useState(() => ({ data: peekJSON(path)?.data || null, error: '' }))
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (state.data?.anilist_id === Number(id) && !retry) return
    const controller = new AbortController()
    getJSON(path, { signal: controller.signal, timeout: 60000 })
      .then(body => setState({ data: body.data, error: '' }))
      .catch(error => { if (!controller.signal.aborted) setState({ data: null, error: error.name === 'TimeoutError' ? 'Loading this anime is taking too long.' : 'This anime could not load.' }) })
    return () => controller.abort()
  }, [path, retry]) // eslint-disable-line react-hooks/exhaustive-deps

  const back = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate(`/anime/${id}`, { replace: true }))

  if (!state.data) return <main id="main" className="watch-loading">
    {state.error ? <Notice title="Playback couldn't start." action={<div className="actions"><button className="button button--play" onClick={() => setRetry(n => n + 1)}>Try again</button><button className="button button--quiet" onClick={back}>Go back</button></div>}>{state.error}</Notice>
      : <div className="watch-state" role="status"><span className="playback-spinner" /><p>Getting your episode ready…</p></div>}
  </main>

  const data = state.data
  const available = data.episodes_available || 0
  if (data.playback === false || !available) return <main id="main" className="page"><Notice title={data.playback === false ? 'Anime playback is turned off right now.' : 'No episodes are out yet.'} action={<button className="button button--quiet" onClick={back}>Go back</button>}>Try again later.</Notice></main>

  let episode = Number(params.get('episode')) || undefined
  if (!episode || episode > available) {
    // No episode in the link: resume the latest unfinished one, otherwise start at 1.
    const latest = library.library.progress.filter(p => p.imdb_id === data.imdb_id && p.episode > 0 && !p.completed).sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0))[0]
    episode = latest?.episode && latest.episode <= available ? latest.episode : 1
  }
  return <SeriesPlayer key={data.imdb_id} data={data} season={1} episode={episode}
    onBack={back} onEpisodeChange={next => setParams({ episode: String(next.episode) }, { replace: true })} />
}
