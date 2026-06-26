import { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Navbar from './components/navbar';
import Home from './pages/Home';
import GenrePage from './pages/GenrePage';
import SearchPage from './pages/SearchPage';
import MovieDetail from './pages/MovieDetail';

function App() {
  // Global heartbeat to track online users
  useEffect(() => {
    const backendUrl = import.meta.env.VITE_BACKEND_URL;
    const ping = () => fetch(`${backendUrl}/api/admin/heartbeat`, { method: 'POST' }).catch(() => {});
    ping(); // initial ping
    const interval = setInterval(ping, 15000); // ping every 15s
    return () => clearInterval(interval);
  }, []);

  return (
    <BrowserRouter>
      <Navbar>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/genres" element={<GenrePage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/movie/:id" element={<MovieDetail />} />
        </Routes>
      </Navbar>
    </BrowserRouter>
  )
}

export default App




