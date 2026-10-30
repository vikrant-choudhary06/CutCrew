import { Link, useSearchParams } from 'react-router-dom'
import { ContinueCard, Grid } from '../components/Rows'
import { useLibrary } from '../components/LibraryContext'

export default function MyListPage() {
  const library = useLibrary()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'continue' ? 'continue' : 'list'
  const seen = new Set()
  const continuing = library.library.progress.filter(p => !p.completed && p.position >= 10 && p.data?.imdb_id).filter(p => (seen.has(p.imdb_id) ? false : seen.add(p.imdb_id)))
  const list = library.library.watchlist
  return <main id="main" className="page my-list">
    <h1 className="page-title">My List</h1>
    <div className="tabs" role="tablist" aria-label="My List sections">
      <button role="tab" aria-selected={tab === 'list'} onClick={() => setParams({}, { replace: true })}>Saved ({list.length})</button>
      <button role="tab" aria-selected={tab === 'continue'} onClick={() => setParams({ tab: 'continue' }, { replace: true })}>Continue watching ({continuing.length})</button>
    </div>
    <p className="muted sync-note">{library.auth ? 'Saved to your profile on every device.' : <>Saved on this device. <Link to="/account">Sign in</Link> to keep it on every device.</>}</p>
    {tab === 'list' ? (list.length ? <Grid items={list} /> : <div className="notice"><h2>Nothing saved yet.</h2><p>Use the + button on any title to save it here.</p><Link to="/" className="button button--quiet">Find something to watch</Link></div>)
      : (continuing.length ? <div className="wide-grid">{continuing.map(e => <ContinueCard key={e.imdb_id} entry={e} />)}</div> : <div className="notice"><h2>You're all caught up.</h2><p>Titles you start watching appear here so you can pick up where you left off.</p></div>)}
  </main>
}
