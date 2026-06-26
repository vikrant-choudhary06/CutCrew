const cron = require('node-cron');
const { Movie } = require('../models');
const scraperService = require('../services/scraperService');
const providerService = require('../services/providerService');
const { downloadImage } = require('../utils/imageDownloader');

// Schedule a daily job at 2:00 AM
const startCronJobs = () => {
  cron.schedule('0 2 * * *', async () => {
    console.log('Running daily cron job to fetch trending movies...');
    try {
      // For this example, we fetch 'Action' genre as a proxy for trending
      // if your scraper has a specific trending endpoint, use that instead.
      const trendingResults = await scraperService.searchByGenre('Action', 20);
      
      for (const item of trendingResults) {
        const imdbId = item?.node?.title?.id || item?.id || item?.imdb_id;
        if (!imdbId || imdbId.startsWith('nm')) continue;

        try {
          const scraperData = await scraperService.fetchMovieDetails(imdbId);
          if (scraperData && scraperData.id) {
            let localPoster = "";
            if (scraperData.poster_url) {
              localPoster = await downloadImage(scraperData.poster_url, imdbId, 'poster');
            }

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
              local_poster_path: localPoster,
              streaming_url: "",
              cast: (scraperData.enhanced_actors || []).map(actor => ({
                name: actor.name,
                profile_image: actor.profile_image,
                character: actor.characters ? actor.characters[0] : ""
              })).slice(0, 10),
            };

            const enrichedMovieData = await providerService.fetchAndAttachProviderLinks(movieData);

            await Movie.findOneAndUpdate(
              { imdb_id: enrichedMovieData.imdb_id },
              enrichedMovieData,
              { returnDocument: 'after', upsert: true }
            );
            console.log(`Updated trending movie/series: ${movieData.title}`);
          }
        } catch (err) {
          console.error(`Error updating trending item ${imdbId}:`, err.message);
        }
      }
      console.log('Daily cron job finished successfully.');
    } catch (error) {
      console.error('Error in daily cron job:', error.message);
    }
  });
  console.log('Cron jobs initialized.');
};

module.exports = startCronJobs;
