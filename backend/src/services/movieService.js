const { Movie } = require('../models');
const scraper = require('./scraperService');
const isSeries = title => /series|episode/i.test(title?.title_type || '');
const validId = id => typeof id === 'string' && /^tt\d{5,12}$/.test(id);

function mapDetails(data) {
  return {
    imdb_id: data.id, title: data.title, original_title: data.original_title || '',
    title_type: data.title_type || '', release_year: data.release_year ?? null,
    release_date: data.release_date || '', runtime_minutes: data.runtime_minutes ?? null,
    rating: data.rating ?? null, vote_count: data.vote_count ?? null, metascore: data.metascore ?? null,
    genres: data.genres || [], country: data.country || data.countries || [],
    plot: data.plot || '', poster_url: data.poster_url || '',
    episode_metadata: Array.isArray(data.episode_metadata) ? data.episode_metadata : [],
    cast: (data.enhanced_actors || []).slice(0, 10).map(actor => ({
      name: actor.name, profile_image: actor.profile_image, character: actor.characters?.[0] || '',
    })),
    metadata_complete: true,
    metadata_version: 2,
    metadata_source: data.metadata_source || 'imdb-scraper',
  };
}
const pending = new Map();
async function ensureMovie(imdbId) {
  if (!validId(imdbId)) throw Object.assign(new Error('Invalid IMDb title ID'), { status: 400 });
  if (pending.has(imdbId)) return pending.get(imdbId);
  const job = (async () => {
    const existing = await Movie.findOne({ imdb_id: imdbId });
    const needsEpisodes = isSeries(existing) && existing.metadata_source === 'cinemeta' && !Array.isArray(existing.episode_metadata);
    if (existing?.metadata_complete && !needsEpisodes && (existing.metadata_source !== 'cinemeta' || existing.metadata_version >= 2)) return existing;
    const details = await scraper.fetchMovieDetails(imdbId);
    if (details?.id !== imdbId || !details.title || !details.title_type) {
      throw Object.assign(new Error('Complete title details are unavailable'), { status: 502 });
    }
    return Movie.findOneAndUpdate({ imdb_id: imdbId }, { $set: mapDetails(details) },
      { upsert: true, returnDocument: 'after', runValidators: true });
  })();
  pending.set(imdbId, job);
  try { return await job; } finally { pending.delete(imdbId); }
}
module.exports = { ensureMovie, mapDetails, isSeries, validId };
