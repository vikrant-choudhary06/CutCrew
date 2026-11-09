const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.NUVIO_URL = 'http://nuvio-runner:7070';
const media = require('../src/services/mediaService');
const sources = require('../src/services/streamSources');
const nama = require('../src/services/animeNama');

const MASTER = [
  '#EXTM3U', '#EXT-X-VERSION:3',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Japanese",LANGUAGE="jpn",DEFAULT=YES,URI="https://cdn.example.com/hls/a_jpn.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Hindi",LANGUAGE="hin",DEFAULT=NO,URI="https://cdn.example.com/hls/a_hin.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,AUDIO="a"', 'https://cdn.example.com/hls/v1080.m3u8', '',
].join('\n');
const packed = text => 'data:application/vnd.apple.mpegurl;base64,' + Buffer.from(text).toString('base64');

test('a packed playlist travels in the media token and the relay serves it with every address relayed', async () => {
  const link = media.signPlaylist(MASTER, { Referer: 'https://player.example/' });
  const ticket = media.verifyToken(new URL(link, 'http://x').searchParams.get('token'));
  assert.equal(ticket.format, 'hlsdoc');
  assert.equal(ticket.url, 'https://cdn.example.com/hls/v1080.m3u8');
  const app = express(); app.get('/api/media', media.relay);
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}${link}`);
  const body = await response.text();
  server.close();
  assert.match(response.headers.get('content-type'), /mpegurl/);
  assert.ok(body.startsWith('#EXTM3U'));
  assert.ok(!body.includes('cdn.example.com'), 'upstream addresses are hidden behind the relay');
  assert.equal((body.match(/\/api\/media\?token=/g) || []).length, 3);
});

test('a packed playlist with a private or relative address is refused', () => {
  assert.throws(() => media.signPlaylist(MASTER.replace('https://cdn.example.com/hls/v1080.m3u8', 'http://127.0.0.1:5000/secret')));
  assert.throws(() => media.signPlaylist(MASTER.replace('https://cdn.example.com/hls/v1080.m3u8', 'v1080.m3u8')));
  assert.throws(() => media.signPlaylist('<html>not a playlist</html>'));
});

test('NAMA streams: packed playlists become HLS streams with their languages; per-language copies are dropped', async () => {
  const runner = async url => {
    if (String(url).includes('cinemeta')) return new Response(JSON.stringify({ meta: { moviedb_id: 85937 } }));
    return new Response(JSON.stringify({ streams: [
      { url: packed(MASTER), name: '1080p | Multi Audio', title: 'Demon Slayer | S01 E01', quality: '1080p' },
      { url: packed(MASTER.replace(/#EXT-X-MEDIA:[^\n]*Japanese[^\n]*\n/, '')), name: '1080p | Hindi', title: 'Demon Slayer | S01 E01', quality: '1080p' },
    ] }));
  };
  const list = await sources.nuvioStreams('watchanimeworld', { imdb_id: 'tt9335498', title: 'Demon Slayer', title_type: 'TV Series', season: 1, episode: 1, seasons: [{ season_number: 1 }] }, { fetch: runner });
  assert.equal(list.length, 1);
  const [stream] = list;
  assert.equal(stream.type, 'hls');
  assert.equal(stream.link, 'https://cdn.example.com/hls/v1080.m3u8');
  assert.ok(stream.playlist.startsWith('#EXTM3U'));
  assert.deepEqual(stream.audioTracks.map(t => t.language), ['ja', 'hi']);
  assert.equal(stream.height, 1080);
  const [shown] = media.presentStreams([{ ...stream, subtitles: [] }]);
  assert.equal(media.verifyToken(new URL(shown.link, 'http://x').searchParams.get('token')).format, 'hlsdoc');
  assert.equal(shown.playlist, undefined);
});

test('WatchAnimeWorld is asked only for animated titles', () => {
  assert.equal(sources.skipReason('watchanimeworld', { imdb_id: 'tt15354916', title: 'Jawan', genres: ['Action'] }), 'animation only');
  assert.equal(sources.skipReason('watchanimeworld', { imdb_id: 'tt9335498', title: 'Demon Slayer', genres: ['Animation', 'Action'] }), '');
});

test('the wanted audio becomes the default (Hindi), the others stay in the menu', () => {
  const doc = nama.preferAudio(MASTER, 'hi');
  assert.match(doc, /NAME="Hindi",LANGUAGE="hin",DEFAULT=YES/);
  assert.match(doc, /NAME="Japanese",LANGUAGE="jpn",DEFAULT=NO/);
  assert.equal(nama.preferAudio(MASTER, 'ta'), MASTER); // no Tamil: left as it is
});

test('AniList ids map to a TMDB id and season, and dubbed streams are asked for that episode', async () => {
  const calls = [];
  const get = async url => { calls.push(String(url)); return new Response(JSON.stringify({ themoviedb: 95479, 'themoviedb-season': 2, media: 'TV' })); };
  assert.deepEqual(await nama.tmdbFor(145064, { fetch: get }), { tmdb: 95479, movie: false, season: 2 });
  await nama.tmdbFor(145064, { fetch: get });
  assert.equal(calls.length, 1); // remembered
  const asked = [];
  const out = await nama.streams({ anilist_id: 145064, title: 'Jujutsu Kaisen Season 2' }, 5, {
    fetch: get, probe: list => list,
    nuvio: async (id, _anime, options) => { asked.push([id, options.tmdb, options.type, options.season, options.episode]); return id === 'watchanimeworld' ? [{ provider: id, playlist: MASTER, link: 'https://cdn.example.com/hls/v1080.m3u8' }] : []; },
  });
  assert.deepEqual(asked, [['watchanimeworld', 95479, 'tv', 2, 5], ['multimovies', 95479, 'tv', 2, 5]]);
  assert.equal(out.length, 1);
  assert.match(out[0].playlist, /NAME="Hindi",LANGUAGE="hin",DEFAULT=YES/);
});
