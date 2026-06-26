const express = require('express');
const router = express.Router();

// Mount individual route files
router.use('/movies/trending', require('./getTrendingMovies'));
router.use('/series/trending', require('./getTrendingSeries'));
router.use('/movies/search', require('./searchMovies'));
router.use('/movies/scrape', require('./scrapeMovie'));
router.use('/admin', require('./admin'));
router.use('/logs', require('./logs'));
router.use('/movies/play', require('./playMovie')); // Added before general /movies endpoints
router.use('/movies', require('./getAllMovies'));
router.use('/movies', require('./getMovieById')); // This will match GET /movies/:imdb_id

router.get('/health', (req, res) => {
  res.status(200).json({ status: 'success', message: 'API is running successfully' });
});

module.exports = router;
