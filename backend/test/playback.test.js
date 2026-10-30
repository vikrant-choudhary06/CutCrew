// Provider/database fixtures use synthetic URLs; real byte validation is tested separately.
const sourceProbe=require('../src/services/sourceProbe');
let probeImpl=async streams=>streams;
sourceProbe.filterPlayable=(...args)=>probeImpl(...args);
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Movie } = require('../src/models');
const scraper = require('../src/services/scraperService');
const helper = require('../src/utils/providerHelper');

let adapters = {};
helper.getAvailableProvidersLocal = () => Object.keys(adapters);
helper.loadProvider = (name, module) => adapters[name]?.[module] || {};
const providers = require('../src/services/providerService');
const originalResolve = providers.resolvePlayback;
let resolveImpl = originalResolve;
providers.resolvePlayback = (...args) => resolveImpl(...args);
const movies = require('../src/services/movieService');
const media = require('../src/services/mediaService');
const app = require('../src/app');
const server = http.createServer(app);
const ready = new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = async () => { await ready; return 'http://127.0.0.1:' + server.address().port; };
async function request(path, options) {
  const response = await fetch(await base() + path, options);
  return { response, body: await response.json() };
}
function document(extra = {}) {
  const movie = { imdb_id: 'tt1375666', title: 'Inception', title_type: 'Movie',
    release_year: 2010, metadata_complete: true, seasons: [], ...extra };
  movie.toObject = () => ({ ...movie });
  return movie;
}
beforeEach(() => {
  probeImpl=async streams=>streams;
  adapters = {};
  resolveImpl = originalResolve;
  Movie.findOne = async () => document();
  Movie.updateOne = async () => ({ matchedCount: 1 });
  Movie.findOneAndUpdate = async (_query, change) => document(change.$set);
  Movie.find = () => ({ limit: () => ({ lean: async () => [] }) });
  scraper.fetchMovieDetails = async () => ({ id: 'tt1375666', title: 'Inception', title_type: 'Movie' });
  scraper.searchMovies = async () => [];
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

test('partial records are hydrated and existing stream fields are not overwritten', async () => {
  Movie.findOne = async () => document({ metadata_complete: false, stream_data: ['keep'] });
  let update;
  Movie.findOneAndUpdate = async (_, change) => { update = change.$set; return document(change.$set); };
  scraper.fetchMovieDetails = async () => ({ id: 'tt1375666', title: 'Inception', title_type: 'TV Series' });
  const result = await movies.ensureMovie('tt1375666');
  assert.equal(result.title_type, 'TV Series');
  assert.equal(update.metadata_complete, true);
  assert.equal(Object.hasOwn(update, 'stream_data'), false);
});
test('invalid title IDs fail before contacting metadata services', async () => {
  await assert.rejects(movies.ensureMovie('../secret'), { status: 400 });
});
test('search preserves unknown content type and never stores suggestions', async () => {
  scraper.searchMovies = async () => [{ id: 'tt1375666', name: 'Inception', type: 'Title' }, { id: 'nm000001', name: 'Person' }];
  Movie.findOneAndUpdate = () => { throw new Error('Suggestions must not be saved'); };
  const { body, response } = await request('/api/movies/search?query=Inception');
  assert.equal(response.status, 200);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].title_type, '');
});
test('search treats regex metacharacters as literal text', async () => {
  let filter;
  Movie.find = query => { filter = query; return { limit: () => ({ lean: async () => [] }) }; };
  await request('/api/movies/search?query=' + encodeURIComponent('a+b['));
  assert.equal(filter.title.test('a+b['), true);
  assert.equal(filter.title.test('aaab'), false);
});
test('series directLinks preserve multiple seasons and numeric episode order', async () => {
  const result = await providers.normalizeMetadata(document({ title_type: 'TV Series' }), { linkList: [
    { title: 'Season 2', directLinks: [{ title: 'Episode 10', link: JSON.stringify({ season: 2, episode: 10 }) }, { title: 'Episode 2', link: 'https://video.example/2' }] },
    { title: 'Season 1', directLinks: [{ title: 'Episode 1', link: 'https://video.example/1' }] },
  ] }, 'fake', {});
  assert.deepEqual(result.seasons.map(s => s.season_number), [1, 2]);
  assert.deepEqual(result.seasons[1].episodes.map(e => e.episode_number), [2, 10]);
});
test('series episodesLink expands every season and removes quality duplicates', async () => {
  adapters.fake = { episodes: { getEpisodes: async ({ url }) => [
    { title: 'Episode 1', link: url + '/first' }, { title: 'Episode 1', link: url + '/duplicate' },
  ] } };
  const result = await providers.normalizeMetadata(document({ title_type: 'TV Series' }),
    { linkList: [{ title: 'Season 1', episodesLink: 'https://a.example/1' }, { title: 'Season 2', episodesLink: 'https://a.example/2' }] }, 'fake', {});
  assert.equal(result.seasons.length, 2);
  assert.equal(result.seasons[1].episodes.length, 1);
});
test('an explicit conflicting IMDb ID cannot pass title matching', () => {
  assert.equal(providers.matches(document(), { imdbId: 'tt0111161', title: 'Inception' }, {}), false);
  assert.equal(providers.matches(document(), { title: 'Inception', year: 2011 }, {}), false);
});
test('TV movies are not mistaken for episodic series', () => {
  assert.equal(movies.isSeries({ title_type: 'TV Movie' }), false);
  assert.equal(movies.isSeries({ title_type: 'TV Mini Series' }), true);
});
test('playback falls back after an empty source and uses the correct episode payload', async () => {
  const series = document({ title_type: 'TV Series', provider_name: 'empty', seasons: [
    { season_number: 2, episodes: [{ episode_number: 3, link: 'old' }] },
  ] });
  let received;
  adapters.empty = { stream: { getStream: async () => [] } };
  adapters.good = {
    posts: { getSearchPosts: async () => [{ link: 'metadata' }] },
    meta: { getMeta: async () => ({ imdbId: series.imdb_id, linkList: [{ title: 'Season 2',
      directLinks: [{ title: 'Episode 3', link: '{"season":2,"episode":3}' }] }] }) },
    stream: { getStream: async input => { received = input; return [{ link: 'https://video.example/show.m3u8', server: 'Good' }]; } },
  };
  const result = await originalResolve(series, { season: 2, episode: 3 });
  assert.equal(result.provider, 'good');
  assert.deepEqual(JSON.parse(received.link), { season: 2, episode: 3 });
  assert.equal(result.streams[0].type, 'hls');
});
test('provider deadlines abort work', async () => {
  let signal;
  await assert.rejects(providers.bounded(async passed => { signal = passed; await new Promise(() => {}); }, 10), /timed out/);
  assert.equal(signal.aborted, true);
});
test('streams reject non-HTTP links and remove duplicates', () => {
  const streams = providers.normalizeStreams([{ link: 'javascript:alert(1)' }, { link: 'https://v.example/a' }, { url: 'https://v.example/a' }]);
  assert.equal(streams.length, 1);
});
test('valid cache skips resolution; refresh bypasses it', async () => {
  Movie.findOne = async () => document({ provider_name: 'cached',
    stream_data: [{ link: 'https://video.example/a.mp4', server: 'A' }], stream_fetched_at: new Date() });
  let calls = 0;
  resolveImpl = async () => { calls++; return { provider: 'new', candidate: { defaultStreamLink: 'new' },
    streams: providers.normalizeStreams([{ link: 'https://video.example/new.mp4' }]) }; };
  const cached = await request('/api/movies/play/tt1375666');
  assert.equal(cached.body.cached, true);
  assert.equal(calls, 0);
  const refreshed = await request('/api/movies/play/tt1375666?refresh=1');
  assert.equal(refreshed.body.cached, false);
  assert.equal(calls, 1);
});
test('empty caches are not served and failed resolution is not cached', async () => {
  Movie.findOne = async () => document({ stream_data: [], stream_fetched_at: new Date() });
  resolveImpl = async () => { throw Object.assign(new Error('Unavailable'), { status: 503 }); };
  Movie.updateOne = () => { throw new Error('Must not cache failures'); };
  const { response } = await request('/api/movies/play/tt1375666');
  assert.equal(response.status, 503);
});
test('series requires season and episode and stores cache only on the selected episode', async () => {
  Movie.findOne = async () => document({ title_type: 'TV Series', seasons: [{ season_number: 2, episodes: [{ episode_number: 3 }] }] });
  const missing = await request('/api/movies/play/tt1375666');
  assert.equal(missing.response.status, 400);
  let update, options;
  Movie.updateOne = async (_, change, config) => { update = change; options = config; return { matchedCount: 1 }; };
  resolveImpl = async () => ({ provider: 'good', candidate: { seasons: [{ season_number: 2,
    episodes: [{ episode_number: 3, link: 'new' }] }] }, streams: providers.normalizeStreams([{ link: 'https://v.example/show.mp4' }]) });
  const selected = await request('/api/movies/play/tt1375666?season=2&episode=3');
  assert.equal(selected.response.status, 200);
  assert.ok(update.$set['seasons.$[s].episodes.$[e].stream_data']);
  assert.deepEqual(options.arrayFilters, [{ 's.season_number': 2 }, { 'e.episode_number': 3 }]);
  assert.equal(Object.hasOwn(update.$set, 'stream_data'), false);
});
test('media tickets authenticate URLs, expire, and reject private destinations', () => {
  const path = media.signMedia('https://video.example/a.mp4', { Referer: 'https://site.example', Host: 'bad' });
  const token = new URL(path, 'http://local').searchParams.get('token');
  assert.equal(media.verifyToken(token).headers.referer, 'https://site.example');
  assert.equal(media.verifyToken(token).headers.host, undefined);
  assert.throws(() => media.verifyToken(token + 'x'));
  const expired = media.signMedia('https://video.example/a', {}, '', Date.now() - 1).split('token=')[1];
  assert.throws(() => media.verifyToken(expired), /expired/);
  for (const url of ['http://127.0.0.1/a','http://169.254.169.254/','http://[::1]/','http://10.0.0.1/','file:///etc/passwd']) {
    assert.throws(() => media.signMedia(url));
  }
  assert.equal(media.publicAddress('8.8.8.8'), true);
  assert.equal(media.publicAddress('::ffff:127.0.0.1'), false);
});
test('HLS manifests rewrite variant, segment, and encryption key URIs', () => {
  const result = media.rewritePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\nvariant/index.m3u8\nseg.ts',
    'https://video.example/base/master.m3u8', { headers: {}, expires: Date.now() + 10000 });
  assert.ok(!result.includes('URI="key.bin"'));
  const urls = [...result.matchAll(/token=([\w.-]+)/g)].map(match => media.verifyToken(match[1]).url);
  assert.deepEqual(urls, ['https://video.example/base/key.bin', 'https://video.example/base/variant/index.m3u8', 'https://video.example/base/seg.ts']);
});
test('admin endpoints and log content require authentication', async () => {
  process.env.ADMIN_TOKEN = 'test-only-admin';
  const unauthorized = await request('/api/admin/stats');
  assert.equal(unauthorized.response.status, 401);
  const logs = await request('/api/logs');
  assert.equal(logs.response.status, 401);
  const authorized = await request('/api/logs', { headers: { Authorization: 'Bearer test-only-admin' } });
  assert.equal(authorized.response.status, 200);
  delete process.env.ADMIN_TOKEN;
});

