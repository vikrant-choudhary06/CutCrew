const router = require('express').Router();
const { Movie } = require('../models');
const scraper = require('../services/scraperService');
const { validId } = require('../services/movieService');
router.get('/', async (req, res, next) => {
  try {
    const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
    if (!query || query.length > 150) return res.status(400).json({ error: 'Enter a search of 1–150 characters' });
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stored = await Movie.find({ title: new RegExp(escaped, 'i'), imdb_id: /^tt/ }).limit(20).lean();
    let suggestions;
    try { suggestions = await scraper.searchMovies(query, 20); }
    catch {
      if (!stored.length) return res.status(502).json({ error: 'Search service is unavailable. Please retry.' });
      suggestions = [];
    }
    const results = new Map(stored.map(movie => [movie.imdb_id, movie]));
    for (const item of suggestions) {
      const id = item.imdb_id || item.id;
      if (!validId(id) || results.has(id)) continue;
      // A suggestion is not complete metadata; "Title" does not mean "Movie".
      results.set(id, { imdb_id: id, title: item.title || item.name,
        title_type: item.title_type || '', release_year: item.release_year || item.year,
        poster_url: item.poster_url || item.image, rating: item.rating });
    }
    res.json({ status: 'success', results: results.size, data: [...results.values()] });
  } catch (error) { next(error); }
});
module.exports = router;
