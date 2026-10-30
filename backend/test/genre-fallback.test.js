const { test } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const create = axios.create;
let primary = [], fallbackCalls = 0, lastFallback;
axios.create = () => ({ get: async url => {
  if (url.includes('/search/genre/')) return { data: primary };
  fallbackCalls++; lastFallback = url;
  return { data: { metas: [
    { id: 'tt1234567', name: 'A science fiction film', type: 'movie', releaseInfo: '2026', poster: 'https://images.example/a.jpg' },
    { id: 'nm1234567', name: 'A person' },
  ] } };
} });
const scraper = require('../src/services/scraperService');
axios.create = create;
test('HTTP 200 with an empty genre result falls back to live catalogue IDs', async () => {
  const items = await scraper.searchByGenre('Sci-Fi', 1);
  assert.equal(items[0].id, 'tt1234567'); assert.equal(fallbackCalls, 1);
});
test('a populated primary genre result is retained without another fallback request', async () => {
  primary = [[{ id: 'tt7654321' }]];
  const items = await scraper.searchByGenre('Drama', 1);
  assert.equal(items[0].id, 'tt7654321'); assert.equal(fallbackCalls, 1);
});
test('an unexpected primary result shape falls back and normalizes Science Fiction', async () => {
  primary = { results: [] };
  await scraper.searchByGenre('Science Fiction', 1);
  assert.match(lastFallback, /genre=Sci-Fi/);
});
test('live catalogue suggestions use valid title IDs and remain incomplete metadata', async () => {
  const items = await scraper.fetchTrending('movie', 10);
  assert.equal(items.length, 1); assert.equal(items[0].title_type, 'Movie');
  assert.equal(items[0].metadata_complete, false); assert.equal(items[0].release_year, 2026);
});
test('discovery forwards genre and page offset to the metadata catalogue', async () => {
  const items = await scraper.fetchDiscover('series', 'Science Fiction', 18);
  assert.match(lastFallback, /catalog\/series\/top\/skip=18&genre=Sci-Fi\.json$/);
  assert.equal(items.length, 1); assert.equal(items[0].title_type, 'TV Series');
});
