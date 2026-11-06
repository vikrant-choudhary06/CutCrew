const axios = require('axios').create({ timeout: 15000 });
const SCRAPER_BASE_URL = process.env.SCRAPER_URL || 'https://cut-crew-all.onrender.com';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io';
let retryPrimaryAt = 0;
async function withFallback(path, options, fallback) {
  if (Date.now() >= retryPrimaryAt) {
    try { return (await axios.get(SCRAPER_BASE_URL + path, options)).data; }
    catch { retryPrimaryAt = Date.now() + 60000; }
  }
  return fallback();
}
function mapCinemeta(meta) {
  if (!(meta?.imdb_id || meta?.id) || !meta.name) throw new Error('Title not found');
  return {
    id: meta.imdb_id || meta.id, title: meta.name, original_title: meta.name,
    title_type: meta.type === 'series' ? 'TV Series' : 'Movie',
    release_year: parseInt(meta.year || meta.releaseInfo, 10) || null,
    release_date: meta.released || '', runtime_minutes: parseInt(meta.runtime, 10) || null,
    rating: Number(meta.imdbRating) || null, genres: meta.genres || meta.genre || [],
    countries: typeof meta.country === 'string' ? meta.country.split(',').map(s => s.trim()) : meta.country || [],
    plot: meta.description || '', poster_url: meta.poster || '',
    enhanced_actors: (meta.cast || []).map(name => ({ name })),
    metadata_source: 'cinemeta',
    episode_metadata: (meta.videos || []).filter(item => item.season > 0 && item.episode > 0).slice(0,2000).map(item => ({season:item.season,episode:item.episode,title:item.name||'',thumbnail:typeof item.thumbnail==='string'?item.thumbnail:''})),
  };
}
async function fetchMovieDetails(imdbId) {
  return withFallback('/movie/' + encodeURIComponent(imdbId), {}, async () => {
    const results = await Promise.allSettled(['movie', 'series'].map(type => axios.get(
      CINEMETA_URL + '/meta/' + type + '/' + encodeURIComponent(imdbId) + '.json'
    )));
    const meta = selectCinemeta(results.filter(result => result.status === 'fulfilled').map(result => result.value.data?.meta), imdbId);
    if (!meta) throw Object.assign(new Error('Metadata services are unavailable'), { status: 502 });
    return mapCinemeta(meta);
  });
}
function selectCinemeta(candidates, imdbId) {
  const score = meta => (meta.videos?.some(video => video.season > 0 && video.episode > 0) ? 100 : 0)
    + (meta.imdb_id ? 10 : 0) + (meta.poster ? 2 : 0);
  // Cinemeta returns minimal placeholders even for a mismatched /movie or /series endpoint.
  // Prefer canonical metadata and actual episodes over the endpoint's echoed type.
  return candidates.filter(meta => (meta?.imdb_id || meta?.id) === imdbId && meta?.name)
    .sort((a, b) => score(b) - score(a))[0];
}
async function searchMovies(query, limit = 20) {
  const response = await withFallback('/search/' + encodeURIComponent(query), { params: { limit } }, async () => {
    const results = await Promise.allSettled(['movie', 'series'].map(type => axios.get(
      CINEMETA_URL + '/catalog/' + type + '/top/search=' + encodeURIComponent(query) + '.json'
    )));
    if (results.every(result => result.status === 'rejected')) throw Object.assign(new Error('Search unavailable'), { status: 502 });
    return { results: results.flatMap(result => result.status === 'fulfilled' ? (result.value.data.metas || []).map(meta => ({
      id: meta.imdb_id || meta.id, name: meta.name, image: meta.poster,
      title_type: meta.type === 'series' ? 'TV Series' : 'Movie', year: parseInt(meta.releaseInfo, 10) || null,
    })) : []).slice(0, limit) };
  });
  return response.results || [];
}
async function searchByGenre(genre, limit = 15) {
  const fallbackGenre = async () => {
    const mapped = genre === 'Science Fiction' ? 'Sci-Fi' : genre;
    const result = await axios.get(CINEMETA_URL + '/catalog/movie/top/genre=' + encodeURIComponent(mapped) + '.json');
    return [(result.data.metas || []).slice(0, limit).map(meta => ({ id: meta.imdb_id || meta.id }))];
  };
  const response = await withFallback('/search/genre/' + encodeURIComponent(genre), { params: { limit } }, fallbackGenre);
  const titles = Array.isArray(response?.[0]) ? response[0] : [];
  // Some scraper deployments respond 200 with an empty result for valid genres.
  return titles.length ? titles : (await fallbackGenre())[0];
}
async function fetchTrending(type, limit = 10) {
  if (!['movie', 'series'].includes(type)) throw new Error('Unsupported catalogue type');
  const response = await axios.get(CINEMETA_URL + '/catalog/' + type + '/top.json');
  return (response.data.metas || []).filter(meta => /^tt\d{5,12}$/.test(meta.imdb_id || meta.id || '') && meta.name)
    .slice(0, limit).map(meta => ({
      imdb_id: meta.imdb_id || meta.id, title: meta.name,
      title_type: type === 'series' ? 'TV Series' : 'Movie',
      release_year: parseInt(meta.releaseInfo || meta.year, 10) || null,
      poster_url: meta.poster || '', rating: Number(meta.imdbRating) || null,
      backdrop_url: meta.background || '', release_date: meta.released || '', runtime_minutes: parseInt(meta.runtime,10)||null, content_rating: meta.contentRating || '',
      genres: meta.genres || [], plot: meta.description || '', metadata_complete: false,
    }));
}
async function fetchDiscover(type, genre, skip = 0) {
  if (!['movie', 'series'].includes(type)) throw new Error('Unsupported catalogue type');
  const extra = new URLSearchParams({ skip: String(skip) });
  if (genre) extra.set('genre', genre === 'Science Fiction' ? 'Sci-Fi' : genre);
  const response = await axios.get(`${CINEMETA_URL}/catalog/${type}/top/${extra}.json`);
  return (response.data.metas || []).filter(meta => /^tt\d{5,12}$/.test(meta.imdb_id || meta.id || '') && meta.name)
    .map(meta => ({ imdb_id: meta.imdb_id || meta.id, title: meta.name,
      title_type: type === 'series' ? 'TV Series' : 'Movie',
      release_year: parseInt(meta.releaseInfo || meta.year, 10) || null,
      poster_url: meta.poster || '', rating: Number(meta.imdbRating) || null,
      backdrop_url: meta.background || '', release_date: meta.released || '', runtime_minutes: parseInt(meta.runtime,10)||null, content_rating: meta.contentRating || '',
      genres: meta.genres || [], languages: Array.isArray(meta.languages) ? meta.languages : typeof meta.language === 'string' ? meta.language.split(',').map(x => x.trim()) : [], plot: meta.description || '', metadata_complete: false }));
}
module.exports = { fetchMovieDetails, searchMovies, searchByGenre, mapCinemeta, selectCinemeta, fetchTrending, fetchDiscover };
