const express = require('express');
const router = express.Router();
const { Movie } = require('../models');
const scraperService = require('../services/scraperService');
const providerService = require('../services/providerService');

// Define route directly on '/' since we mount it on '/:imdb_id' in index.js
// Wait, if it's mounted on '/:imdb_id', the param is defined in the parent router. 
// Standard way: `router.get('/', async(req,res))` when mounted as `app.use('/movies/:imdb_id', require('./getMovieById'))`.
// But Express params don't merge by default unless `mergeParams: true` is set.
// It's safer to just define the path here and mount it on '/movies'.
// Let's define the path here.

router.get('/:imdb_id', async (req, res, next) => {
  try {
    const { imdb_id } = req.params;

    // 1. Check DB First
    const existingMovie = await Movie.findOne({ imdb_id });
    if (existingMovie) {
      return res.status(200).json({
        status: 'success',
        source: 'database',
        data: existingMovie
      });
    }

    // 2. Fallback to Scraper if not in DB
    const scraperData = await scraperService.fetchMovieDetails(imdb_id);
    if (!scraperData || !scraperData.id) {
      return res.status(404).json({ status: 'error', message: 'Movie not found' });
    }

    // Map and save
    const movieData = {
      imdb_id: scraperData.id,
      title: scraperData.title || "",
      original_title: scraperData.original_title || "",
      title_type: scraperData.title_type || "",
      release_year: scraperData.release_year || null,
      release_date: scraperData.release_date || "",
      runtime_minutes: scraperData.runtime_minutes || null,
      rating: scraperData.rating || null,
      vote_count: scraperData.vote_count || null,
      metascore: scraperData.metascore || null,
      genres: scraperData.genres || [],
      country: scraperData.country || scraperData.countries || [],
      plot: scraperData.plot || "",
      poster_url: scraperData.poster_url || "",
      streaming_url: "",
      cast: (scraperData.enhanced_actors || []).map(actor => ({
        name: actor.name,
        profile_image: actor.profile_image,
        character: actor.characters ? actor.characters[0] : ""
      })).slice(0, 10), // Limit to top 10 cast members
    };
    
    // Fetch Provider Links before saving
    const enrichedMovieData = await providerService.fetchAndAttachProviderLinks(movieData);

    const savedMovie = await Movie.findOneAndUpdate(
      { imdb_id: enrichedMovieData.imdb_id },
      enrichedMovieData,
      { returnDocument: 'after', upsert: true }
    );
    return res.status(200).json({
      status: 'success',
      source: 'scraper',
      data: savedMovie
    });

  } catch (error) {
    console.error('Error in getMovieById route:', error);
    next(error);
  }
});

module.exports = router;
