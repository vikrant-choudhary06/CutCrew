import { useEffect, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import Icon from './Icon'
import { useLibrary } from './LibraryContext'

// Wordmark: "Cut" and "Crew" split by a slanted marigold cut, like a splice mark.
export function Logo() {
  return <Link to="/" className="logo" aria-label="CutCrew home"><span>Cut</span><span className="logo-cut" aria-hidden="true" /><span>Crew</span></Link>
}

function ProfileButton() {
  const lib = useLibrary()
  const profile = lib.auth?.profiles.find(p => p.id === lib.profile)
  const label = profile ? `Account: ${profile.name}` : 'Sign in or manage account'
  return <Link to="/account" className="profile-button" aria-label={label} title={label}>
    {profile ? <span className="avatar" data-tone={profile.name.charCodeAt(0) % 4}>{profile.name.slice(0, 1).toUpperCase()}</span> : <Icon name="user" />}
  </Link>
}

export function TopBar() {
  const { pathname } = useLocation()
  const [solid, setSolid] = useState(false)
  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 24)
    onScroll(); window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [pathname])
  const overlay = pathname === '/' || pathname.startsWith('/title/')
  return <header className={`topbar ${overlay && !solid ? 'topbar--clear' : ''}`}>
    <Logo />
    <nav className="topnav" aria-label="Main">
      <NavLink to="/" end>Home</NavLink>
      <NavLink to="/movies">Movies</NavLink>
      <NavLink to="/series">Series</NavLink>
      <NavLink to="/my-list">My List</NavLink>
    </nav>
    <div className="topbar-actions">
      <NavLink to="/search" className="icon-button" aria-label="Search"><Icon name="search" /></NavLink>
      <ProfileButton />
    </div>
  </header>
}

// Phone navigation: four labelled destinations, thumb-reachable.
export function TabBar() {
  const items = [['/', 'home', 'Home'], ['/search', 'search', 'Search'], ['/my-list', 'list', 'My List'], ['/account', 'user', 'Profile']]
  return <nav className="tabbar" aria-label="Main">
    {items.map(([to, icon, label]) => <NavLink key={to} to={to} end={to === '/'}><Icon name={icon} size={22} /><span>{label}</span></NavLink>)}
  </nav>
}

export function Footer() {
  return <footer className="footer">
    <Logo />
    <nav aria-label="Footer">
      <Link to="/movies">Movies</Link><Link to="/series">Series</Link><Link to="/my-list">My List</Link><Link to="/account">Account</Link>
    </nav>
    <p>Titles and artwork come from public catalogues. Playback uses CutCrew's own copies where available, otherwise linked sources.</p>
  </footer>
}

// Page-level status for loading, empty and error moments.
export function Notice({ title, children, action }) {
  return <div className="notice"><h2>{title}</h2>{children && <p>{children}</p>}{action}</div>
}
