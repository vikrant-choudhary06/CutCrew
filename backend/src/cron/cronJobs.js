const cron = require('node-cron');
const { Movie } = require('../models');
const scraperService = require('../services/scraperService');
const { mapDetails } = require('../services/movieService');
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

            const movieData = { ...mapDetails(scraperData), local_poster_path: localPoster };
            await Movie.findOneAndUpdate(
              { imdb_id: movieData.imdb_id }, { $set: movieData },
              { returnDocument: 'after', upsert: true, runValidators: true }
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
  // Telegram storage (Phase 5): every 6 hours, confirm the Telegram messages of
  // up to 5 Ready videos not checked in 24 hours still exist. Lookup only (no
  // video download); only a confirmed missing part leaves playback.
  cron.schedule('17 */6 * * *', async () => {
    const config = require('../config/videoStorage').videoStorageConfig();
    if (!config.enabled) return;
    try {
      const adapter = require('../services/storedMediaRuntime').getAdapter(config);
      const result = await require('../services/storageMaintenance').revalidateDue({ adapter, limit: 5, mode: 'lookup' });
      if (result.checked) console.log(`Stored video check: ${result.checked} checked, ${result.problems.length} with problems`);
    } catch (error) {
      console.error('Stored video check failed:', error.code || error.message);
    }
  });
  console.log('Cron jobs initialized.');
};

module.exports = startCronJobs;
