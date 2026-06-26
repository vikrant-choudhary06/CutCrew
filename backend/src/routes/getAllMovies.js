const express = require('express');
const router = express.Router();
const { Movie } = require('../models');
const scraperService = require('../services/scraperService');
router.get('/', async (req, res, next) => {
  try {
    const { genre, year, country, limit = 20 } = req.query;
    
    // Build query
    let query = {};
    if (genre) {
      const genreList = genre.split(',').map(g => new RegExp(g.trim(), 'i'));
      query.genres = { $in: genreList }; 
    }
    if (country) {
      const countryList = country.split(',').map(c => new RegExp(c.trim(), 'i'));
      query.country = { $in: countryList };
    }
    if (year) {
      query.release_year = year;
    }
    
    // Exclude actors and empty title types
    query.title_type = { $nin: ['', 'Name', 'Actor', 'Person'] };
    query.imdb_id = { $regex: /^tt/ }; // Ensure it's a title (tt), not a name (nm)

    let movies = await Movie.find(query).limit(Number(limit)).sort({ release_date: -1 });

    // Fallback live scrape if fewer than 10 movies and we are filtering by genre
    if (movies.length < 10 && genre) {
      console.log(`Not enough movies for genre '${genre}'. Scraping live...`);
      const primaryGenre = genre.split(',')[0].trim();
      
      try {
        const scraperResults = await scraperService.searchByGenre(primaryGenre, 15);
        if (scraperResults && scraperResults.length > 0) {
          console.log(`Scraper found ${scraperResults.length} movies for genre ${primaryGenre}. Fetching details...`);
          
          for (let i = 0; i < scraperResults.length; i++) {
            const item = scraperResults[i];
            const imdbId = item?.node?.title?.id || item?.id || item?.imdb_id;
            
            // Skip if no ID or if it's a person/name (nm)
            if (!imdbId || imdbId.startsWith('nm')) continue;
            
            try {
               const existing = await Movie.findOne({ imdb_id: imdbId });
               if (existing) continue;

               const scraperData = await scraperService.fetchMovieDetails(imdbId);
               
               if (scraperData && scraperData.id) {
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
                 await Movie.findOneAndUpdate(
                   { imdb_id: movieData.imdb_id },
                   movieData,
                   { returnDocument: 'after', upsert: true }
                 );
               }
            } catch (err) {
               console.error(`Error fetching details for ${imdbId}:`, err.message);
            }
          }
          
          // Re-fetch from DB after saving
          movies = await Movie.find(query).limit(Number(limit)).sort({ release_date: -1 });
        }
      } catch (scrapeErr) {
        console.error('Error during live genre scraping:', scrapeErr);
      }
    }

    return res.status(200).json({
      status: 'success',
      source: 'database',
      results: movies.length,
      data: movies
    });
  } catch (error) {
    console.error('Error in getAllMovies route:', error);
    next(error);
  }
});

module.exports = router;
