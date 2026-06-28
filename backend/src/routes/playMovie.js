const express = require('express');
const router = express.Router();
const axios = require('axios');
const { Movie } = require('../models');

router.get('/:imdb_id', async (req, res, next) => {
  try {
    const { imdb_id } = req.params;
    const { season, episode } = req.query;

    const movie = await Movie.findOne({ imdb_id });
    if (!movie) {
      return res.status(404).json({ error: 'Movie/Series not found in database' });
    }

    // Strict Verification Logic for Content Type
    let isSeries = false;
    const titleType = (movie.title_type || '').toLowerCase();
    if (titleType.includes('tv') || titleType.includes('series') || titleType.includes('episode')) {
      isSeries = true;
    }
    const contentType = isSeries ? 'tv' : 'movie'; // strict type

    // 1. Check Stream Cache
    const CACHE_HOURS = 3;
    const cacheLimit = new Date(Date.now() - CACHE_HOURS * 60 * 60 * 1000);

    let targetEpisode = null;
    if (isSeries && season && episode && movie.seasons && movie.seasons.length > 0) {
      const targetSeason = movie.seasons.find(s => s.season_number === parseInt(season, 10));
      if (targetSeason) {
        targetEpisode = targetSeason.episodes.find(e => e.episode_number === parseInt(episode, 10));
      }
      if (!targetEpisode) {
        return res.status(404).json({ error: 'Streaming link unavailable for this specific episode' });
      }

      // Check episode cache
      if (targetEpisode.stream_data && targetEpisode.stream_fetched_at && targetEpisode.stream_fetched_at > cacheLimit) {
        console.log(`[Cache] Serving cached stream for Series ${imdb_id} S${season} E${episode}`);
        return res.status(200).json(targetEpisode.stream_data);
      }
    } else {
      // Movie cache check
      if (movie.stream_data && movie.stream_fetched_at && movie.stream_fetched_at > cacheLimit) {
        console.log(`[Cache] Serving cached stream for Movie ${imdb_id}`);
        return res.status(200).json(movie.stream_data);
      }
    }

    // 2. Not cached or expired. Fetch from Provider using imdb_id if applicable, or target link.
    // Provider strict IMDB payload:
    let targetLink = isSeries ? (targetEpisode ? targetEpisode.link : '') : movie.defaultStreamLink;
    const provider = movie.provider_name || 'autoEmbed';

    // Call 3: Request the final stream playable links from provider directly via module
    const path = require('path');
    const fs = require('fs');
    const { getProviderContext } = require('../utils/providerHelper');
    
    const distDir = path.join(__dirname, '../../../provider/dist');
    const streamModulePath = path.join(distDir, provider, 'stream.js');
    
    if (!fs.existsSync(streamModulePath)) {
      throw new Error(`Provider ${provider} stream module not found`);
    }
    
    const streamModule = require(streamModulePath);
    if (!streamModule.getStream) {
      throw new Error(`Provider ${provider} does not support getStream`);
    }
    
    const providerContext = getProviderContext();
    const signal = new AbortController().signal;
    
    const streamData = await streamModule.getStream({ 
      link: targetLink || imdb_id, 
      type: contentType, 
      signal, 
      providerContext 
    });

    // Save to Cache
    if (isSeries && targetEpisode) {
      await Movie.findOneAndUpdate(
        { imdb_id, "seasons.season_number": parseInt(season, 10), "seasons.episodes.episode_number": parseInt(episode, 10) },
        { 
          $set: { 
            "seasons.$[season].episodes.$[episode].stream_data": streamData,
            "seasons.$[season].episodes.$[episode].stream_fetched_at": new Date()
          } 
        },
        { 
          arrayFilters: [ { "season.season_number": parseInt(season, 10) }, { "episode.episode_number": parseInt(episode, 10) } ]
        }
      );
    } else {
      await Movie.findOneAndUpdate(
        { imdb_id },
        { 
          $set: { 
            stream_data: streamData,
            stream_fetched_at: new Date()
          } 
        }
      );
    }

    return res.status(200).json(streamData);

  } catch (error) {
    console.error('Error fetching stream links from provider:', error.message);
    return res.status(503).json({ error: 'Streaming links unavailable' });
  }
});

module.exports = router;
