const router = require('express').Router();
const { Movie } = require('../models');
const { ensureMovie, isSeries } = require('../services/movieService');
const { resolvePlayback, normalizeStreams, episodeFor } = require('../services/providerService');
const { collectStreams } = require('../services/streamSources');
const { presentStreams } = require('../services/mediaService');
const sourceProbe = require('../services/sourceProbe');
const { storedSources, STORAGE_PROVIDER } = require('../services/storedPlayback');
const pending = new Map();
const CACHE_MS = 3 * 60 * 60 * 1000;

router.get('/:imdb_id', async (req, res, next) => {
  try {
    const movie = await ensureMovie(req.params.imdb_id);
    const series = isSeries(movie);
    const season = Number(req.query.season), episode = Number(req.query.episode);
    if (series && (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1)) {
      return res.status(400).json({ error: 'Choose a valid season and episode' });
    }
    if (!series && (req.query.season || req.query.episode)) return res.status(400).json({ error: 'This title is a movie' });
    const excludedProviders = typeof req.query.exclude === 'string' ? req.query.exclude.split(',').filter(Boolean).slice(0, 41) : [];
    // Telegram storage first (only when enabled and a Ready version exists).
    // The player excludes it after a failure, which falls through to providers.
    if (!excludedProviders.includes(STORAGE_PROVIDER)) {
      const stored = await storedSources({ imdbId: movie.imdb_id, season: series ? season : null, episode: series ? episode : null,
        quality: typeof req.query.quality === 'string' ? req.query.quality : undefined });
      if (stored.length) {
        res.set('Cache-Control', 'no-store');
        return res.json({ streams: stored, provider: STORAGE_PROVIDER, cached: false, stored: true });
      }
    }
    const target = series ? episodeFor(movie, season, episode) : movie;
    const cachedProvider = target?.provider_name || movie.provider_name;
    const cached = normalizeStreams(target?.stream_data);
    if (req.query.refresh !== '1' && !excludedProviders.includes(cachedProvider) && cached.length &&
        Date.now() - new Date(target.stream_fetched_at).getTime() < CACHE_MS) {
      res.set('Cache-Control', 'no-store');
      const usable=await sourceProbe.filterPlayable(cached);
      if(usable.length)return res.json({ streams: presentStreams(usable), provider: cachedProvider, cached: true });
    }
    const key = [movie.imdb_id, series ? season : '', series ? episode : '', [...excludedProviders].sort().join(',')].join(':');
    if (!pending.has(key)) {
      // Saves streams to the title (or the requested episode) for the cache.
      const save = async result => {
        const now = new Date();
        // Only vega-style providers have a page link; DesiFlix and MovieBox do not.
        const pageLink = result.candidate ? (series ? episodeFor(result.candidate, season, episode)?.link : result.candidate.defaultStreamLink) : undefined;
        if (series) {
          // Update only the requested episode. Concurrent requests for other episodes keep their caches.
          let saved = await Movie.updateOne({ imdb_id: movie.imdb_id,
            seasons: { $elemMatch: { season_number: season, episodes: { $elemMatch: { episode_number: episode } } } },
          }, { $set: {
            'seasons.$[s].episodes.$[e].stream_data': result.streams,
            'seasons.$[s].episodes.$[e].stream_fetched_at': now,
            'seasons.$[s].episodes.$[e].provider_name': result.provider,
            ...(pageLink ? { 'seasons.$[s].episodes.$[e].link': pageLink } : {}),
          } }, { arrayFilters: [{ 's.season_number': season }, { 'e.episode_number': episode }] });
          // A direct playback request may arrive before episode discovery has populated the title.
          if (!saved.matchedCount && result.candidate?.seasons) {
            const seasons = result.candidate.seasons;
            const ep = episodeFor({ seasons }, season, episode);
            if (ep) { ep.stream_data = result.streams; ep.stream_fetched_at = now; ep.provider_name = result.provider; }
            await Movie.updateOne({ imdb_id: movie.imdb_id, 'seasons.0': { $exists: false } },
              { $set: { seasons, provider_name: result.provider } });
          }
        } else {
          await Movie.updateOne({ imdb_id: movie.imdb_id }, { $set: {
            provider_name: result.provider, stream_data: result.streams, stream_fetched_at: now,
            ...(result.candidate?.defaultStreamLink ? { defaultStreamLink: result.candidate.defaultStreamLink } : {}),
          } });
        }
      };
      const job = (async () => {
        const options = { season, episode, excludedProviders, rediscover:req.query.refresh==='1'||cached.length>0 };
        const result = process.env.MULTI_SOURCE === 'false' ? await resolvePlayback(movie.toObject(), options)
          : await collectStreams(movie.toObject(), { ...options, client: req.query.client === 'app' ? 'app' : 'web',
            onLate: late => { if (late.streams.length) save(late).catch(error => console.warn('[Sources] late save failed', error.message)); } });
        await save(result);
        return { streams: result.streams, provider: result.provider, sources: result.sources };
      })();
      pending.set(key, job);
      job.finally(() => { if (pending.get(key) === job) pending.delete(key); }).catch(() => {});
    }
    const result = await pending.get(key);
    res.set('Cache-Control', 'no-store');
    res.json({ streams: presentStreams(result.streams), provider: result.provider, cached: false, ...(result.sources ? { sources: result.sources } : {}) });
  } catch (error) { next(error); }
});
module.exports = router;
