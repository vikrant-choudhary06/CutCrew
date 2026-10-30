import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import SeriesPlayer from '../components/SeriesPlayer'
import { Notice } from '../components/Shell'
import { useLibrary } from '../components/LibraryContext'
import { getJSON, peekJSON, isSeries, titlePath } from '../lib/api'

export default function WatchPage() {
  const { id } = useParams()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const library = useLibrary()
  const path = '/api/movies/' + id
  const [state, setState] = useState(() => ({ data: peekJSON(path)?.data || null, error: '' }))
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (state.data?.imdb_id === id && !retry) return
    const controller = new AbortController()
    getJSON(path, { signal: controller.signal, timeout: 90000 })
      .then(body => setState({ data: body.data, error: '' }))
      .catch(error => { if (!controller.signal.aborted) setState({ data: null, error: error.name === 'TimeoutError' ? 'Loading this title is taking too long.' : 'This title could not load.' }) })
    return () => controller.abort()
  }, [path, retry]) // eslint-disable-line react-hooks/exhaustive-deps

  const back = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate(titlePath({ imdb_id: id }), { replace: true }))

  if (!state.data) return <main id="main" className="watch-loading">
    {state.error ? <Notice title="Playback couldn't start." action={<div className="actions"><button className="button button--play" onClick={() => setRetry(n => n + 1)}>Try again</button><button className="button button--quiet" onClick={back}>Go back</button></div>}>{state.error}</Notice>
      : <div className="watch-state" role="status"><span className="playback-spinner" /><p>Getting your video ready…</p></div>}
  </main>

  const data = state.data
  let season = Number(params.get('season')) || undefined, episode = Number(params.get('episode')) || undefined
  if (isSeries(data) && !(season && episode)) {
    // No episode in the link: resume the latest, otherwise start at the first.
    const latest = library.library.progress.filter(p => p.imdb_id === data.imdb_id && p.season > 0 && !p.completed).sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0))[0]
    const first = [...(data.seasons || [])].filter(s => s.season_number >= 1).sort((a, b) => a.season_number - b.season_number)[0]
    const firstEp = first && [...(first.episodes || [])].sort((a, b) => a.episode_number - b.episode_number)[0]
    season = latest?.season || first?.season_number; episode = latest?.episode || firstEp?.episode_number
    if (!season || !episode) return <main id="main" className="page"><Notice title="No episodes are available yet." action={<button className="button button--quiet" onClick={back}>Go back</button>}>Episodes for this series haven't been found. Try again later.</Notice></main>
  }
  return <SeriesPlayer key={data.imdb_id} data={data} season={isSeries(data) ? season : undefined} episode={isSeries(data) ? episode : undefined}
    onBack={back} onEpisodeChange={next => setParams({ season: String(next.season), episode: String(next.episode) }, { replace: true })} />
}
