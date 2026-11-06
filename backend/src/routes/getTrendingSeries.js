const express = require('express');
const router = express.Router();
const { Movie } = require('../models');
const { trendingSelection } = require('../services/catalogueService');
const imdb = require('../services/imdbLists');

router.get('/', async (req, res, next) => {
  try {
    // IMDb's most popular TV shows right now.
    try {
      const items = await imdb.popularSeries(10);
      if (items.length >= 5) return res.status(200).json({ status: 'success', source: 'imdb', data: items });
    } catch { /* fall back to the stored and Cinemeta lists below */ }
    const stored = await Movie.find({ title_type: { $in: ['TV Series', 'TV Mini Series'] } })
      .sort({ vote_count: -1, rating: -1 })
      .limit(10);
    const { items: trendingSeries, source } = await trendingSelection('series', stored);

    return res.status(200).json({
      status: 'success',
      source,
      data: trendingSeries
    });
  } catch (error) {
    console.error('Error in getTrendingSeries route:', error);
    next(error);
  }
});

module.exports = router;
