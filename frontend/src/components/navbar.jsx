import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import '../css/navbar.css';

const Navbar = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  
  const isActive = (path) => location.pathname === path ? "bg-gray-800 text-purple-400" : "text-white hover:bg-gray-800 hover:text-purple-400";

  const handleSearch = (e) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
    }
  };

  return (
    <div className="flex h-screen w-full bg-black text-white font-sans">
      {/* Sidebar (Left Navbar) */}
      <aside className="w-64 border-r border-gray-800 flex flex-col justify-between shrink-0">
        <div>
          {/* Logo Area */}
          <div className="h-16 flex items-center justify-center border-b border-gray-800">
            <h1 className="text-xl font-bold tracking-widest uppercase">CUT CREW</h1>
          </div>
          
          {/* Navigation Links */}
          <nav className="p-4 space-y-2 mt-4 flex flex-col">
            <Link to="/" className={`px-6 py-3 text-lg font-medium rounded-lg transition-colors ${isActive('/')}`}>HOME</Link>
            <Link to="/genres" className={`px-6 py-3 text-lg font-medium rounded-lg transition-colors ${isActive('/genres')}`}>GENRE</Link>
            <Link to="/watchlist" className={`px-6 py-3 text-lg font-medium rounded-lg transition-colors ${isActive('/watchlist')}`}>WATCHLIST</Link>
          </nav>
        </div>

        {/* Profile Area */}
        <div className="p-4 border-t border-gray-800">
          <a href="#" className="flex justify-center px-6 py-3 text-lg font-medium hover:bg-gray-800 hover:text-purple-400 rounded-lg transition-colors">PROFILE</a>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Topbar (Uper wala section) */}
        <header className="h-16 border-b border-gray-800 flex items-center justify-end px-8 shrink-0">
          <div className="flex items-center gap-6">
            {/* Search Bar */}
            <form onSubmit={handleSearch} className="relative">
              <input 
                type="text" 
                placeholder="Search movies, series..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-gray-900 border border-gray-700 text-white text-sm rounded-full focus:ring-purple-500 focus:border-purple-500 block w-64 px-4 py-2 outline-none transition-all"
              />
            </form>
            {/* Sign In button */}
            <button className="text-sm font-bold bg-purple-600 hover:bg-purple-700 px-6 py-2 rounded-full transition-colors uppercase tracking-wider">
              Sign In
            </button>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 p-8 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
};

export default Navbar;
