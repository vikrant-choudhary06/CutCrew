const express = require('express');
const router = express.Router();
const { Movie } = require('../models');
const { trendingSelection } = require('../services/catalogueService');

router.get('/', async (req, res, next) => {
  try {
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
