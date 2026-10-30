// Manual admin edits (title, plot, genres) survive automatic metadata refreshes.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/db');
const { Movie } = require('../src/models');

before(async () => { await require('./connect-test-db.cjs')(); });
after(async () => { await db.close(); });

test('an admin rename is kept when the nightly refresh rewrites the title', async () => {
  const id = 'tt39631280';
  await Movie.create({ imdb_id: id, title: 'Ghooskhor Pandat', plot: 'old plot', genres: ['Thriller'] });
  await Movie.findOneAndUpdate({ imdb_id: id }, { $set: { title: 'Gajab Raat', admin_overrides: { title: 'Gajab Raat' } } });
  // What cron / ensureMovie do: upsert fresh details from the metadata source.
  const refreshed = await Movie.findOneAndUpdate({ imdb_id: id }, { $set: { title: 'Ghooskhor Pandat', plot: 'new plot', release_year: 2026 } }, { upsert: true });
  assert.equal(refreshed.title, 'Gajab Raat');
  assert.equal(refreshed.plot, 'new plot', 'fields the admin did not touch still refresh');
  assert.equal(refreshed.release_year, 2026);
  // A plain update (no upsert) behaves the same.
  const again = await Movie.findOneAndUpdate({ imdb_id: id }, { $set: { title: 'Ghooskhor Pandat' } });
  assert.equal(again.title, 'Gajab Raat');
  // A second admin edit adds to the overrides instead of replacing them.
  const edited = await Movie.findOneAndUpdate({ imdb_id: id }, { $set: { plot: 'admin plot', admin_overrides: { plot: 'admin plot' } } });
  assert.deepEqual(edited.admin_overrides, { title: 'Gajab Raat', plot: 'admin plot' });
  const last = await Movie.findOneAndUpdate({ imdb_id: id }, { $set: { title: 'X', plot: 'Y' } }, { upsert: true });
  assert.equal(last.title, 'Gajab Raat');
  assert.equal(last.plot, 'admin plot');
  // The search column follows the stored title.
  assert.equal((await db.query('SELECT title FROM movies WHERE imdb_id = $1', [id])).rows[0].title, 'Gajab Raat');
});

test('titles without overrides refresh normally', async () => {
  const id = 'tt12345678';
  await Movie.create({ imdb_id: id, title: 'First' });
  const row = await Movie.findOneAndUpdate({ imdb_id: id }, { $set: { title: 'Second' } }, { upsert: true });
  assert.equal(row.title, 'Second');
});
