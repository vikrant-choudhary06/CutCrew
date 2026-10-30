const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectCinemeta, mapCinemeta } = require('../src/services/scraperService');
test('canonical episodic metadata wins over a movie endpoint placeholder', () => {
  const id = 'tt0944947';
  const moviePlaceholder = { id, name: 'Game of Thrones', type: 'movie' };
  const series = { id, imdb_id: id, name: 'Game of Thrones', type: 'series',
    videos: [{ season: 1, episode: 1 }], poster: 'poster' };
  const selected = selectCinemeta([moviePlaceholder, series], id);
  assert.equal(mapCinemeta(selected).title_type, 'TV Series');
});
test('canonical movie metadata wins over a series endpoint placeholder', () => {
  const id = 'tt1375666';
  const movie = { imdb_id: id, name: 'Inception', type: 'movie' };
  const seriesPlaceholder = { id, name: 'Inception', type: 'series' };
  assert.equal(mapCinemeta(selectCinemeta([seriesPlaceholder, movie], id)).title_type, 'Movie');
});
test('wrong-title IDs and empty placeholders are rejected', () => {
  assert.equal(selectCinemeta([{ id: 'tt0000001', name: 'Wrong' }, { id: 'tt1375666' }], 'tt1375666'), undefined);
});
