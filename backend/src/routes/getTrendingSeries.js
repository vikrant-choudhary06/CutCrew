const express = require('express');
const router = express.Router();
const { Movie } = require('../models');
const { trendingSelection } = require('../services/catalogueService');

router.get('/', async (req, res, next) => {
  try {
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
