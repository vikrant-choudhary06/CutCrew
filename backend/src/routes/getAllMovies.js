const router = require('express').Router();
const { Movie } = require('../models');
const scraper = require('../services/scraperService');
const { ensureMovie, validId } = require('../services/movieService');
const pending = new Map();
const retryAt = new Map();
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function populate(genre) {
  const results = await scraper.searchByGenre(genre, 10);
  const ids = [...new Set(results.map(item => item?.node?.title?.id || item?.id || item?.imdb_id).filter(validId))].slice(0, 10);
  // Small batches avoid serial multi-minute scrapes and unrestricted upstream concurrency.
  for (let index = 0; index < ids.length; index += 4) await Promise.allSettled(ids.slice(index, index + 4).map(ensureMovie));
}
router.get('/', async (req, res, next) => {
  try {
    const { genre, country, year } = req.query;
    if ([genre, country, year].some(value => value !== undefined && (typeof value !== 'string' || value.length > 150))) {
      return res.status(400).json({ error: 'Invalid catalogue filter' });
    }
    const limit = Math.min(40, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const query = { title_type: { $nin: ['', 'Name', 'Actor', 'Person'] }, imdb_id: /^tt/ };
    if (genre) query.genres = { $in: genre.split(',').map(value => new RegExp(escape(value.trim()), 'i')) };
    if (country) query.country = { $in: country.split(',').map(value => new RegExp(escape(value.trim()), 'i')) };
    if (year) {
      if (!/^\d{4}$/.test(year)) return res.status(400).json({ error: 'Invalid release year' });
      query.release_year = Number(year);
    }
    let movies = await Movie.find(query).limit(limit).sort({ release_date: -1 });
    if (movies.length < Math.min(10, limit) && genre) {
      const primary = genre.split(',')[0].trim();
      const allowed = ['Action','Adventure','Animation','Comedy','Crime','Documentary','Drama','Family','Fantasy',
        'History','Horror','Music','Mystery','Romance','Science Fiction','Sci-Fi','TV Movie','Thriller','War','Western'];
      if (!allowed.some(value => value.toLowerCase() === primary.toLowerCase())) {
        return res.status(400).json({ error: 'Unsupported genre' });
      }
      if (!pending.has(primary) && Date.now() >= (retryAt.get(primary) || 0)) {
        retryAt.set(primary, Date.now() + 600000);
        const job = populate(primary).catch(error => console.warn('[Catalogue]', primary, error.message))
          .finally(() => pending.delete(primary));
        pending.set(primary, job);
      }
      if (pending.has(primary)) await pending.get(primary);
      movies = await Movie.find(query).limit(limit).sort({ release_date: -1 });
    }
    res.json({ status: 'success', source: 'database', results: movies.length, data: movies });
  } catch (error) { next(error); }
});
module.exports = router;
