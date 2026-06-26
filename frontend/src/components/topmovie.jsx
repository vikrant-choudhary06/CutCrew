import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';

const TopMovie = () => {
  const [movies, setMovies] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchTopMovies = async () => {
      try {
        const backendUrl = import.meta.env.VITE_BACKEND_URL;
        const response = await fetch(`${backendUrl}/api/movies/trending`);
        const data = await response.json();
        
        if (data.status === 'success' && data.data && data.data.length > 0) {
          setMovies(data.data);
        }
      } catch (error) {
        console.error("Error fetching top movies:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchTopMovies();
  }, []);

  if (loading) {
    return (
      <div className="mt-12 w-full animate-pulse">
        <h2 className="text-3xl font-extrabold text-white mb-6 tracking-tight px-4 md:px-8">Top 10 Trending Movies</h2>
        <div className="flex gap-4 overflow-x-auto px-4 md:px-8 pb-8 no-scrollbar">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="w-40 md:w-52 h-60 md:h-72 bg-gray-900 rounded-xl flex-shrink-0 border border-gray-800"></div>
          ))}
        </div>
      </div>
    );
  }

  if (movies.length === 0) {
    return (
      <div className="mt-12 w-full px-4 md:px-8">
        <h2 className="text-3xl font-extrabold text-white mb-6 tracking-tight">Top 10 Trending Movies</h2>
        <div className="bg-gray-900/50 rounded-2xl p-8 border border-gray-800 flex justify-center items-center">
          <p className="text-gray-400">No movies data found.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-12 w-full mb-12">
      <div className="flex items-center justify-between px-4 md:px-8 mb-6">
        <h2 className="text-3xl font-extrabold text-white tracking-tight flex items-center gap-3">
          Top 10 Trending Movies
          <span className="text-sm font-medium bg-red-600/20 text-red-400 px-3 py-1 rounded-full border border-red-500/30">
            Movies
          </span>
        </h2>
        <div className="hidden md:flex gap-2">
          <button className="text-sm text-gray-400 hover:text-white transition-colors">View All</button>
        </div>
      </div>

      <div className="flex gap-6 overflow-x-auto px-4 md:px-8 pb-8 pt-2 scroll-smooth snap-x">
        <style dangerouslySetInnerHTML={{__html: `
          .no-scrollbar::-webkit-scrollbar { display: none; }
          .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        `}} />
        
        {movies.map((movie, index) => (
          <div 
            key={movie._id || index} 
            className="group relative w-36 md:w-48 lg:w-56 shrink-0 snap-start transform transition-all duration-300 hover:-translate-y-2"
          >
            {/* Rank Badge */}
            <div className="absolute -top-3 -left-3 z-20 bg-gradient-to-br from-red-600 to-orange-600 text-white w-10 h-10 rounded-full flex items-center justify-center font-black text-xl shadow-lg border-2 border-gray-900">
              {index + 1}
            </div>

            {/* Poster Card */}
            <div className="relative rounded-2xl overflow-hidden aspect-[2/3] shadow-lg border border-gray-700 bg-gray-900">
              {movie.poster_url ? (
                <img 
                  src={movie.poster_url} 
                  alt={movie.title} 
                  className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-gray-600 p-4 text-center">
                  {movie.title}
                </div>
              )}
              
              {/* Hover Overlay */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-4">
                <h3 className="text-white font-bold text-lg line-clamp-1 mb-1">{movie.title}</h3>
                <div className="flex items-center gap-2 text-xs font-semibold">
                  {movie.rating && <span className="text-yellow-400 flex items-center gap-1">⭐ {movie.rating}</span>}
                  {movie.release_year && <span className="text-gray-300">{movie.release_year}</span>}
                </div>
                <Link to={`/movie/${movie.imdb_id}`} className="mt-3 bg-white text-black text-sm font-bold py-1.5 px-4 rounded-full w-full hover:bg-gray-200 transition-colors text-center block">
                  Details
                </Link>
              </div>
            </div>
            
            <h3 className="text-gray-200 font-semibold text-sm md:text-base mt-3 line-clamp-1 group-hover:text-red-400 transition-colors">
              {movie.title}
            </h3>
          </div>
        ))}
      </div>
    </div>
  );
};

export default TopMovie;
