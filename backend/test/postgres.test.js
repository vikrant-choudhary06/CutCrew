const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/db');
const { Movie, User } = require('../src/models');
const { importRecords } = require('../src/services/databaseImport');
before(async () => {
  await require('./connect-test-db.cjs')();
});
after(async () => { await db.close(); });
const fixture = id => ({ _id: 'legacy-' + id, imdb_id: id, title: 'A+B[ special', title_type: 'Movie',
  genres: ['Action', 'Sci-Fi'], country: ['India'], release_year: 2020, release_date: '2020-01-01', vote_count: 123, rating: 8,
  createdAt: new Date('2020-01-01'), updatedAt: new Date('2021-01-01'),
  provider_name: 'sample', stream_data: [{ link: 'https://video.example/a.mp4', headers: { Referer: 'https://source.example' } }],
  stream_fetched_at: new Date('2021-01-01'), seasons: [{ season_number: 1, episodes: [{ episode_number: 1, title: 'One', stream_data: [{ link: 'https://video.example/1' }] }] }],
});
test('schema migrations can be reapplied without losing data', async () => {
  await Movie.create(fixture('tt0000010'));
  await db.migrate();
  assert.equal((await Movie.findOne({ imdb_id: 'tt0000010' })).title, 'A+B[ special');
});
test('SQL catalogue filters preserve literal search, genre, country, year and sort semantics', async () => {
  const query = { title: /A\+B\[/i, imdb_id: /^tt/, genres: { $in: [/action/i] }, country: { $in: [/india/i] }, release_year: 2020 };
  assert.equal((await Movie.find(query).limit(10).sort({ vote_count: -1, rating: -1 })).length, 1);
  assert.equal((await Movie.find({ genres: { $in: [/drama/i] } })).length, 0);
  assert.equal((await Movie.find({ title: "'; DROP TABLE movies; --" })).length, 0);
  await assert.rejects(async () => await Movie.find({ 'title; DROP TABLE movies': 'x' }), /Unsupported/);
});
test('unique IMDb identity and required titles are enforced', async () => {
  await assert.rejects(Movie.create(fixture('tt0000010')), { code: '23505' });
  await assert.rejects(Movie.create({ imdb_id: 'tt0000011', title: '' }), /required/);
  await assert.rejects(Movie.create({ imdb_id: 'bad', title: 'Bad' }), { code: '23514' });
});
test('upserts preserve identity, creation time and provider caches under concurrent metadata writes', async () => {
  const old = await Movie.findOne({ imdb_id: 'tt0000010' });
  await Promise.all([
    Movie.findOneAndUpdate({ imdb_id: old.imdb_id }, { $set: { title: 'Updated' } }, { upsert: true }),
    Movie.findOneAndUpdate({ imdb_id: old.imdb_id }, { $set: { plot: 'New plot' } }),
  ]);
  const current = await Movie.findOne({ imdb_id: old.imdb_id });
  assert.equal(current._id, old._id);
  assert.equal(+current.createdAt, +old.createdAt);
  assert.equal(current.title, 'Updated'); assert.equal(current.plot, 'New plot');
  assert.deepEqual(current.stream_data, old.stream_data);
  assert.deepEqual(current.seasons, old.seasons);
});
test('conditional discovery cannot overwrite existing episode caches', async () => {
  const result = await Movie.updateOne({ imdb_id: 'tt0000010', 'seasons.0': { $exists: false } }, { $set: { seasons: [] } });
  assert.equal(result.matchedCount, 0);
  assert.equal((await Movie.findOne({ imdb_id: 'tt0000010' })).seasons[0].episodes[0].stream_data.length, 1);
});
test('dry-run exercises PostgreSQL constraints and leaves no catalogue or user records', async () => {
  const result = await importRecords({ movies: [fixture('tt0000020')], users: [{ _id: 'u20', email: 'dry@example.test', password: 'existing-hash' }] });
  assert.equal(result.movies.wouldInsert, 1); assert.equal(result.movies.inserted, 0);
  assert.equal(await Movie.findOne({ imdb_id: 'tt0000020' }), null);
  assert.equal(await User.countDocuments(), 0);
});
test('import preserves legacy IDs, dates, nested episodes, provider headers and existing password hashes', async () => {
  const source = fixture('tt0000021');
  const user = { _id: 'u21', email: 'import@example.test', password: '$existing-hash', role: 'admin' };
  const result = await importRecords({ movies: [source], users: [user], apply: true });
  assert.equal(result.movies.inserted, 1); assert.equal(result.users.inserted, 1);
  const target = await Movie.findOne({ imdb_id: source.imdb_id });
  assert.equal(target._id, source._id); assert.equal(+target.createdAt, +source.createdAt);
  assert.deepEqual(target.stream_data, source.stream_data); assert.deepEqual(target.seasons, source.seasons);
  assert.equal((await db.query('SELECT password FROM users WHERE id = $1', ['u21'])).rows[0].password, user.password);
});
test('re-running import skips existing identities without replacing target changes', async () => {
  const result = await importRecords({ movies: [{ ...fixture('tt0000021'), title: 'Stale title' }], users: [{ _id: 'u21', email: 'import@example.test', password: 'different' }], apply: true });
  assert.equal(result.movies.skipped, 1); assert.equal(result.users.skipped, 1);
  assert.equal((await Movie.findOne({ imdb_id: 'tt0000021' })).title, 'A+B[ special');
});
test('invalid source data rolls back movies and users already inserted in the transaction', async () => {
  await assert.rejects(importRecords({ movies: [fixture('tt0000030')], users: [{ _id: 'invalid' }], apply: true }), /invalid user/);
  assert.equal(await Movie.findOne({ imdb_id: 'tt0000030' }), null);
});
test('dry-run rejects values PostgreSQL cannot cast and rolls back its earlier records', async () => {
  await assert.rejects(importRecords({ movies: [fixture('tt0000031'), { ...fixture('tt0000032'), release_year: 1.5 }], users: [] }), { code: '22P02' });
  assert.equal(await Movie.findOne({ imdb_id: 'tt0000031' }), null);
});
test('admin user counts use SQL and duplicate email/invalid role constraints apply', async () => {
  assert.equal(await User.countDocuments(), 1);
  await assert.rejects(User.create({ email: 'import@example.test', password: 'hash' }), { code: '23505' });
  await assert.rejects(User.create({ email: 'role@example.test', password: 'hash', role: 'root' }), { code: '23514' });
});