test('DNS lookup pins connections to public addresses even on DNS64 networks', async () => {
  const dns = require('dns'); const original = dns.lookup;
  dns.lookup = (_host, _options, callback) => callback(null, [
    { address: '64:ff9b::9765:6a84', family: 6 }, { address: '151.101.106.132', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]);
  try {
    const addresses = await new Promise((resolve, reject) => media.safeLookup('video.example', { all: true },
      (error, results) => error ? reject(error) : resolve(results)));
    assert.deepEqual(addresses, [{ address: '151.101.106.132', family: 4 }]);
  } finally { dns.lookup = original; }
});

test('expired intermediate links are rediscovered within the saved provider', async () => {
  const movie = document({ provider_name: 'good', defaultStreamLink: 'expired' });
  const links = [];
  adapters.good = {
    posts: { getSearchPosts: async () => [{ link: 'meta' }] },
    meta: { getMeta: async () => ({ imdbId: movie.imdb_id, linkList: [{ directLinks: [{ link: 'fresh' }] }] }) },
    stream: { getStream: async ({ link }) => { links.push(link); return link === 'fresh' ? [{ link: 'https://video.example/fresh.mp4' }] : []; } },
  };
  const result = await originalResolve(movie);
  assert.deepEqual(links, ['expired', 'fresh']);
  assert.equal(result.candidate.defaultStreamLink, 'fresh');
});

test('exact provider titles may include a matching release-year suffix', () => {
  assert.equal(providers.matches(document(), { title: 'Inception (2010)', type: 'movie' }, {}), true);
  assert.equal(providers.matches(document(), { title: 'Inception (2011)', type: 'movie' }, {}), false);
  assert.equal(providers.matches(document(), { title: 'Inception 2 (2010)', type: 'movie' }, {}), false);
});
test('Matroska streams retain their container and receive a remux ticket', () => {
  const streams = providers.normalizeStreams([{ link: 'https://v.example/video', type: 'mkv' }]);
  assert.equal(streams[0].type, 'mkv');
  const presented = media.presentStreams(streams)[0];
  assert.equal(presented.type, 'mp4'); assert.equal(presented.remuxed, true);
  assert.equal(media.verifyToken(presented.link.split('token=')[1]).format, 'mkv');
});

test('series quality variants prefer compact browser-compatible sources', async () => {
  const movie = document({ title_type: 'TV Series' });
  const candidate = await providers.normalizeMetadata(movie, { linkList: [
    { title: 'Season 1 2160p HEVC', directLinks: [{ title: 'Episode-03 26.82 GB', link: 'https://v.example/large' }] },
    { title: 'Season 1 720p x264', directLinks: [{ title: 'Episode-03 400 MB', link: 'https://v.example/small' }] },
  ] }, 'fake', {});
  assert.equal(candidate.seasons[0].episodes[0].episode_number, 3);
  assert.equal(candidate.seasons[0].episodes[0].link, 'https://v.example/small');
  assert.equal(candidate.seasons[0].episodes[0].title, 'Episode 3');
});

test('movie quality variants rank individual compact browser-compatible links',async()=>{
 const movie=document();const result=await providers.normalizeMetadata(movie,{linkList:[{title:'Download',directLinks:[{title:'1080p TrueHD 32 GB',link:'https://v.example/large'},{title:'720p x264 900 MB',link:'https://v.example/small'},{title:'1080p HEVC 1 GB',link:'https://v.example/hevc'}]}]},'fake',{});assert.equal(result.defaultStreamLink,'https://v.example/small');
});

test('a compact convertible source outranks a huge H264 download',async()=>{
 const result=await providers.normalizeMetadata(document(),{linkList:[{title:'Download',directLinks:[{title:'1080p x264 15 GB',link:'https://v.example/huge-h264'},{title:'720p HEVC 900 MB',link:'https://v.example/compact-hevc'}]}]},'fake',{});
 assert.equal(result.defaultStreamLink,'https://v.example/compact-hevc');
});


test('a dead cached source is rejected and triggers rediscovery rather than being served',async()=>{
 Movie.findOne=async()=>document({provider_name:'old',stream_data:[{link:'https://video.example/dead.mp4'}],stream_fetched_at:new Date()});
 probeImpl=async()=>[];let received;
 resolveImpl=async(_movie,options)=>{received=options;return{provider:'new',candidate:{defaultStreamLink:'fresh'},streams:providers.normalizeStreams([{link:'https://video.example/fresh.mp4'}])}};
 const result=await request('/api/movies/play/tt1375666');assert.equal(result.response.status,200);assert.equal(result.body.cached,false);assert.equal(result.body.provider,'new');assert.equal(received.rediscover,true);
});
