// /api/home: hero + rows in one answer, cached, and robust to a failing part.
const test = require('node:test');
const assert = require('node:assert/strict');
const home = require('../src/routes/home');

const item = (id, extra = {}) => ({ imdb_id: id, title: 'Title ' + id, title_type: 'Movie', release_year: 2026, poster_url: 'https://img/p.jpg', backdrop_url: 'https://img/b.jpg', plot: 'Long plot', cast: [{ name: 'x' }], ...extra });

test('one answer holds the hero and every row, with only the fields cards need', async () => {
  home.reset();
  const asked = [];
  const fetchPart = async path => { asked.push(path); return { data: [item('tt0000001'), item('tt0000002')] }; };
  const body = await home.home(0, { fetchPart, fresh: true });
  assert.equal(body.version, 1);
  assert.equal(asked[0], '/api/featured');
  assert.equal(asked.length, home.ROWS.length + 1);
  assert.deepEqual(body.rows.map(r => r.title).slice(0, 6), ['Top 10 movies right now', 'New in India', 'New releases worldwide', 'Popular series right now', 'New Indian series', 'Trending anime']);
  assert.equal(body.rows[0].kind, 'top');
  assert.equal(body.hero[0].plot, 'Long plot', 'the hero keeps the plot');
  assert.equal(body.rows[1].items[0].plot, undefined, 'rows drop the plot');
  assert.equal(body.rows[1].items[0].cast, undefined);
  assert.deepEqual(body.rows[1].more, { type: 'movie', sort: 'new', country: 'IN' });
});

test('a failing row is left out; the rest still load', async () => {
  home.reset();
  const fetchPart = async path => { if (path.includes('anime')) throw new Error('down'); return { data: [item('tt0000003')] }; };
  const body = await home.home(0, { fetchPart, fresh: true });
  assert.ok(!body.rows.some(r => r.id === 'anime'));
  assert.equal(body.rows.length, home.ROWS.length - 1);
});

test('answers are cached, and the last good answer is served when a refresh fails', async () => {
  home.reset();
  let calls = 0;
  const good = async () => { calls++; return { data: [item('tt0000004')] }; };
  const first = await home.home(0, { fetchPart: good });
  await home.home(0, { fetchPart: good });
  assert.equal(calls, home.ROWS.length + 1, 'second call came from the cache');
  const broken = async () => { throw new Error('all down'); };
  const stale = await home.home(0, { fetchPart: broken, fresh: true });
  assert.equal(stale.generatedAt, first.generatedAt);
  home.reset();
  await assert.rejects(home.home(0, { fetchPart: broken, fresh: true }), error => error.status === 503);
});
