import { lazy, Suspense } from 'react'
import { createPortal } from 'react-dom'
const PlaybackPanel = lazy(() => import('./PlaybackPanel'))
export default function LazyPlaybackPanel(props) {
  return <Suspense fallback={createPortal(<section className="watch-screen controls-visible" role="dialog" aria-modal="true" aria-labelledby="watch-title"><header className="watch-header"><button className="watch-back" aria-label="Back to browsing" onClick={props.onBack}>←</button><h1 id="watch-title">{props.film.title}</h1></header><div className="watch-state" role="status"><span className="playback-spinner"/><p>Preparing your player…</p></div></section>,document.body)}><PlaybackPanel {...props}/></Suspense>
}
