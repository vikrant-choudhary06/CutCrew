// The play route with ?lang=: sources with the preferred language first, each
// stream with the track to play; cached entries from before tracks still play.
delete process.env.MULTI_SOURCE;
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Movie } = require('../src/models');
const sources = require('../src/services/streamSources');
const sourceProbe = require('../src/services/sourceProbe');
let collectImpl;
sources.collectStreams = (...args) => collectImpl(...args);
sourceProbe.filterPlayable = async streams => streams;
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
  const movie = { imdb_id: 'tt27510174', title: 'Toxic', title_type: 'Movie', release_year: 2026, metadata_complete: true, seasons: [], ...extra };
  movie.toObject = () => ({ ...movie });
  return movie;
}
const track = (index, language, label) => ({ index, language, label, codec: 'aac', channels: 2, title: '', default: index === 0 });
const english = { link: 'https://cdn.example/toxic-en.mp4', type: 'mp4', provider: 'censored', server: 'A', height: 1080, headers: {}, subtitles: [], audioTracks: [track(0, 'en', 'English')] };
const multi = { link: 'https://cdn.example/toxic-multi.mkv', type: 'mkv', provider: 'hdhub', server: 'B', height: 720, headers: {}, subtitles: [],
  audioTracks: [track(0, 'kn', 'Kannada'), track(1, 'ta', 'Tamil'), track(2, 'hi', 'Hindi')] };

test('the preferred language decides the order and the track', async () => {
  Movie.findOne = async () => title();
  Movie.findOneAndUpdate = async (_q, change) => title(change.$set);
  Movie.updateOne = async () => ({ matchedCount: 1 });
  collectImpl = async () => ({ streams: [english, multi].map(s => ({ ...s })), provider: 'censored', candidate: null, sources: [] });

  const hindi = await get('/api/movies/play/tt27510174?refresh=1&lang=hi');
  assert.equal(hindi.status, 200);
  assert.equal(hindi.body.lang, 'hi');
  assert.equal(hindi.body.streams[0].provider, 'hdhub');
  assert.deepEqual([hindi.body.streams[0].audioIndex, hindi.body.streams[0].audioLanguage, hindi.body.streams[0].audioMatched], [2, 'hi', true]);
  assert.deepEqual(hindi.body.streams[0].audioTracks.map(t => t.label), ['Kannada', 'Tamil', 'Hindi']);

  const eng = await get('/api/movies/play/tt27510174?refresh=1&lang=en');
  assert.equal(eng.body.streams[0].provider, 'censored');
  // No English in the multi-language file: its default (first) track, not a match.
  assert.deepEqual([eng.body.streams[1].audioIndex, eng.body.streams[1].audioMatched], [0, false]);

  // No lang: Hindi is the default preference.
  const none = await get('/api/movies/play/tt27510174?refresh=1');
  assert.equal(none.body.lang, 'hi');
  assert.equal(none.body.streams[0].provider, 'hdhub');

  // No Hindi anywhere: plays English and says the preference was not found.
  collectImpl = async () => ({ streams: [{ ...english }], provider: 'censored', candidate: null, sources: [] });
  const missing = await get('/api/movies/play/tt27510174?refresh=1&lang=hi');
  assert.deepEqual([missing.body.streams[0].audioLanguage, missing.body.streams[0].audioMatched], ['en', false]);
});

test('a cache entry saved before audio tracks existed still plays', async () => {
  const cached = title({ provider_name: 'hdhub', stream_fetched_at: new Date().toISOString(),
    stream_data: [{ link: 'https://cdn.example/old.mkv', type: 'mkv', server: 'Old', provider: 'hdhub', headers: {}, subtitles: [] }] });
  Movie.findOne = async () => cached;
  Movie.findOneAndUpdate = async () => cached;
  collectImpl = async () => { throw new Error('the cache should answer'); };
  const result = await get('/api/movies/play/tt27510174?lang=hi');
  assert.equal(result.status, 200);
  assert.equal(result.body.cached, true);
  assert.equal(result.body.streams.length, 1);
  assert.equal(result.body.streams[0].audioTracks, undefined);
  assert.equal(result.body.streams[0].audioIndex, undefined);

  // A newer entry keeps its tracks in the cache and gets a choice.
  cached.stream_data = [{ ...multi }];
  const fresh = await get('/api/movies/play/tt27510174?lang=hi');
  assert.equal(fresh.body.cached, true);
  assert.equal(fresh.body.streams[0].audioIndex, 2);
});

test('the app gets a cached 1080p file first even when 4K files come before it in the cache', async () => {
  const t = (index, language, codec) => ({ index, language, label: language, codec, channels: 6, title: '', default: index === 0 });
  const uhd = n => ({ link: `https://cdn.example/uhd${n}.mkv`, type: 'mkv', provider: 'hdhub', server: 'HdHub 4K', height: 2160, hevc: true, headers: {}, subtitles: [], audioTracks: [t(0, 'hi', 'eac3'), t(1, 'en', 'eac3')] });
  const hd = { link: 'https://cdn.example/hd.mkv', type: 'mkv', provider: '4khdhub', server: '4kHDHub 1080p', height: 1080, headers: {}, subtitles: [], audioTracks: [t(0, 'hi', 'eac3'), t(1, 'en', 'eac3')] };
  const series = title({ imdb_id: 'tt33546863', title: 'Off Campus', title_type: 'TV Series',
    seasons: [{ season_number: 1, episodes: [{ episode_number: 1, provider_name: 'hdhub', stream_fetched_at: new Date().toISOString(), stream_data: [uhd(1), uhd(2), uhd(3), hd] }] }] });
  Movie.findOne = async () => series;
  Movie.findOneAndUpdate = async () => series;
  collectImpl = async () => { throw new Error('the cache should answer'); };
  // Like the real probe: only the first playable batch of three comes back.
  const original = sourceProbe.filterPlayable;
  sourceProbe.filterPlayable = async streams => streams.slice(0, 3);
  try {
    const app = await get('/api/movies/play/tt33546863?season=1&episode=1&lang=hi&client=app');
    assert.equal(app.status, 200);
    assert.equal(app.body.streams[0].height, 1080);
    const web = await get('/api/movies/play/tt33546863?season=1&episode=1&lang=hi');
    assert.equal(web.body.streams.length, 3);
  } finally { sourceProbe.filterPlayable = original; }
});
