// What's popular right now, from IMDb: recent releases sorted by IMDb
// popularity (worldwide or one country), and IMDb's "most popular" TV chart.
// Answers are cached for an hour, and the last good answer is reused if IMDb
// is unreachable.
const axios = require('axios').create({ timeout: 15000 });

const URL = process.env.IMDB_GRAPHQL_URL || 'https://caching.graphql.imdb.com/';
const HEADERS = {
  accept: 'application/graphql+json, application/json', 'content-type': 'application/json',
  origin: 'https://www.imdb.com', referer: 'https://www.imdb.com/', 'accept-language': 'en-US,en;q=0.9',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
};
const FIELDS = 'id titleText{text} originalTitleText{text} titleType{id} releaseYear{year} releaseDate{year month day} primaryImage{url} ratingsSummary{aggregateRating voteCount} titleGenres{genres{genre{text}}} plot{plotText{plainText}} runtime{seconds} certificate{rating}';
const CACHE_MS = 3600000, DAY = 86400000;
const GENRES = ['Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Music', 'Mystery', 'Romance', 'Sci-Fi', 'Thriller', 'War', 'Western'];
const COUNTRIES = ['IN', 'US', 'GB', 'KR', 'JP'];
const TYPES = { movie: ['movie'], series: ['tvSeries', 'tvMiniSeries'] };

const cache = new Map(), pending = new Map();

async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  if (pending.has(key)) return pending.get(key);
  const work = load().then(value => {
    if (cache.size >= 200) cache.delete(cache.keys().next().value);
    cache.set(key, { value, until: Date.now() + CACHE_MS });
    return value;
  }).catch(error => {
    if (hit) return hit.value;
    throw Object.assign(new Error('Popular titles are temporarily unavailable. Please retry.'), { status: 502, cause: error });
  }).finally(() => pending.delete(key));
  pending.set(key, work);
  return work;
}

async function query(text) {
  const response = await axios.post(URL, { query: text }, { headers: HEADERS });
  if (response.data?.errors?.length && !response.data.data) throw new Error(response.data.errors[0].message || 'IMDb error');
  return response.data.data;
}

// IMDb image URLs can be resized by changing the "_V1_" suffix.
function image(url, width = 380) {
  return typeof url === 'string' && /^https:\/\//.test(url) ? url.replace(/\._V1_.*?\.(jpg|jpeg|png|webp)$/i, `._V1_QL75_UX${width}_.$1`) : '';
}

const day = date => date.toISOString().slice(0, 10);
function releaseDate(value) {
  if (!value?.year || !value.month || !value.day) return '';
  return `${value.year}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}

// IMDb title -> the item shape CutCrew's rows use.
function toItem(title) {
  if (!/^tt\d{5,12}$/.test(title?.id || '') || !title.titleText?.text) return null;
  const series = /series/i.test(title.titleType?.id || '');
  return {
    imdb_id: title.id, title: title.titleText.text, original_title: title.originalTitleText?.text || title.titleText.text,
    title_type: series ? (title.titleType.id === 'tvMiniSeries' ? 'TV Mini Series' : 'TV Series') : 'Movie',
    release_year: title.releaseYear?.year || title.releaseDate?.year || null, release_date: releaseDate(title.releaseDate),
    poster_url: image(title.primaryImage?.url), rating: title.ratingsSummary?.aggregateRating || null,
    vote_count: title.ratingsSummary?.voteCount || 0, genres: (title.titleGenres?.genres || []).map(g => g.genre?.text).filter(Boolean),
    plot: title.plot?.plotText?.plainText || '', runtime_minutes: title.runtime?.seconds ? Math.round(title.runtime.seconds / 60) : null,
    content_rating: title.certificate?.rating || '', metadata_complete: false, source: 'imdb',
  };
}

// Out already, with a poster, and not a duplicate.
function usable(items, now = Date.now()) {
  const seen = new Set();
  return items.filter(item => {
    if (!item || !item.poster_url || seen.has(item.imdb_id)) return false;
    if (item.release_date && Date.parse(item.release_date) > now) return false;
    seen.add(item.imdb_id);
    return true;
  });
}

// Recent releases, most popular first. `days` is how far back "recent" goes.
async function popularNew({ type = 'movie', country = '', genre = '', days, page = 1, perPage = 24 } = {}) {
  if (!TYPES[type]) throw Object.assign(new Error('Unsupported title type'), { status: 400 });
  if (country && !COUNTRIES.includes(country)) throw Object.assign(new Error('Unsupported country'), { status: 400 });
  if (genre && !GENRES.includes(genre)) throw Object.assign(new Error('Unsupported genre'), { status: 400 });
  const window = days || (type === 'series' ? 150 : country ? 90 : 120);
  const today = new Date();
  // Fetch enough for the requested page (IMDb returns up to 250 at a time).
  const first = Math.min(250, page * perPage + 12);
  const key = `new:${type}:${country}:${genre}:${window}:${first}:${day(today)}`;
  const items = await cached(key, async () => {
    const constraints = [
      `titleTypeConstraint:{anyTitleTypeIds:${JSON.stringify(TYPES[type])}}`,
      `releaseDateConstraint:{releaseDateRange:{start:"${day(new Date(today.getTime() - window * DAY))}",end:"${day(today)}"}}`,
      ...(country ? [`originCountryConstraint:{anyPrimaryCountries:["${country}"]}`] : []),
      ...(genre ? [`genreConstraint:{allGenreIds:["${genre}"]}`] : []),
    ];
    const data = await query(`query{advancedTitleSearch(first:${first},constraints:{${constraints.join(',')}},sort:{sortBy:POPULARITY,sortOrder:ASC}){edges{node{title{${FIELDS}}}}}}`);
    return usable((data.advancedTitleSearch?.edges || []).map(edge => toItem(edge.node?.title)));
  });
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), hasMore: items.length > start + perPage || (first < 250 && items.length >= first - 12) };
}

// IMDb's "most popular TV shows" chart.
async function popularSeries(limit = 20) {
  const items = await cached('tvmeter', async () => {
    const data = await query(`query{chartTitles(first:50,chart:{chartType:MOST_POPULAR_TV_SHOWS}){edges{node{${FIELDS}}}}}`);
    return usable((data.chartTitles?.edges || []).map(edge => toItem(edge.node)));
  });
  return items.slice(0, limit);
}

module.exports = { popularNew, popularSeries, toItem, image, usable, GENRES, COUNTRIES, _cache: cache };
