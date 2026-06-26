import React from 'react';
import Hero from '../components/hero';
import TopSeries from '../components/topseries';
import TopMovie from '../components/topmovie';
import GenreSection from '../components/GenreSection';
import IndianMovies from '../components/indian';

const Home = () => {
  return (
    <>
      <Hero />
      <TopSeries />
      <TopMovie />
      <IndianMovies />
      <GenreSection title="Action & Adventure" genreQuery="Action,Adventure" badgeText="Adrenaline" badgeColor="bg-orange-600/20 text-orange-400 border-orange-500/30" />
      <GenreSection title="Top Comedy Hits" genreQuery="Comedy" badgeText="Laughs" badgeColor="bg-yellow-600/20 text-yellow-400 border-yellow-500/30" />
      <GenreSection title="Horror & Thrills" genreQuery="Horror" badgeText="Spooky" badgeColor="bg-red-800/20 text-red-500 border-red-700/30" />
      <GenreSection title="Anime & Animation" genreQuery="Animation" badgeText="Anime" badgeColor="bg-pink-600/20 text-pink-400 border-pink-500/30" />
    </>
  );
};

export default Home;
