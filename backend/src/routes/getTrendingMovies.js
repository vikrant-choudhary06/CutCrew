const express = require('express');
const router = express.Router();
const { Movie } = require('../models');
const { trendingSelection } = require('../services/catalogueService');
const imdb = require('../services/imdbLists');

router.get('/', async (req, res, next) => {
  try {
    // Most popular movies released in the last four months (IMDb popularity).
    try {
      const { items } = await imdb.popularNew({ type: 'movie', perPage: 10 });
      if (items.length >= 5) return res.status(200).json({ status: 'success', source: 'imdb', data: items });
    } catch { /* fall back to the stored and Cinemeta lists below */ }
    const stored = await Movie.find({ title_type: 'Movie' })
      .sort({ vote_count: -1, rating: -1 })
      .limit(10);
    const { items: trendingMovies, source } = await trendingSelection('movie', stored);

    return res.status(200).json({
      status: 'success',
      source,
      data: trendingMovies
    });
  } catch (error) {
    console.error('Error in getTrendingMovies route:', error);
    next(error);
  }
});

module.exports = router;
