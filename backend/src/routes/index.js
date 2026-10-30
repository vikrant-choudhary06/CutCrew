const express = require('express');
const router = express.Router();
router.use('/discover', require('./discover'));
router.get('/featured',require('./featured'));
router.use('/account', require('./account'));
router.use('/playback',require('./playbackMetrics'));

// Mount individual route files
router.use('/movies/trending', require('./getTrendingMovies'));
router.use('/series/trending', require('./getTrendingSeries'));
router.use('/movies/search', require('./searchMovies'));
router.use('/movies/scrape', require('./scrapeMovie'));
router.use('/admin', require('./admin'));
router.use('/logs', require('./logs'));
router.get('/media', require('../services/mediaService').relay);
router.get('/media/info', require('../services/mediaInfo'));
router.use('/stored-media', require('./storedMedia')); // Telegram storage gateway; 404 while disabled
router.use('/movies/play', require('./playMovie')); // Added before general /movies endpoints
router.use('/movies', require('./getAllMovies'));
router.use('/movies', require('./getMovieById')); // This will match GET /movies/:imdb_id

router.get('/health', (req, res) => {
  res.status(200).json({ status: 'success', message: 'API is running successfully' });
});
router.get('/ready',async(_req,res)=>{try{await require('../config/db').query('SELECT 1');res.json({status:'ready'});}catch{res.status(503).json({status:'unavailable'});}});

module.exports = router;
