// The play route with the multi-source path: results from sources that have no
// provider page (DesiFlix, MovieBox) are saved without one.
delete process.env.MULTI_SOURCE;
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Movie } = require('../src/models');
const sources = require('../src/services/streamSources');
let collectImpl;
sources.collectStreams = (...args) => collectImpl(...args);
const app = require('../src/app');
const server = http.createServer(app);
const ready = new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
async function get(path) {
  await ready;
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
  return { status: response.status, body: await response.json() };
}
function title(extra = {}) {
  const movie = { imdb_id: 'tt15354916', title: 'Jawan', title_type: 'Movie', release_year: 2023, metadata_complete: true, seasons: [], ...extra };
  movie.toObject = () => ({ ...movie });
  return movie;
}
const stream = { link: 'https://cdn.example/jawan.mp4', type: 'mp4', provider: 'moviebox', server: 'MovieBox · 1080p', headers: {}, subtitles: [] };

test('a movie found only by non-vega sources plays and is cached without a page link', async () => {
  const saved = [];
  Movie.findOne = async () => title();
  Movie.findOneAndUpdate = async (_q, change) => title(change.$set);
  Movie.updateOne = async (query, change) => { saved.push(change.$set); return { matchedCount: 1 }; };
  collectImpl = async () => ({ streams: [stream], provider: 'moviebox', candidate: null, sources: [{ source: 'moviebox', streams: 1 }] });
  const result = await get('/api/movies/play/tt15354916?refresh=1');
  assert.equal(result.status, 200);
  assert.equal(result.body.provider, 'moviebox');
  assert.equal(result.body.streams.length, 1);
  assert.deepEqual(result.body.sources, [{ source: 'moviebox', streams: 1 }]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].provider_name, 'moviebox');
  assert.ok(!('defaultStreamLink' in saved[0]), 'no page link is written');
});

test('an episode found only by non-vega sources keeps the saved episode page link', async () => {
  const saved = [];
  const series = title({ imdb_id: 'tt6473300', title: 'Mirzapur', title_type: 'TV Series', seasons: [{ season_number: 1, episodes: [{ episode_number: 1, link: 'https://site.example/ep1' }] }] });
  Movie.findOne = async () => series;
  Movie.findOneAndUpdate = async () => series;
  Movie.updateOne = async (query, change) => { saved.push(change.$set); return { matchedCount: 1 }; };
  collectImpl = async () => ({ streams: [{ ...stream, provider: 'desiflix' }], provider: 'desiflix', candidate: null, sources: [] });
  const result = await get('/api/movies/play/tt6473300?season=1&episode=1&refresh=1');
  assert.equal(result.status, 200);
  assert.equal(saved[0]['seasons.$[s].episodes.$[e].provider_name'], 'desiflix');
  assert.ok(!('seasons.$[s].episodes.$[e].link' in saved[0]), 'the episode page link is left alone');
});
