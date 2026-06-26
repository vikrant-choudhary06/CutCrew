const express = require('express');
const router = express.Router();
const { Movie } = require('../models');

router.get('/', async (req, res, next) => {
  try {
    const trendingMovies = await Movie.find({ title_type: 'Movie' })
      .sort({ vote_count: -1, rating: -1 })
      .limit(10);

    return res.status(200).json({
      status: 'success',
      source: 'database',
      data: trendingMovies
    });
  } catch (error) {
    console.error('Error in getTrendingMovies route:', error);
    next(error);
  }
});

module.exports = router;
