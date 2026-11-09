const test = require('node:test');
const assert = require('node:assert');

process.env.NUVIO_URL = 'http://nuvio-runner:7070';
const sources = require('../src/services/streamSources');

const jawan = { imdb_id: 'tt15354916', title: 'Jawan', title_type: 'Movie', release_year: 2023, country: ['India'], languages: ['Hindi'] };
const breakingBad = { imdb_id: 'tt0903747', title: 'Breaking Bad', title_type: 'TV Series', season: 1, episode: 2, seasons: [{ season_number: 1 }] };

function fakeFetch(calls, { tmdb = 872906, streams } = {}) {
  return async (url) => {
    calls.push(String(url));
    if (String(url).includes('cinemeta')) return new Response(JSON.stringify({ meta: { moviedb_id: tmdb } }), { status: 200 });
    return new Response(JSON.stringify({ streams: streams || [
      { url: 'https://cdn.example.com/v/jawan/master', name: 'Castle', title: 'Jawan (2023) | 1080P', quality: '1080P', headers: { Referer: 'https://castle.example/' } },
      { url: 'javascript:alert(1)', title: 'bad link' },
    ] }), { status: 200 });
  };
}

test('the Nuvio sources exist only when NUVIO_URL is set', () => {
  assert.deepEqual(Object.keys(sources.nuvioSources()), ['castle', 'moviebox', 'playimdb', 'einthusan', 'watchanimeworld', 'multimovies']);
  assert.equal(sources.kindOf('castle'), 'nuvio');
  assert.equal(sources.labelOf('playimdb'), 'PlayIMDb');
  const saved = process.env.NUVIO_URL; delete process.env.NUVIO_URL;
  assert.deepEqual(sources.nuvioSources(), {});
  process.env.NUVIO_URL = saved;
});

test('a movie: TMDB id from Cinemeta, then links from the runner in the usual stream shape', async () => {
  const calls = [];
  const found = await sources.nuvioStreams('castle', jawan, { fetch: fakeFetch(calls) });
  assert.match(calls[0], /v3-cinemeta\.strem\.io\/meta\/movie\/tt15354916\.json$/);
  assert.equal(calls[1], 'http://nuvio-runner:7070/streams?provider=castle&tmdb=872906&type=movie');
  assert.equal(found.length, 1); // the javascript: link is dropped
  assert.equal(found[0].link, 'https://cdn.example.com/v/jawan/master');
  assert.equal(found[0].provider, 'castle');
  assert.equal(found[0].height, 1080);
  assert.equal(found[0].headers.Referer, 'https://castle.example/');
  assert.match(found[0].server, /^Castle · /);
});

test('an episode asks for type tv with season and episode, and the TMDB id is remembered', async () => {
  const calls = [];
  await sources.nuvioStreams('playimdb', breakingBad, { fetch: fakeFetch(calls, { tmdb: 1396 }) });
  assert.match(calls[0], /meta\/series\/tt0903747\.json$/);
  assert.equal(calls[1], 'http://nuvio-runner:7070/streams?provider=playimdb&tmdb=1396&type=tv&season=1&episode=2');
  const again = [];
  await sources.nuvioStreams('castle', breakingBad, { fetch: fakeFetch(again, { tmdb: 1396 }) });
  assert.equal(again.length, 1); // no second Cinemeta lookup
});

test('no TMDB id: nothing is asked of the runner', async () => {
  const calls = [];
  const found = await sources.nuvioStreams('castle', { imdb_id: 'tt0000099', title: 'Unknown', title_type: 'Movie' }, { fetch: fakeFetch(calls, { tmdb: null }) });
  assert.deepEqual(found, []);
  assert.equal(calls.length, 1);
});

test('Einthusan only for Indian films; Nuvio sources need an IMDb title', () => {
  assert.equal(sources.skipReason('einthusan', jawan), '');
  assert.equal(sources.skipReason('einthusan', { imdb_id: 'tt1375666', title: 'Inception', title_type: 'Movie', country: ['United States'], languages: ['English'] }), 'Indian films only');
  assert.equal(sources.skipReason('einthusan', breakingBad), 'Indian films only');
  assert.equal(sources.skipReason('castle', { imdb_id: 'anilist:140960', title: 'SPY x FAMILY' }), 'needs an IMDb title');
  assert.equal(sources.skipReason('castle', jawan), '');
});

test('a video segment labelled text/html is still video; a real page is not', async () => {
  const { Readable } = require('node:stream');
  const { probe } = require('../src/services/sourceProbe');
  const ts = Buffer.alloc(188 * 4, 0xff); for (let i = 0; i < 4; i++) ts[i * 188] = 0x47;
  const open = body => async () => ({ status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' }, data: Readable.from([body]) });
  const video = await probe({ link: 'https://seg.example.site/a.html', headers: {} }, { open: open(ts) });
  assert.equal(video.ok, true);
  assert.equal(video.format, 'mpeg-ts');
  const page = await probe({ link: 'https://seg.example.site/b.html', headers: {} }, { open: open(Buffer.from('<!DOCTYPE html><html>blocked</html>')) });
  assert.deepEqual([page.ok, page.reason], [false, 'non-media-response']);
});
