const express = require('express');
const router = express.Router();
const { Movie } = require('../models');
const scraperService = require('../services/scraperService');
const providerService = require('../services/providerService');

router.get('/', async (req, res, next) => {
  try {
    const { query } = req.query;

    if (!query) {
      return res.status(400).json({ status: 'error', message: 'Query parameter is required' });
    }

    // 1. Check MongoDB first
    const dbMovies = await Movie.find({
      title: { $regex: new RegExp(query, 'i') },
      imdb_id: { $regex: /^tt/ }, // Ensure it's a title (tt), not a name (nm)
      title_type: { $nin: ['', 'Name', 'Actor', 'Person'] }
    }).limit(20);

    if (dbMovies.length > 0) {
      return res.status(200).json({
        status: 'success',
        source: 'database',
        results: dbMovies.length,
        data: dbMovies
      });
    }

    // 2. If not found in DB, fallback to Scraper
    console.log(`No results for '${query}' in DB. Searching scraper...`);
    let scraperResults = [];
    try {
      scraperResults = await scraperService.searchMovies(query);
    } catch (scraperErr) {
      console.log(`Scraper failed or returned error for '${query}':`, scraperErr.message);
      // Treat failure as empty results instead of crashing the API
      scraperResults = [];
    }
    
    // Check if scraper returned valid array
    if (!scraperResults || !Array.isArray(scraperResults) || scraperResults.length === 0) {
      return res.status(200).json({
        status: 'success',
        source: 'scraper',
        results: 0,
        message: 'No movies found for this query even after scraping (or scraper failed)',
        data: []
      });
    }

    // 3. Save all results from scraper to DB (Upsert)
    const savedMovies = [];
    for (const item of scraperResults) {
      // Filter out actors/names
      const itemImdbId = item.imdb_id || item.id;
      const itemTitleType = item.title_type || (item.type === 'Title' ? 'Movie' : '');
      if ((itemImdbId && itemImdbId.startsWith('nm')) || ['Name', 'Actor', 'Person'].includes(itemTitleType)) {
        continue;
      }

      // Scraper might return partial data on search, but we save what we can.
      // We map it to our schema structure.
      const movieData = {
        imdb_id: itemImdbId,
        title: item.title || item.name || "",
        original_title: item.original_title || item.name || "",
        title_type: item.title_type || (item.type === 'Title' ? 'Movie' : ''),
        release_year: item.release_year || item.year || null,
        release_date: item.release_date || "",
        runtime_minutes: item.runtime_minutes || null,
        rating: item.rating || null,
        vote_count: item.vote_count || null,
        metascore: item.metascore || null,
        genres: item.genres || [],
        country: item.country || item.countries || [],
        plot: item.plot || item.description || "",
        poster_url: item.poster_url || item.image || "",
        streaming_url: "",
        cast: (item.enhanced_actors || []).map(actor => ({
          name: actor.name,
          profile_image: actor.profile_image,
          character: actor.characters ? actor.characters[0] : ""
        })).slice(0, 10), // Limit to top 10 cast members
      };

      // Only insert if imdb_id exists
      if (movieData.imdb_id) {
        // Fetch Provider Links before saving
        const enrichedMovieData = await providerService.fetchAndAttachProviderLinks(movieData);

        const savedDoc = await Movie.findOneAndUpdate(
          { imdb_id: enrichedMovieData.imdb_id },
          enrichedMovieData,
          { returnDocument: 'after', upsert: true }
        );
        savedMovies.push(savedDoc);
      }
    }

    // 4. Return the saved movies to the frontend
    return res.status(200).json({
      status: 'success',
      source: 'scraper',
      results: savedMovies.length,
      data: savedMovies
    });

  } catch (error) {
    console.error('Error in searchMovies route:', error);
    next(error);
  }
});

module.exports = router;
