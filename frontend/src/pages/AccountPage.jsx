import AccountPanel from '../components/AccountPanel'
import { ProfileTiles } from '../components/Profiles'
import { useLibrary } from '../components/LibraryContext'

export default function AccountPage() {
  const lib = useLibrary()
  return <main id="main" className="page account-page">
    {lib.auth && lib.auth.profiles.length > 0 && <section className="account-profiles" aria-labelledby="profiles-title">
      <h1 id="profiles-title" className="page-title">Profiles</h1>
      <p className="muted">Each profile keeps its own My List and viewing progress. Choose who's watching.</p>
      <ProfileTiles />
    </section>}
    <section className="account-card"><AccountPanel /></section>
  </main>
}
