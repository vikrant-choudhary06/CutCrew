import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import PlaybackPanel from './LazyPlaybackPanel'

const COUNTDOWN = 10

// "Next episode in 10s" card shown when an episode ends with autoplay on.
function NextUp({ next, onPlay, onCancel }) {
  const [left, setLeft] = useState(COUNTDOWN)
  useEffect(() => {
    if (left <= 0) { onPlay(); return }
    const timer = setTimeout(() => setLeft(n => n - 1), 1000)
    return () => clearTimeout(timer)
  }, [left, onPlay])
  return createPortal(<div className="next-up" role="alertdialog" aria-labelledby="next-up-title" aria-describedby="next-up-time">
    <p id="next-up-title" className="next-up-title">Next: {next.plain ? `Episode ${next.episode}` : `S${next.season} E${next.episode}`}{next.title && !/^Episode \d+$/.test(next.title) ? ` · ${next.title}` : ''}</p>
    <p id="next-up-time" className="next-up-time" aria-live="polite">Starts in {left} s</p>
    <div className="next-up-actions">
      <button className="button button--play" autoFocus onClick={onPlay}>Play now</button>
      <button className="button button--quiet" onClick={onCancel}>Cancel</button>
    </div>
    <span className="next-up-bar" style={{ '--secs': `${COUNTDOWN}s` }} aria-hidden="true" />
  </div>, document.body)
}

export default function SeriesPlayer({ data, season, episode, onEpisodeChange, onBack }) {
  const [target, setTarget] = useState({ season, episode })
  const [pending, setPending] = useState(false)
  const [autoplay, setAutoplay] = useState(() => { try { return localStorage.getItem('cutcrew-autoplay') !== 'false' } catch { return true } })
  const list = (data.seasons || []).flatMap(s => (s.episodes || []).map(e => ({ season: s.season_number, episode: e.episode_number, title: e.title, plain: data.kind === 'anime' }))).filter(e => e.season > 0 && e.episode > 0).sort((a, b) => a.season - b.season || a.episode - b.episode)
  const index = list.findIndex(e => e.season === target.season && e.episode === target.episode), next = index >= 0 ? list[index + 1] : null
  function choose(value) { setPending(false); setTarget(value); onEpisodeChange?.(value) }
  function toggle(value) { setAutoplay(value); try { localStorage.setItem('cutcrew-autoplay', String(value)) } catch { /* Guest storage can be unavailable. */ } }
  const controls = season ? { list, target, next, autoplay, choose, toggle, advance: () => { if (next) choose(next) } } : null
  return <>
    <PlaybackPanel key={`${data.imdb_id}:${target.season}:${target.episode}`} film={{ ...data, id: data.imdb_id, season: target.season, episode: target.episode }} onBack={onBack} episodeControls={controls} onEnded={() => { if (autoplay && next) setPending(true) }} />
    {pending && next && <NextUp next={next} onPlay={() => choose(next)} onCancel={() => setPending(false)} />}
  </>
}
