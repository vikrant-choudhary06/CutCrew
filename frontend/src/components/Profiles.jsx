import { useState } from 'react'
import { useLibrary } from './LibraryContext'

const SESSION_KEY = 'cutcrew-profile-chosen'

export function ProfileTiles({ onChosen }) {
  const lib = useLibrary()
  return <ul className="profile-tiles">
    {lib.auth.profiles.map(p => <li key={p.id}>
      <button className="profile-tile" aria-pressed={p.id === lib.profile} onClick={() => { lib.changeProfile(p.id); onChosen?.(p) }}>
        <span className="avatar avatar--large" data-tone={p.name.charCodeAt(0) % 4}>{p.name.slice(0, 1).toUpperCase()}</span>
        <span className="profile-name">{p.name}</span>
      </button>
    </li>)}
  </ul>
}

// "Who's watching?" once per browser session, for accounts with several profiles.
export function WhoIsWatching() {
  const lib = useLibrary()
  const [done, setDone] = useState(() => { try { return sessionStorage.getItem(SESSION_KEY) === '1' } catch { return true } })
  if (done || !lib.auth || lib.auth.profiles.length < 2) return null
  const finish = () => { try { sessionStorage.setItem(SESSION_KEY, '1') } catch { /* fine */ } setDone(true) }
  return <div className="who" role="dialog" aria-modal="true" aria-labelledby="who-title">
    <h1 id="who-title">Who's watching?</h1>
    <ProfileTiles onChosen={finish} />
  </div>
}
