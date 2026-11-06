// GET /api/home: the whole home screen in one answer (hero + rows), for the
// apps. Each part comes from the same endpoint the website calls, fetched
// inside this server, so all their caches and fallbacks still apply. The
// result is cached for HOME_CACHE_MS (default 7 min); if a refresh fails, the
// last good answer is served. A row that fails is left out, not the page.
const router = require('express').Router();

const ROWS = [
  { id: 'top10', title: 'Top 10 movies right now', kind: 'top', path: '/api/movies/trending', limit: 10 },
  { id: 'new-india', title: 'New in India', path: '/api/discover/new?type=movie&country=IN&limit=24', more: { type: 'movie', sort: 'new', country: 'IN' } },
  { id: 'new-world', title: 'New releases worldwide', path: '/api/discover/new?type=movie&limit=24', more: { type: 'movie', sort: 'new' } },
  { id: 'series', title: 'Popular series right now', path: '/api/series/trending', more: { type: 'series' } },
  { id: 'new-india-series', title: 'New Indian series', path: '/api/discover/new?type=series&country=IN&limit=24', more: { type: 'series', sort: 'new', country: 'IN' } },
  { id: 'anime', title: 'Trending anime', path: '/api/anime/browse?kind=trending', more: { type: 'anime' } },
  { id: 'action', title: 'Action movies', path: '/api/discover?type=movie&genre=Action&limit=24', more: { type: 'movie', genre: 'Action' } },
  { id: 'comedy', title: 'Comedies', path: '/api/discover?type=movie&genre=Comedy&limit=24', more: { type: 'movie', genre: 'Comedy' } },
  { id: 'thriller', title: 'Thrillers', path: '/api/discover?type=movie&genre=Thriller&limit=24', more: { type: 'movie', genre: 'Thriller' } },
  { id: 'crime-series', title: 'Crime series', path: '/api/discover?type=series&genre=Crime&limit=24', more: { type: 'series', genre: 'Crime' } },
  { id: 'animation', title: 'Animated movies', path: '/api/discover?type=movie&genre=Animation&limit=24', more: { type: 'movie', genre: 'Animation' } },
  { id: 'romance', title: 'Romance', path: '/api/discover?type=movie&genre=Romance&limit=24', more: { type: 'movie', genre: 'Romance' } },
  { id: 'horror', title: 'Horror', path: '/api/discover?type=movie&genre=Horror&limit=24', more: { type: 'movie', genre: 'Horror' } },
];
const VERSION = 1;

// Rows only need what a card shows; the hero also needs the plot and runtime.
const CARD = ['imdb_id', 'title', 'title_type', 'release_year', 'poster_url', 'backdrop_url', 'rating', 'kind', 'anilist_id', 'format_label'];
const HERO = [...CARD, 'plot', 'runtime_minutes', 'genres', 'content_rating'];
const pick = (item, keys) => Object.fromEntries(keys.filter(key => item?.[key] !== undefined && item[key] !== null && item[key] !== '').map(key => [key, item[key]]));

let cached = null, pending = null;
const cacheMs = () => Number(process.env.HOME_CACHE_MS) || 7 * 60000;

async function build(port, fetchPart) {
  const get = fetchPart || (async path => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  });
  const [hero, ...rows] = await Promise.allSettled([get('/api/featured'), ...ROWS.map(row => get(row.path))]);
  const body = {
    version: VERSION, generatedAt: new Date().toISOString(),
    hero: hero.status === 'fulfilled' ? (hero.value.data || []).filter(x => x.backdrop_url).slice(0, 6).map(x => pick(x, HERO)) : [],
    rows: ROWS.map((row, i) => {
      const result = rows[i];
      const items = result.status === 'fulfilled' ? (result.value.data || []).slice(0, row.limit || 24).map(x => pick(x, CARD)).filter(x => x.imdb_id && x.title) : [];
      return { id: row.id, title: row.title, kind: row.kind || 'poster', more: row.more || null, items };
    }).filter(row => row.items.length),
  };
  if (!body.hero.length && !body.rows.length) throw Object.assign(new Error('Home is temporarily unavailable. Please retry.'), { status: 503 });
  return body;
}

async function home(port, { fetchPart, fresh = false } = {}) {
  if (!fresh && cached && cached.until > Date.now()) return cached.body;
  if (!pending) {
    pending = build(port, fetchPart).then(body => { cached = { body, until: Date.now() + cacheMs() }; return body; })
      .catch(error => { if (cached) return cached.body; throw error; })
      .finally(() => { pending = null; });
  }
  return pending;
}

router.get('/', async (req, res, next) => {
  try {
    const body = await home(req.socket.localPort);
    res.set('Cache-Control', 'public, max-age=120').json(body);
  } catch (error) { next(error); }
});

module.exports = router;
module.exports.home = home;
module.exports.ROWS = ROWS;
module.exports.reset = () => { cached = null; pending = null; };
