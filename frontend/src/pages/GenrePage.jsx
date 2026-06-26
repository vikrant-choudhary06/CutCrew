import React from 'react';
import GenreSection from '../components/GenreSection';

const genres = [
  { name: "Action", title: "Action", badgeText: "Adrenaline", badgeColor: "bg-red-600/20 text-red-400 border-red-500/30" },
  { name: "Adventure", title: "Adventure", badgeText: "Explore", badgeColor: "bg-orange-600/20 text-orange-400 border-orange-500/30" },
  { name: "Animation", title: "Animation & Anime", badgeText: "Animated", badgeColor: "bg-pink-600/20 text-pink-400 border-pink-500/30" },
  { name: "Comedy", title: "Comedy Hits", badgeText: "Laughs", badgeColor: "bg-yellow-600/20 text-yellow-400 border-yellow-500/30" },
  { name: "Crime", title: "Crime & Gangsters", badgeText: "Crime", badgeColor: "bg-gray-700/20 text-gray-300 border-gray-600/30" },
  { name: "Documentary", title: "Documentary", badgeText: "Real Life", badgeColor: "bg-emerald-600/20 text-emerald-400 border-emerald-500/30" },
  { name: "Drama", title: "Drama", badgeText: "Emotional", badgeColor: "bg-blue-600/20 text-blue-400 border-blue-500/30" },
  { name: "Family", title: "Family Movies", badgeText: "Kids", badgeColor: "bg-cyan-600/20 text-cyan-400 border-cyan-500/30" },
  { name: "Fantasy", title: "Fantasy Worlds", badgeText: "Magic", badgeColor: "bg-fuchsia-600/20 text-fuchsia-400 border-fuchsia-500/30" },
  { name: "History", title: "Historical", badgeText: "Past", badgeColor: "bg-amber-700/20 text-amber-500 border-amber-600/30" },
  { name: "Horror", title: "Horror & Spooky", badgeText: "Scary", badgeColor: "bg-red-900/40 text-red-500 border-red-800/50" },
  { name: "Music", title: "Music & Musicals", badgeText: "Musical", badgeColor: "bg-violet-600/20 text-violet-400 border-violet-500/30" },
  { name: "Mystery", title: "Mystery", badgeText: "Suspense", badgeColor: "bg-indigo-600/20 text-indigo-400 border-indigo-500/30" },
  { name: "Romance", title: "Romance", badgeText: "Love", badgeColor: "bg-rose-600/20 text-rose-400 border-rose-500/30" },
  { name: "Science Fiction", title: "Sci-Fi", badgeText: "Future", badgeColor: "bg-sky-600/20 text-sky-400 border-sky-500/30" },
  { name: "TV Movie", title: "TV Movies", badgeText: "TV Special", badgeColor: "bg-purple-600/20 text-purple-400 border-purple-500/30" },
  { name: "Thriller", title: "Thriller", badgeText: "Edge of Seat", badgeColor: "bg-teal-600/20 text-teal-400 border-teal-500/30" },
  { name: "War", title: "War", badgeText: "Battle", badgeColor: "bg-stone-600/20 text-stone-400 border-stone-500/30" },
  { name: "Western", title: "Western", badgeText: "Cowboys", badgeColor: "bg-yellow-800/20 text-yellow-600 border-yellow-700/30" }
];

const GenrePage = () => {
  return (
    <div className="w-full pb-20">
      <div className="px-4 md:px-8 pt-6 pb-2 border-b border-gray-800 mb-8">
        <h1 className="text-4xl font-black text-white tracking-widest uppercase">Browse by Genre</h1>
        <p className="text-gray-400 mt-2">Explore all categories. Missing genres will be fetched automatically.</p>
      </div>

      {genres.map((genre) => (
        <GenreSection 
          key={genre.name}
          title={genre.title}
          genreQuery={genre.name}
          badgeText={genre.badgeText}
          badgeColor={genre.badgeColor}
        />
      ))}
    </div>
  );
};

export default GenrePage;
