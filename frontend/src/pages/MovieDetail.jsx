import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

const MovieDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [movie, setMovie] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  
  // Streaming state
  const [isStreamLoading, setIsStreamLoading] = useState(false);
  const [streamUrl, setStreamUrl] = useState('');
  const [streamError, setStreamError] = useState('');

  // Series state
  const [selectedSeason, setSelectedSeason] = useState(null);
  const [currentPlayingEpisode, setCurrentPlayingEpisode] = useState(null);

  const isSeries = movie && (movie.title_type || '').toLowerCase().match(/tv|series|episode/);
  const seasons = movie?.seasons || [];
  
  useEffect(() => {
    if (isSeries && seasons.length > 0 && selectedSeason === null) {
      setSelectedSeason(seasons[0].season_number);
    }
  }, [isSeries, seasons, selectedSeason]);

  const activeSeasonData = seasons.find(s => s.season_number === selectedSeason);

  const handlePlayClick = async (seasonNum = null, episodeNum = null) => {
    try {
      setStreamError('');
      setStreamUrl('');
      setIsStreamLoading(true);
      
      if (seasonNum && episodeNum) {
        setCurrentPlayingEpisode({ season: seasonNum, episode: episodeNum });
      }

      const backendUrl = import.meta.env.VITE_BACKEND_URL;
      let url = `${backendUrl}/api/movies/play/${id}`;
      
      if (isSeries && seasonNum && episodeNum) {
        url += `?season=${seasonNum}&episode=${episodeNum}`;
      }

      const response = await fetch(url);
      const data = await response.json();

      if (response.ok && Array.isArray(data) && data.length > 0) {
        // Assume provider returns array of objects with a link property, or strings
        const playableLink = data[0].link || data[0].url || data[0]; 
        setStreamUrl(playableLink);
        
        // Scroll to player smoothly
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        setStreamError(data.error || 'Stream temporarily unavailable');
      }
    } catch (err) {
      console.error("Error fetching stream:", err);
      setStreamError('Stream temporarily unavailable');
    } finally {
      setIsStreamLoading(false);
    }
  };

  const handleNextEpisode = () => {
    if (!currentPlayingEpisode || !activeSeasonData) return;
    const nextEpNum = currentPlayingEpisode.episode + 1;
    const nextEp = activeSeasonData.episodes.find(e => e.episode_number === nextEpNum);
    if (nextEp) {
      handlePlayClick(currentPlayingEpisode.season, nextEpNum);
    }
  };

  const handlePrevEpisode = () => {
    if (!currentPlayingEpisode || !activeSeasonData) return;
    const prevEpNum = currentPlayingEpisode.episode - 1;
    const prevEp = activeSeasonData.episodes.find(e => e.episode_number === prevEpNum);
    if (prevEp) {
      handlePlayClick(currentPlayingEpisode.season, prevEpNum);
    }
  };

  useEffect(() => {
    const fetchMovie = async () => {
      try {
        const backendUrl = import.meta.env.VITE_BACKEND_URL;
        const response = await fetch(`${backendUrl}/api/movies/${id}`);
        const data = await response.json();

        if (response.ok && data.status === 'success' && data.data) {
          setMovie(data.data);
        } else {
          setError(data.message || 'Failed to load movie details');
        }
      } catch (err) {
        console.error("Error fetching movie details:", err);
        setError('Error connecting to the server');
      } finally {
        setLoading(false);
      }
    };

    fetchMovie();
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-black text-white pt-24 pb-12 px-4 md:px-8 flex justify-center items-center">
        <div className="animate-pulse flex flex-col md:flex-row gap-8 w-full max-w-6xl">
          <div className="w-full md:w-1/3 h-[500px] bg-gray-900 rounded-2xl border border-gray-800"></div>
          <div className="w-full md:w-2/3 flex flex-col gap-6 pt-4">
            <div className="h-12 bg-gray-900 rounded-xl w-3/4"></div>
            <div className="flex gap-4">
              <div className="h-6 bg-gray-900 rounded w-20"></div>
              <div className="h-6 bg-gray-900 rounded w-20"></div>
              <div className="h-6 bg-gray-900 rounded w-20"></div>
            </div>
            <div className="h-32 bg-gray-900 rounded-xl w-full"></div>
            <div className="h-12 bg-gray-900 rounded-full w-48 mt-4"></div>
          </div>
        </div>
      </div>
    );
  }

  if (error || !movie) {
    return (
      <div className="min-h-screen bg-black text-white pt-24 pb-12 px-4 md:px-8 flex flex-col justify-center items-center">
        <h2 className="text-3xl font-bold mb-4 text-red-500">Oops!</h2>
        <p className="text-gray-400 mb-8">{error || 'Movie not found'}</p>
        <button 
          onClick={() => navigate('/')}
          className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded-full transition-colors"
        >
          Go Back Home
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white pb-12 relative">
      {/* Dynamic Background Blur */}
      <div className="absolute inset-0 h-[70vh] overflow-hidden pointer-events-none">
        <div 
          className="absolute inset-0 opacity-20 bg-cover bg-center blur-3xl scale-110"
          style={{ backgroundImage: `url(${movie.poster_url})` }}
        ></div>
        <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black to-black"></div>
      </div>

      <div className="relative pt-28 px-4 md:px-12 max-w-7xl mx-auto">
        <button 
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors mb-8 group"
        >
          <span className="transform group-hover:-translate-x-1 transition-transform">←</span> Back
        </button>

        {/* Video Player Section */}
        {(streamUrl || isStreamLoading) && (
          <div className="w-full mb-10 bg-black rounded-2xl overflow-hidden shadow-2xl border border-gray-800 relative aspect-video flex flex-col items-center justify-center">
            {isStreamLoading ? (
              <div className="flex flex-col items-center gap-4 flex-grow justify-center py-20">
                <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
                <p className="text-blue-400 font-semibold animate-pulse">Loading Stream...</p>
              </div>
            ) : (
              <>
                <video 
                  src={streamUrl} 
                  controls 
                  autoPlay 
                  className="w-full h-full object-contain bg-black"
                >
                  Your browser does not support HTML5 video.
                </video>
                
                {/* Player Controls for Series */}
                {isSeries && currentPlayingEpisode && activeSeasonData && (
                  <div className="absolute bottom-16 left-0 right-0 px-8 flex justify-between pointer-events-none">
                    <button 
                      onClick={handlePrevEpisode}
                      disabled={!activeSeasonData.episodes.find(e => e.episode_number === currentPlayingEpisode.episode - 1)}
                      className="pointer-events-auto bg-black/60 hover:bg-blue-600 text-white px-4 py-2 rounded-lg backdrop-blur disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                      ← Prev Ep
                    </button>
                    <button 
                      onClick={handleNextEpisode}
                      disabled={!activeSeasonData.episodes.find(e => e.episode_number === currentPlayingEpisode.episode + 1)}
                      className="pointer-events-auto bg-black/60 hover:bg-blue-600 text-white px-4 py-2 rounded-lg backdrop-blur disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                      Next Ep →
                    </button>
                  </div>
                )}
              </>
            )}
            
            {!isStreamLoading && (
              <button 
                onClick={() => setStreamUrl('')}
                className="absolute top-4 right-4 bg-black/50 hover:bg-red-600 text-white w-10 h-10 rounded-full flex items-center justify-center transition-colors backdrop-blur-md z-10"
              >
                ✕
              </button>
            )}
          </div>
        )}

        <div className="flex flex-col md:flex-row gap-10 lg:gap-16">
          {/* Poster Column */}
          <div className="w-full md:w-1/3 lg:w-1/4 shrink-0">
            <div className="rounded-2xl overflow-hidden shadow-2xl border border-gray-800 shadow-blue-900/20 aspect-[2/3]">
              {movie.poster_url ? (
                <img 
                  src={movie.poster_url} 
                  alt={movie.title} 
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full bg-gray-900 flex items-center justify-center text-gray-500">
                  No Poster
                </div>
              )}
            </div>
          </div>

          {/* Details Column */}
          <div className="w-full md:w-2/3 lg:w-3/4 flex flex-col justify-center">
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-extrabold tracking-tight mb-2">
              {movie.title}
            </h1>
            
            {movie.original_title && movie.original_title !== movie.title && (
              <h2 className="text-xl text-gray-400 mb-6 font-medium">
                {movie.original_title}
              </h2>
            )}

            <div className="flex flex-wrap items-center gap-4 text-sm font-semibold text-gray-300 mb-8">
              {movie.release_year && (
                <div className="bg-gray-900/80 px-3 py-1 rounded border border-gray-700">
                  {movie.release_year}
                </div>
              )}
              
              {movie.runtime_minutes && (
                <div className="bg-gray-900/80 px-3 py-1 rounded border border-gray-700 flex items-center gap-1">
                  ⏱ {movie.runtime_minutes} min
                </div>
              )}

              {movie.rating && (
                <div className="bg-yellow-900/20 text-yellow-500 px-3 py-1 rounded border border-yellow-700/50 flex items-center gap-1">
                  ⭐ {movie.rating}/10
                </div>
              )}

              {movie.metascore && (
                <div className="bg-green-900/20 text-green-500 px-3 py-1 rounded border border-green-700/50 flex items-center gap-1">
                  Ⓜ️ {movie.metascore}
                </div>
              )}
              
              {movie.title_type && (
                <div className="bg-blue-900/20 text-blue-400 px-3 py-1 rounded border border-blue-700/50 uppercase tracking-wider text-[10px]">
                  {movie.title_type}
                </div>
              )}
            </div>

            {movie.genres && movie.genres.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-8">
                {movie.genres.map(genre => (
                  <span key={genre} className="text-sm px-4 py-1.5 rounded-full border border-gray-600 bg-gray-800 text-gray-200">
                    {genre}
                  </span>
                ))}
              </div>
            )}

            <div className="mb-10 max-w-3xl">
              <h3 className="text-xl font-bold text-gray-200 mb-3">Plot</h3>
              <p className="text-gray-400 leading-relaxed text-lg">
                {movie.plot || 'No plot available for this.'}
              </p>
            </div>

            {movie.country && movie.country.length > 0 && (
              <div className="mb-10 max-w-3xl">
                <h3 className="text-lg font-bold text-gray-300 mb-2">Country</h3>
                <p className="text-gray-400 font-medium">
                  {movie.country.join(', ')}
                </p>
              </div>
            )}

            {/* --- TV Series: Seasons and Episodes Section --- */}
            {isSeries && seasons && seasons.length > 0 && (
              <div className="mb-10 w-full max-w-3xl">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-2xl font-bold text-white">Episodes</h3>
                  <select 
                    value={selectedSeason || ''} 
                    onChange={(e) => setSelectedSeason(Number(e.target.value))}
                    className="bg-gray-800 border border-gray-700 text-white rounded-lg px-4 py-2 focus:outline-none focus:border-blue-500 font-medium"
                  >
                    {seasons.map(s => (
                      <option key={s.season_number} value={s.season_number}>
                        Season {s.season_number}
                      </option>
                    ))}
                  </select>
                </div>
                
                <div className="bg-gray-900/50 border border-gray-800 rounded-xl overflow-hidden">
                  <div className="max-h-96 overflow-y-auto no-scrollbar">
                    {activeSeasonData?.episodes?.map((ep) => {
                      const isPlaying = currentPlayingEpisode?.season === activeSeasonData.season_number && 
                                        currentPlayingEpisode?.episode === ep.episode_number;
                      return (
                        <div 
                          key={ep.episode_number}
                          onClick={() => handlePlayClick(activeSeasonData.season_number, ep.episode_number)}
                          className={`flex items-center gap-4 p-4 border-b border-gray-800 hover:bg-gray-800/80 cursor-pointer transition-colors ${isPlaying ? 'bg-blue-900/20 border-l-4 border-l-blue-500' : 'border-l-4 border-l-transparent'}`}
                        >
                          <div className="w-12 h-12 rounded-lg bg-gray-800 flex items-center justify-center font-bold text-gray-400 shrink-0">
                            E{ep.episode_number}
                          </div>
                          <div className="flex-grow">
                            <h4 className={`font-semibold ${isPlaying ? 'text-blue-400' : 'text-gray-200'}`}>
                              {ep.title}
                            </h4>
                          </div>
                          <div className="shrink-0 text-blue-500">
                            {isPlaying ? (
                              <span className="flex items-center gap-2 text-sm font-bold">
                                <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></span>
                                Playing
                              </span>
                            ) : (
                              <button className="opacity-0 group-hover:opacity-100 p-2 hover:bg-blue-600/20 rounded-full transition-all">
                                ▶
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            )}
            
            {isSeries && (!seasons || seasons.length === 0) && (
              <div className="mb-10 p-4 bg-gray-900 border border-gray-800 rounded-xl text-gray-400">
                No episodes found for this series.
              </div>
            )}

            {/* --- Action Buttons --- */}
            <div className="flex flex-col gap-4 mt-auto">
              <div className="flex flex-wrap gap-4">
                {!isSeries && (
                  <button 
                    onClick={() => handlePlayClick()}
                    disabled={isStreamLoading}
                    className="bg-blue-600 text-white font-bold py-3 px-8 rounded-full hover:bg-blue-500 hover:scale-105 transition-all shadow-lg shadow-blue-500/30 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isStreamLoading ? 'Loading Movie...' : '▶ Play Movie'}
                  </button>
                )}
                
                <button className="bg-gray-800 text-white font-bold py-3 px-8 rounded-full hover:bg-gray-700 transition-colors border border-gray-700 flex items-center gap-2">
                  + Add to Watchlist
                </button>
              </div>
              
              {streamError && (
                <div className="text-red-500 bg-red-900/20 border border-red-900 p-3 rounded-lg text-sm max-w-md">
                  {streamError}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Cast Section */}
        {movie.cast && movie.cast.length > 0 && (
          <div className="mt-20">
            <h2 className="text-2xl font-bold text-white mb-6 pl-2 border-l-4 border-blue-600">Top Cast</h2>
            <div className="flex gap-6 overflow-x-auto pb-6 scroll-smooth snap-x no-scrollbar">
              <style dangerouslySetInnerHTML={{__html: `
                .no-scrollbar::-webkit-scrollbar { display: none; }
                .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
              `}} />
              {movie.cast.map((actor, idx) => (
                <div key={idx} className="w-32 md:w-40 shrink-0 snap-start group text-center">
                  <div className="w-24 h-24 md:w-32 md:h-32 mx-auto rounded-full overflow-hidden mb-4 border-2 border-gray-800 group-hover:border-blue-500 transition-colors bg-gray-900 shadow-lg">
                    {actor.profile_image ? (
                      <img 
                        src={actor.profile_image} 
                        alt={actor.name}
                        className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-gray-500 text-3xl bg-gray-800">
                        {actor.name.charAt(0)}
                      </div>
                    )}
                  </div>
                  <h4 className="font-bold text-gray-200 text-sm md:text-base leading-tight mb-1">{actor.name}</h4>
                  {actor.character && (
                    <p className="text-xs text-gray-500 italic line-clamp-2">{actor.character}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default MovieDetail;
