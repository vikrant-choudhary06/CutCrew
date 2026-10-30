const router = require('express').Router();
const scraper = require('../services/scraperService');
const genres = ['Action','Adventure','Animation','Comedy','Crime','Documentary','Drama','Family','Fantasy','History','Horror','Music','Mystery','Romance','Sci-Fi','Thriller','War','Western'];
const cache = new Map(), pending = new Map();
router.get('/', async (req, res, next) => {
  try {
    const type = req.query.type || 'movie', genre = req.query.genre || '';
    const page = Number(req.query.page || 1), limit = Number(req.query.limit || 18);
    if (!['movie','series'].includes(type) || (genre && !genres.includes(genre)) ||
        !Number.isInteger(page) || page < 1 || page > 100 || !Number.isInteger(limit) || limit < 1 || limit > 24 ||
        [req.query.type,req.query.genre,req.query.page,req.query.limit].some(value => value !== undefined && typeof value !== 'string')) {
      return res.status(400).json({ message: 'Invalid discovery filter or page' });
    }
    const key = `${type}:${genre}:${page}:${limit}`;
    let entry = cache.get(key);
    if (!entry || entry.expires <= Date.now()) {
      if (!pending.has(key)) {
        const work = scraper.fetchDiscover(type, genre, (page - 1) * limit).then(items => {
          const result = { data: items.slice(0, limit), hasMore: items.length > limit, expires: Date.now() + 300000 };
          if (cache.size >= 100) cache.delete(cache.keys().next().value);
          cache.set(key, result); return result;
        }).finally(() => pending.delete(key));
        pending.set(key, work);
      }
      entry = await pending.get(key);
    }
    res.json({ status: 'success', source: 'cinemeta', data: entry.data, page, hasMore: entry.hasMore });
  } catch { next(Object.assign(new Error('Discovery is temporarily unavailable. Please retry.'), { status: 502 })); }
});
module.exports = router;
