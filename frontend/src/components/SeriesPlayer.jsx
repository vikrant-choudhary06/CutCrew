import { useState } from 'react'
import PlaybackPanel from './LazyPlaybackPanel'
export default function SeriesPlayer({ data, season, episode, onEpisodeChange, onBack }) {
  const [target, setTarget] = useState({ season, episode })
  const [autoplay, setAutoplay] = useState(() => { try { return localStorage.getItem('cutcrew-autoplay') !== 'false' } catch { return true } })
  const list = (data.seasons || []).flatMap(s => (s.episodes || []).map(e => ({ season: s.season_number, episode: e.episode_number, title: e.title }))).filter(e => e.season > 0 && e.episode > 0).sort((a,b) => a.season - b.season || a.episode - b.episode)
  const index = list.findIndex(e => e.season === target.season && e.episode === target.episode), next = index >= 0 ? list[index + 1] : null
  function choose(value) { setTarget(value); onEpisodeChange?.(value) }
  function toggle(value) { setAutoplay(value); try { localStorage.setItem('cutcrew-autoplay', String(value)) } catch { /* Guest storage can be unavailable. */ } }
  const controls = season ? { list, target, next, autoplay, choose, toggle, advance: () => { if (next) choose(next) } } : null
  return <PlaybackPanel key={`${data.imdb_id}:${target.season}:${target.episode}`} film={{ ...data, id: data.imdb_id, season: target.season, episode: target.episode }} onBack={onBack} episodeControls={controls} onEnded={() => { if (autoplay && next) choose(next) }} />
}
