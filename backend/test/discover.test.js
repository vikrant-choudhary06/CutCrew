const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const scraper = require('../src/services/scraperService');
const calls = [];
let fail = false;
scraper.fetchDiscover = async (type, genre, skip) => {
  calls.push({ type, genre, skip });
  if (fail) throw new Error('Offline');
  return Array.from({ length: genre === 'Comedy' ? 2 : 7 }, (_, i) => ({
    imdb_id: 'tt' + String(1000000 + skip + i), title: 'Title ' + (skip + i),
    title_type: type === 'series' ? 'TV Series' : 'Movie', metadata_complete: false,
  }));
};
const { Movie } = require('../src/models');
Movie.create = Movie.findOneAndUpdate = () => { throw new Error('Discovery must not save suggestions'); };
const app = require('../src/app');
const server = app.listen(0, '127.0.0.1');
const ready = new Promise(resolve => server.once('listening', resolve));
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
async function get(query) {
  await ready;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/discover?${query}`);
  return { status: response.status, body: await response.json() };
}
test('discovery validates type, genre and bounded scalar pagination parameters', async () => {
  for (const query of ['type=person','genre=invalid','page=0','page=101','page=1.5','limit=25','limit=-1','type=movie&type=series']) {
    assert.equal((await get(query)).status, 400);
  }
  assert.equal(calls.length, 0);
});
test('pagination returns bounded pages with distinct IDs and forwards the correct source offset', async () => {
  const first = await get('type=movie&limit=3&page=1');
  const second = await get('type=movie&limit=3&page=2');
  assert.equal(first.status, 200); assert.equal(first.body.data.length, 3); assert.equal(first.body.hasMore, true);
  assert.equal(second.body.page, 2); assert.equal(calls.at(-1).skip, 3);
  assert.ok(second.body.data.every(item => !first.body.data.some(previous => previous.imdb_id === item.imdb_id)));
  assert.equal(first.body.data[0].metadata_complete, false);
});
test('repeat discovery requests are cached by page, type, genre and limit', async () => {
  const before = calls.length;
  await Promise.all([get('type=series&genre=Action&limit=3'), get('type=series&genre=Action&limit=3')]);
  assert.equal(calls.length, before + 1);
  assert.deepEqual(calls.at(-1), { type: 'series', genre: 'Action', skip: 0 });
});
test('short final pages stop pagination and upstream failures remain retryable', async () => {
  const last = await get('type=movie&genre=Comedy&limit=3');
  assert.equal(last.body.hasMore, false); assert.equal(last.body.data.length, 2);
  fail = true;
  assert.equal((await get('type=series&genre=Drama')).status, 502);
  fail = false;
  assert.equal((await get('type=series&genre=Drama')).status, 200);
});
