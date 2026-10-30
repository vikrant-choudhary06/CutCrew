const router = require('express').Router();
const { ensureMovie, isSeries } = require('../services/movieService');
const { fetchAndAttachProviderLinks } = require('../services/providerService');
const { Movie } = require('../models');

router.get('/:imdb_id', async (req, res, next) => {
  try {
    let movie = await ensureMovie(req.params.imdb_id);
    if (isSeries(movie) && !movie.seasons?.some(s => s.episodes?.length)) {
      const enriched = await fetchAndAttachProviderLinks(movie.toObject());
      if (enriched.seasons?.length) {
        await Movie.updateOne({ imdb_id: movie.imdb_id, 'seasons.0': { $exists: false } }, { $set: {
          seasons: enriched.seasons, provider_name: enriched.provider_name,
        } });
        movie = await Movie.findOne({ imdb_id: movie.imdb_id });
      }
    }
    res.json({ status: 'success', data: movie });
  } catch (error) { next(error); }
});
module.exports = router;
