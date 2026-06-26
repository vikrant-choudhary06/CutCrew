const express = require('express');
const router = express.Router();
const { Movie } = require('../models');

router.get('/', async (req, res, next) => {
  try {
    const trendingSeries = await Movie.find({ title_type: { $in: ['TV Series', 'TV Mini Series'] } })
      .sort({ vote_count: -1, rating: -1 })
      .limit(10);

    return res.status(200).json({
      status: 'success',
      source: 'database',
      data: trendingSeries
    });
  } catch (error) {
    console.error('Error in getTrendingSeries route:', error);
    next(error);
  }
});

module.exports = router;
