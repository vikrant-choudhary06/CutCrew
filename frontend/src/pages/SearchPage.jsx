import React, { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';

const SearchPage = () => {
  const [searchParams] = useSearchParams();
  const query = searchParams.get('q') || '';
  
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  useEffect(() => {
    const fetchSearchResults = async () => {
      if (!query.trim()) {
        setItems([]);
        setHasSearched(false);
        return;
      }

      setLoading(true);
      setHasSearched(true);
      setItems([]); // Clear previous results while loading

      try {
        const backendUrl = import.meta.env.VITE_BACKEND_URL;
        // This endpoint has fallback scraping logic built-in!
        const response = await fetch(`${backendUrl}/api/movies/search?query=${encodeURIComponent(query)}`);
        const data = await response.json();
        
        if (data.status === 'success' && data.data) {
          setItems(data.data);
        } else {
          setItems([]);
        }
      } catch (error) {
        console.error(`Error searching for ${query}:`, error);
        setItems([]);
      } finally {
        setLoading(false);
      }
    };

    fetchSearchResults();
  }, [query]);

  return (
    <div className="w-full pb-20">
      <div className="px-4 md:px-8 pt-6 pb-2 border-b border-gray-800 mb-8">
        <h1 className="text-4xl font-black text-white tracking-widest uppercase">Search Results</h1>
        <p className="text-gray-400 mt-2">
          {query ? `Showing results for "${query}"` : "Enter a search term in the top bar to find movies and series."}
        </p>
      </div>

      {loading && (
        <div className="px-4 md:px-8 w-full">
          <div className="animate-pulse flex flex-col gap-4">
            <div className="h-8 w-64 bg-gray-800 rounded"></div>
            <div className="flex flex-wrap gap-6">
              {[...Array(10)].map((_, i) => (
                <div key={i} className="w-36 md:w-48 lg:w-56 h-56 md:h-72 bg-gray-900 rounded-xl border border-gray-800"></div>
              ))}
            </div>
            <p className="text-gray-500 text-sm mt-4 italic">Searching database... if not found, we are scraping the internet for you!</p>
          </div>
        </div>
      )}

      {!loading && hasSearched && items.length === 0 && (
        <div className="px-4 md:px-8 text-center py-20">
          <h2 className="text-2xl font-bold text-gray-500">No results found for "{query}"</h2>
          <p className="text-gray-600 mt-2">We couldn't find any movies or series matching your search, even after checking external sources.</p>
        </div>
      )}

      {!loading && items.length > 0 && (
        <div className="px-4 md:px-8 flex flex-wrap gap-6">
          {items.map((item, index) => (
            <div 
              key={item._id || index} 
              className="group relative w-36 md:w-48 lg:w-56 shrink-0 transform transition-all duration-300 hover:-translate-y-2"
            >
              {/* Poster Card */}
              <div className="relative rounded-2xl overflow-hidden aspect-[2/3] shadow-lg border border-gray-700 bg-gray-900">
                {item.poster_url ? (
                  <img 
                    src={item.poster_url} 
                    alt={item.title} 
                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-gray-600 p-4 text-center">
                    {item.title}
                  </div>
                )}
                
                {/* Type Badge */}
                <div className="absolute top-2 right-2 z-20 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-black/60 text-white backdrop-blur-sm border border-white/10">
                  {item.title_type === 'Movie' ? 'Movie' : 'Series'}
                </div>

                {/* Hover Overlay */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-4">
                  <h3 className="text-white font-bold text-lg line-clamp-1 mb-1">{item.title}</h3>
                  <div className="flex items-center gap-2 text-xs font-semibold">
                    {item.rating && <span className="text-yellow-400 flex items-center gap-1">⭐ {item.rating}</span>}
                    {item.release_year && <span className="text-gray-300">{item.release_year}</span>}
                  </div>
                  <Link to={`/movie/${item.imdb_id}`} className="mt-3 bg-white text-black text-sm font-bold py-1.5 px-4 rounded-full w-full hover:bg-gray-200 transition-colors text-center block">
                    Details
                  </Link>
                </div>
              </div>
              
              <h3 className="text-gray-200 font-semibold text-sm md:text-base mt-3 line-clamp-1 group-hover:text-blue-400 transition-colors">
                {item.title}
              </h3>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default SearchPage;
