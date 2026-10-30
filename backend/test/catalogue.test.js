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
const app = require('../src/app');
const server = app.listen(0, '127.0.0.1');
const ready = new Promise(resolve => server.once('listening', resolve));
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
async function get(path) {
  await ready;
  const response = await fetch('http://127.0.0.1:' + server.address().port + path);
  return { status: response.status, body: await response.json() };
}
test('saved trending titles use the database without contacting metadata services', async () => {
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
