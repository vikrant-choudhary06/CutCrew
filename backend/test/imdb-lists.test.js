const test = require('node:test');
const assert = require('node:assert/strict');
const imdb = require('../src/services/imdbLists');
const { eligible } = require('../src/routes/featured');

test('IMDb titles become row items with resized posters', () => {
  const item = imdb.toItem({
    id: 'tt27988879', titleText: { text: 'Ramayana: Rise of a Legend' }, titleType: { id: 'movie' },
    releaseYear: { year: 2026 }, releaseDate: { year: 2026, month: 11, day: 6 },
    primaryImage: { url: 'https://m.media-amazon.com/images/M/abc@._V1_.jpg' },
    ratingsSummary: { aggregateRating: 8.7, voteCount: 8947 }, titleGenres: { genres: [{ genre: { text: 'Action' } }] },
    plot: { plotText: { plainText: 'An epic.' } }, runtime: { seconds: 9000 },
  });
  assert.equal(item.imdb_id, 'tt27988879');
  assert.equal(item.title_type, 'Movie');
  assert.equal(item.release_date, '2026-11-06');
  assert.equal(item.poster_url, 'https://m.media-amazon.com/images/M/abc@._V1_QL75_UX380_.jpg');
  assert.equal(item.runtime_minutes, 150);
  assert.deepEqual(item.genres, ['Action']);
  assert.equal(imdb.toItem({ id: 'tt1', titleText: { text: 'x' } }), null, 'IMDb ids are validated');
  assert.equal(imdb.toItem({ id: 'tt0944947', titleText: { text: 'GoT' }, titleType: { id: 'tvSeries' } }).title_type, 'TV Series');
});

test('rows keep released titles with posters, once each', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  const base = { poster_url: 'https://img/p.jpg' };
  const kept = imdb.usable([
    { ...base, imdb_id: 'tt0000001', release_date: '2026-11-01' },
    { ...base, imdb_id: 'tt0000001', release_date: '2026-11-01' },
    { ...base, imdb_id: 'tt0000002', release_date: '2026-11-20' },
    { imdb_id: 'tt0000003', release_date: '2026-10-01', poster_url: '' },
    null,
  ], now);
  assert.deepEqual(kept.map(x => x.imdb_id), ['tt0000001']);
});

test('unsupported filters are rejected before calling IMDb', async () => {
  await assert.rejects(imdb.popularNew({ type: 'game' }), error => error.status === 400);
  await assert.rejects(imdb.popularNew({ country: 'XX' }), error => error.status === 400);
  await assert.rejects(imdb.popularNew({ genre: 'Anime' }), error => error.status === 400);
});

test('the hero puts recent titles ahead of older popular ones', () => {
  const now = Date.parse('2026-11-06T00:00:00Z');
  const make = (id, year, date) => ({ imdb_id: id, title: id, plot: 'p', poster_url: 'https://i/p.jpg', backdrop_url: 'https://i/b.jpg', release_year: year, release_date: date });
  const order = eligible([make('tt0107120', 1993, '1993-07-16'), make('tt3000001', 2026, '2026-10-02'), make('tt0077651', 1978, '1978-10-25'), make('tt3000002', 2026, '2026-09-18')], now).map(x => x.imdb_id);
  assert.deepEqual(order, ['tt3000001', 'tt3000002', 'tt0107120', 'tt0077651']);
  // With enough recent titles, older ones are left out entirely.
  const many = Array.from({ length: 8 }, (_, i) => make('tt400000' + i, 2026, '2026-10-0' + (i + 1)));
  const pool = eligible([make('tt0107120', 1993, '1993-07-16'), ...many], now).map(x => x.imdb_id);
  assert.equal(pool.length, 8);
  assert.ok(!pool.includes('tt0107120'));
});
