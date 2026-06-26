import React, { useState, useEffect } from 'react';
import '../css/hero.css';

const Hero = () => {
  const [movies, setMovies] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchTrendingMovies = async () => {
      try {
        const backendUrl = import.meta.env.VITE_BACKEND_URL;
        const response = await fetch(`${backendUrl}/api/movies/trending`);
        const data = await response.json();
        if (data.status === 'success' && data.data && data.data.length > 0) {
          setMovies(data.data);
        }
      } catch (error) {
        console.error("Error fetching trending movies:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchTrendingMovies();
  }, []);

  const handleNext = () => {
    setCurrentIndex((prevIndex) => (prevIndex + 1) % movies.length);
  };

  const handlePrev = () => {
    setCurrentIndex((prevIndex) => (prevIndex === 0 ? movies.length - 1 : prevIndex - 1));
  };

  if (loading) {
    return (
      <div className="w-full h-72 md:h-96 rounded-3xl bg-gray-900 animate-pulse border border-gray-800 flex items-center justify-center shadow-2xl">
        <p className="text-gray-500 font-medium tracking-widest uppercase">Loading trending...</p>
      </div>
    );
  }

  if (movies.length === 0) {
    return (
      <div className="w-full h-72 md:h-96 rounded-3xl bg-gray-900 border border-gray-800 flex flex-col justify-center px-10 md:px-16 shadow-2xl relative overflow-hidden">
         <div className="relative z-10">
          <h2 className="text-4xl md:text-5xl font-extrabold text-white mb-4 tracking-tight">No Trending Movies Found</h2>
          <p className="text-gray-400">Please make sure the backend is populated with data.</p>
         </div>
      </div>
    );
  }

  const currentMovie = movies[currentIndex];
  
  // Use poster_url for background if available, else fallback to a cinematic image
  const bgStyle = currentMovie.poster_url 
    ? { backgroundImage: `url(${currentMovie.poster_url})` } 
    : { backgroundImage: `url('https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?q=80&w=2070&auto=format&fit=crop')` };

  return (
    <div className="flex flex-col gap-4">
      {/* Hero Section Card */}
      <div className="w-full h-72 md:h-96 rounded-3xl bg-gray-900 border border-gray-700 flex flex-col justify-center px-10 md:px-16 shadow-2xl relative overflow-hidden transition-all duration-500">
        
        {/* Dynamic background image based on movie poster */}
        <div 
          className="absolute inset-0 bg-cover bg-center opacity-60 transition-all duration-700" 
          style={bgStyle}
        ></div>
        
        {/* Gradient Overlay for text readability */}
        <div className="absolute inset-0 bg-gradient-to-r from-black/90 via-black/60 to-transparent md:to-black/20"></div>
        
        <div className="relative z-10 flex flex-col md:flex-row items-center justify-between w-full h-full gap-8">
          {/* Left Side: Text and Content */}
          <div className="flex-1 max-w-2xl">
            <div className="flex items-center gap-3 mb-3">
              <span className="bg-purple-600 text-white text-xs font-bold px-2 py-1 rounded uppercase tracking-widest shadow-md">
                Trending #{currentIndex + 1}
              </span>
              {currentMovie.rating && (
                <span className="text-yellow-400 text-sm font-bold flex items-center gap-1 drop-shadow-md">
                  ⭐ {currentMovie.rating}
                </span>
              )}
              {currentMovie.release_year && (
                <span className="text-gray-400 text-sm font-medium">
                  {currentMovie.release_year}
                </span>
              )}
            </div>

            <h2 className="text-4xl md:text-5xl font-extrabold text-white mb-4 tracking-tight line-clamp-1 drop-shadow-lg">
              {currentMovie.title}
            </h2>
            
            <p className="text-lg text-gray-300 mb-8 leading-relaxed line-clamp-2 md:line-clamp-3 drop-shadow-md">
              {currentMovie.plot || "No description available for this movie."}
            </p>
            
            <div className="flex gap-4">
              <button className="bg-white text-black font-bold px-8 py-3 rounded-full hover:bg-gray-200 transition-all transform hover:scale-105 shadow-lg">
                Watch Now
              </button>
              <button className="bg-gray-800/80 backdrop-blur-md text-white font-bold px-8 py-3 rounded-full border border-gray-600 hover:bg-gray-700 transition-all shadow-lg">
                More Info
              </button>
            </div>
          </div>

          {/* Right Side: Distinct Movie Poster */}
          {currentMovie.poster_url && (
            <div className="hidden md:block w-40 lg:w-52 shrink-0 relative group perspective">
              <div className="absolute inset-0 bg-purple-500 rounded-xl blur-xl opacity-20 group-hover:opacity-40 transition-opacity duration-500"></div>
              <img 
                src={currentMovie.poster_url} 
                alt={currentMovie.title} 
                className="w-full rounded-xl shadow-[0_20px_50px_rgba(0,0,0,0.7)] transform transition-transform duration-500 group-hover:scale-105 group-hover:rotate-2 border border-gray-700 relative z-10"
              />
            </div>
          )}
        </div>
      </div>

      {/* Carousel / Slider Controls */}
      <div className="flex justify-end px-2">
        <div className="flex items-center gap-1 border border-gray-700 bg-gray-900/80 backdrop-blur-sm rounded-xl p-1 shadow-lg">
          <button 
            onClick={handlePrev}
            className="p-2 hover:bg-gray-700 rounded-lg transition-colors text-gray-300 hover:text-white group"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 transform group-hover:-translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="w-px h-6 bg-gray-600"></div>
          <button 
            onClick={handleNext}
            className="p-2 hover:bg-gray-700 rounded-lg transition-colors text-gray-300 hover:text-white group"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 transform group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};

export default Hero;

