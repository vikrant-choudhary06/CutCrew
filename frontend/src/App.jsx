import { lazy, Suspense, useEffect } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { TopBar, TabBar, Footer } from './components/Shell'
import { WhoIsWatching } from './components/Profiles'
import { useLibrary } from './components/LibraryContext'
import Home from './pages/Home'

// Everything except Home loads on demand so the first screen arrives sooner.
const TitlePage = lazy(() => import('./pages/TitlePage'))
const BrowsePage = lazy(() => import('./pages/BrowsePage'))
const SearchPage = lazy(() => import('./pages/SearchPage'))
const MyListPage = lazy(() => import('./pages/MyListPage'))
const AccountPage = lazy(() => import('./pages/AccountPage'))
const WatchPage = lazy(() => import('./pages/WatchPage'))
const AnimePage = lazy(() => import('./pages/AnimePage'))
const AnimeTitlePage = lazy(() => import('./pages/AnimeTitlePage'))
const AnimeWatchPage = lazy(() => import('./pages/AnimeWatchPage'))

function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => { window.scrollTo(0, 0) }, [pathname])
  return null
}

// Password-reset and verification emails open the account page.
function AccountLinks() {
  const lib = useLibrary()
  const navigate = useNavigate()
  useEffect(() => { if (lib.accountAction) navigate('/account') }, [lib.accountAction, navigate])
  return null
}

export default function App() {
  const { pathname } = useLocation()
  const watching = pathname.startsWith('/watch/') || /^\/anime\/\d+\/watch$/.test(pathname)
  return <>
    <a href="#main" className="skip-link">Skip to content</a>
    <ScrollToTop />
    <AccountLinks />
    {!watching && <TopBar />}
    <Suspense fallback={<main id="main" className="page"><div className="page-loading" role="status" aria-label="Loading page" /></main>}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/movies" element={<BrowsePage type="movie" />} />
        <Route path="/series" element={<BrowsePage type="series" />} />
        <Route path="/title/:id" element={<TitlePage />} />
        <Route path="/watch/:id" element={<WatchPage />} />
        <Route path="/anime" element={<AnimePage />} />
        <Route path="/anime/:id" element={<AnimeTitlePage />} />
        <Route path="/anime/:id/watch" element={<AnimeWatchPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/my-list" element={<MyListPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
    {!watching && <Footer />}
    {!watching && <TabBar />}
    {!watching && <WhoIsWatching />}
  </>
}
