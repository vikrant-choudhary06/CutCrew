const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { Movie } = require('../src/models');
const scraper = require('../src/services/scraperService');
let stored = [], calls = 0, reject = false;
Movie.find = () => ({ sort: () => ({ limit: async () => stored }) });
scraper.fetchTrending = async type => {
  calls++;
  if (reject) throw new Error('Upstream unavailable');
  return [{ imdb_id: 'tt15239678', title: 'Sample title', title_type: type === 'series' ? 'TV Series' : 'Movie', metadata_complete: false }];
};
Movie.create = Movie.findOneAndUpdate = () => { throw new Error('Discovery must not write incomplete metadata'); };
// IMDb "popular now" lists. Unavailable unless a test sets imdbItems, so the
// stored and Cinemeta fallbacks below are what these tests exercise.
const imdb = require('../src/services/imdbLists');
let imdbItems = null;
imdb.popularNew = async () => { if (!imdbItems) throw new Error('IMDb unavailable'); return { items: imdbItems, hasMore: false }; };
imdb.popularSeries = async () => { if (!imdbItems) throw new Error('IMDb unavailable'); return imdbItems; };
const app = require('../src/app');
const server = app.listen(0, '127.0.0.1');
const ready = new Promise(resolve => server.once('listening', resolve));
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
async function get(path) {
  await ready;
  const response = await fetch('http://127.0.0.1:' + server.address().port + path);
  return { status: response.status, body: await response.json() };
}
test('without IMDb, saved trending titles use the database without contacting metadata services', async () => {
  stored = Array.from({ length: 10 }, (_, index) => ({ imdb_id: 'tt' + String(index + 1).padStart(7, '0'), title: 'Stored title' }));
  const result = await get('/api/movies/trending');
  assert.equal(result.status, 200); assert.equal(result.body.source, 'database');
  assert.equal(result.body.data[0].title, 'Stored title'); assert.equal(calls, 0);
});
test('an empty catalogue returns cached live movie suggestions without saving partial records', async () => {
  stored = [];
  const [a,b] = await Promise.all([get('/api/movies/trending'),get('/api/movies/trending')]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.body.source, 'cinemeta'); assert.equal(a.body.data[0].metadata_complete, false);
  assert.equal(calls, 1);
});
test('upstream failure returns a retryable error rather than pretending the catalogue is empty', async () => {
  reject = true;
  const result = await get('/api/series/trending');
  assert.equal(result.status, 502); assert.match(result.body.message, /temporarily unavailable/);
});
test('series discovery recovers after failure and preserves series type', async () => {
  reject = false;
  const result = await get('/api/series/trending');
  assert.equal(result.status, 200); assert.equal(result.body.data[0].title_type, 'TV Series');
});
test('small catalogues keep stored details and add distinct live suggestions', async () => {
  stored = [{ imdb_id: 'tt15239678', title: 'Complete stored title', metadata_complete: true }];
  const result = await get('/api/movies/trending');
  assert.equal(result.status, 200); assert.equal(result.body.source, 'mixed');
  assert.equal(result.body.data.length, 1); assert.equal(result.body.data[0].title, 'Complete stored title');
});
test('top 10, popular series and new releases use IMDb popularity when it is available', async () => {
  imdbItems = Array.from({ length: 10 }, (_, i) => ({ imdb_id: 'tt' + String(i + 100).padStart(7, '0'), title: 'New ' + i, poster_url: 'https://img.example/p.jpg' }));
  try {
    const movies = await get('/api/movies/trending');
    assert.equal(movies.status, 200); assert.equal(movies.body.source, 'imdb'); assert.equal(movies.body.data[0].title, 'New 0');
    const series = await get('/api/series/trending');
    assert.equal(series.body.source, 'imdb');
    const india = await get('/api/discover/new?type=movie&country=IN');
    assert.equal(india.status, 200); assert.equal(india.body.source, 'imdb'); assert.equal(india.body.data.length, 10);
    assert.equal((await get('/api/discover/new?country=XX')).status, 400);
    assert.equal((await get('/api/discover/new?type=game')).status, 400);
  } finally { imdbItems = null; }
});
