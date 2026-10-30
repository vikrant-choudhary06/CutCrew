// Provider/database fixtures use synthetic URLs; real byte validation is tested separately.
require('../src/services/sourceProbe').filterPlayable=async streams=>streams;
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/db');
const { Movie } = require('../src/models');
const helper = require('../src/utils/providerHelper');
const scraper = require('../src/services/scraperService');
let streamCalls = 0, fail = false;
helper.getAvailableProvidersLocal = () => ['sample'];
helper.loadProvider = (_, module) => module === 'stream' ? { getStream: async ({ link }) => {
  streamCalls++;
  if (fail) return [];
  return [{ link, type: 'mp4', server: 'Sample' }];
} } : module === 'posts' ? { getSearchPosts: async()=>[{link:'https://provider.example/title'}] } : module === 'meta' ? {getMeta:async()=>({imdbId:'tt0000001',title:'Sample movie',type:'movie',linkList:[{directLinks:[{link:'https://video.example/refreshed.mp4'}]}]})} : {};
const app = require('../src/app');
let server, root;
before(async () => {
  await require('./connect-test-db.cjs')();
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  root = 'http://127.0.0.1:' + server.address().port;
  await Movie.create([
    { imdb_id: 'tt0000001', title: 'Sample movie', title_type: 'Movie', metadata_complete: true,
      provider_name: 'sample', defaultStreamLink: 'https://video.example/a.mp4' },
    { imdb_id: 'tt0000002', title: 'Sample series', title_type: 'TV Series', metadata_complete: true,
      provider_name: 'sample', seasons: [
        { season_number: 1, episodes: [{ episode_number: 1, title: 'One', link: 'https://video.example/1.mp4' },
          { episode_number: 2, title: 'Two', link: 'https://video.example/2.mp4' }] },
        { season_number: 2, episodes: [{ episode_number: 1, title: 'Season two', link: 'https://video.example/s2.mp4' }] },
      ] },
  ]);
});
after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  await db.close();
});
async function get(path) { const r = await fetch(root + path); return { status: r.status, body: await r.json() }; }
test('PostgreSQL: movie resolution persists its cache and refresh replaces it', async () => {
  const first = await get('/api/movies/play/tt0000001');
  assert.equal(first.status, 200); assert.equal(first.body.cached, false);
  const record = await Movie.findOne({ imdb_id: 'tt0000001' });
  assert.equal(record.stream_data.length, 1);
  const calls = streamCalls;
  const second = await get('/api/movies/play/tt0000001');
  assert.equal(second.body.cached, true); assert.equal(streamCalls, calls);
  const refreshed=await get('/api/movies/play/tt0000001?refresh=1');
  assert.equal(refreshed.status,200);
  const updated=await Movie.findOne({imdb_id:'tt0000001'});
  assert.equal(updated.defaultStreamLink,'https://video.example/refreshed.mp4');
  assert.equal(streamCalls, calls + 1);
});
test('PostgreSQL: concurrent episodes keep independent caches across seasons', async () => {
  const results = await Promise.all([
    get('/api/movies/play/tt0000002?season=1&episode=1'),
    get('/api/movies/play/tt0000002?season=1&episode=2'),
    get('/api/movies/play/tt0000002?season=2&episode=1'),
  ]);
  assert.ok(results.every(result => result.status === 200));
  const record = await Movie.findOne({ imdb_id: 'tt0000002' });
  assert.ok(record.seasons.every(season => season.episodes.every(ep => ep.stream_data?.length === 1)));
  assert.equal(record.stream_data, undefined);
  const second = await get('/api/movies/play/tt0000002?season=2&episode=1');
  assert.equal(second.body.cached, true);
});
test('PostgreSQL: partial metadata is upgraded without losing playback caches', async () => {
  await Movie.updateOne({ imdb_id: 'tt0000001' }, { $set: { metadata_complete: false } });
  scraper.fetchMovieDetails = async () => ({
    id: 'tt0000001', title: 'Complete Sample', title_type: 'Movie', genres: ['Drama'], plot: 'Complete plot',
  });
  const result = await get('/api/movies/tt0000001');
  assert.equal(result.status, 200); assert.equal(result.body.data.title, 'Complete Sample');
  assert.equal(result.body.data.metadata_complete, true);
  assert.equal(result.body.data.stream_data.length, 1);
});
test('PostgreSQL: empty resolution returns an error without overwriting a good cache', async () => {
  fail = true;
  const result = await get('/api/movies/play/tt0000001?refresh=1');
  assert.equal(result.status, 503);
  const record = await Movie.findOne({ imdb_id: 'tt0000001' });
  assert.equal(record.stream_data.length, 1);
});

