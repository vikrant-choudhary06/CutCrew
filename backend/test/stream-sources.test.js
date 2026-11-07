// Multi-source playback: adapters, parsing, ranking, duplicates and time limits.
// Every network call is mocked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sources = require('../src/services/streamSources');
const sourceProbe = require('../src/services/sourceProbe');

const movie = { imdb_id: 'tt15354916', title: 'Jawan', release_year: 2023, title_type: 'Movie' };
const episodeTitle = { imdb_id: 'tt0903747', title: 'Breaking Bad', release_year: 2008, title_type: 'TV Series', season: 2, episode: 5 };
const json = body => ({ ok: true, status: 200, json: async () => body });
const keep = async streams => streams; // stands in for the byte probe

function withEnv(values, fn) {
  const saved = {};
  for (const key of Object.keys(values)) { saved[key] = process.env[key]; if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key]; }
  const restore = () => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
  try { const out = fn(); if (out?.then) return out.finally(restore); restore(); return out; } catch (error) { restore(); throw error; }
}

test('DesiFlix titles give quality, size and audio languages', () => {
  const stream = sources.fromAddon({
    name: 'DesiFlix', title: '1080p FHD • 💾 3.43GB • Server 1\nAudio: Hindi, English',
    url: 'https://abc.herokuapp.com/dl/Jawan.2023.1080p.mkv', behaviorHints: { filename: 'Jawan.2023.1080p.mkv', notWebReady: true },
  }, 'desiflix');
  assert.equal(stream.provider, 'desiflix');
  assert.equal(stream.type, 'mkv');
  assert.equal(stream.quality, '1080p');
  assert.equal(stream.height, 1080);
  assert.deepEqual(stream.audio, ['Hindi', 'English']);
  assert.equal(stream.size, 3430000000);
  assert.equal(stream.server, 'DesiFlix · 1080p FHD • 💾 3.43GB • Server 1');
});

test('addon streams keep their request headers, and unsafe links are dropped', () => {
  const stream = sources.fromAddon({ url: 'https://cdn.example/v.mp4', title: '4K HDR', behaviorHints: { proxyHeaders: { request: { Referer: 'https://moviebox.ph/' } } } }, 'censored');
  assert.deepEqual(stream.headers, { Referer: 'https://moviebox.ph/' });
  assert.equal(stream.height, 2160);
  assert.equal(stream.quality, '4K');
  assert.equal(stream.type, 'mp4');
  assert.equal(sources.fromAddon({ url: 'https://user:pass@cdn.example/v.mp4' }, 'censored'), null);
  assert.equal(sources.fromAddon({ url: 'ftp://cdn.example/v.mp4' }, 'censored'), null);
  assert.equal(sources.fromAddon({ title: 'no link' }, 'censored'), null);
  assert.equal(sources.typeOf('https://x/master.m3u8'), 'hls');
});

test('quality, audio and size parsing', () => {
  assert.equal(sources.qualityOf('720p HEVC'), 720);
  assert.equal(sources.qualityOf('UHD BluRay'), 2160);
  assert.equal(sources.qualityOf('no idea'), 0);
  assert.deepEqual(sources.audioOf('Dual Audio [Hindi + English]'), ['Hindi', 'English']);
  assert.deepEqual(sources.audioOf('Multi Audio WEB-DL'), ['Hindi', 'English']);
  assert.deepEqual(sources.audioOf('Audio: Tamil'), ['Tamil']);
  assert.equal(sources.sizeOf('💾 750MB'), 750000000);
  assert.equal(sources.sizeOf('', 1234), 1234);
});

test('Stremio ids use imdb:season:episode for episodes', () => {
  assert.equal(sources.stremioId('tt0903747', 2, 5), 'tt0903747:2:5');
  assert.equal(sources.stremioId('tt1375666'), 'tt1375666');
});

test('the Stremio adapter calls the right URL for movies and episodes', async () => {
  const calls = [];
  const fetch = async url => { calls.push(url); return json({ streams: [{ url: 'https://h.example/a.mkv', title: '1080p\nAudio: Hindi' }, { title: 'no url' }] }); };
  const one = await sources.runSource('desiflix', movie, { fetch, probe: keep, skipCodec: true });
  const two = await sources.runSource('desiflix', episodeTitle, { fetch, probe: keep, skipCodec: true });
  assert.equal(calls[0], 'https://manifest.desitvhub.eu.org/stream/movie/tt15354916.json');
  assert.equal(calls[1], 'https://manifest.desitvhub.eu.org/stream/series/tt0903747%3A2%3A5.json');
  assert.equal(one.streams.length, 1);
  assert.equal(two.streams.length, 1);
  const failed = await sources.runSource('desiflix', movie, { fetch: async () => ({ ok: false, status: 500 }), probe: keep, skipCodec: true });
  assert.deepEqual(failed.streams, []);
  assert.match(failed.error, /HTTP 500/);
});

test('a source\'s Hindi/English streams are probed before other languages', async () => {
  const fetch = async () => json({ streams: [
    { url: 'https://cdn.example/fr.mp4', title: '1080p French' },
    { url: 'https://cdn.example/hi.mp4', title: '720p Hindi' },
    { url: 'https://cdn.example/hien.mp4', title: '1080p Hindi English' },
  ] });
  let probed;
  await sources.runSource('desiflix', movie, { fetch, probe: async streams => { probed = streams.map(s => s.link); return streams; }, skipCodec: true });
  assert.deepEqual(probed, ['https://cdn.example/hien.mp4', 'https://cdn.example/hi.mp4', 'https://cdn.example/fr.mp4']);
});

test('a slow source is cut off at its time limit without throwing', async () => {
  const started = Date.now();
  const result = await sources.runSource('desiflix', movie, { timeoutMs: 150, fetch: () => new Promise(() => {}), probe: keep, skipCodec: true });
  assert.ok(Date.now() - started < 1000);
  assert.equal(result.error, 'timed out');
  assert.deepEqual(result.streams, []);
});

test('duplicates are removed: same link, same host and path, or same file and size', () => {
  const a = { link: 'https://h.example/f/Jawan.mkv?token=1', filename: 'Jawan.2023.1080p.mkv', size: 3.43e9, provider: 'desiflix' };
  const b = { link: 'https://h.example/f/Jawan.mkv?token=2', provider: 'pengu' };
  const c = { link: 'https://other.example/x', filename: 'jawan.2023.1080p.mp4', size: 3.44e9, provider: 'censored' };
  const d = { link: 'https://other.example/y', filename: 'Jawan.2023.720p.mkv', size: 1.2e9, provider: 'censored' };
  assert.deepEqual(sources.dedupe([a, b, c, d]).map(s => s.link), [a.link, d.link]);
});

test('ranking: web-playable first, then source order, quality, and Hindi/English audio', () => {
  const order = ['desiflix', 'censored', '4khdhub'];
  const list = [
    { link: '1', provider: 'desiflix', type: 'mkv', height: 2160, audio: ['Hindi'] },
    { link: '2', provider: '4khdhub', type: 'mp4', height: 2160, audio: [] },
    { link: '3', provider: 'censored', type: 'mp4', height: 720, audio: ['Hindi'] },
    { link: '4', provider: 'censored', type: 'mp4', height: 1080, audio: ['English'] },
    { link: '5', provider: 'censored', type: 'mp4', height: 1080, audio: ['Hindi', 'English'] },
  ];
  assert.deepEqual(sources.rank(list, order).map(s => s.link), ['5', '4', '3', '2', '1']);
  // On the web, a 720p MKV (passed through) comes before a 1080p or HEVC MKV (re-encoded).
  const mkv = [
    { link: 'a', provider: 'desiflix', type: 'mkv', height: 1080 },
    { link: 'b', provider: 'desiflix', type: 'mkv', height: 720, hevc: true },
    { link: 'c', provider: 'desiflix', type: 'mkv', height: 720 },
    { link: 'd', provider: '4khdhub', type: 'mkv', height: 480 },
  ];
  assert.deepEqual(sources.rank(mkv, order).map(s => s.link), ['c', 'd', 'a', 'b']);
  assert.deepEqual(sources.rank(mkv, order, { client: 'app' }).map(s => s.link), ['a', 'b', 'c', 'd']);
  // Apps play MKV directly, so source order comes first there.
  assert.deepEqual(sources.rank(list, order, { client: 'app' }).map(s => s.link), ['1', '5', '4', '3', '2']);
});

test('all sources run together; a slow one does not hold up the answer', async () => {
  const late = [];
  const run = async id => {
    if (id === 'slow') { await new Promise(resolve => setTimeout(resolve, 600)); return { source: id, streams: [{ link: 'https://s/x.mp4', provider: id, type: 'mp4' }], ms: 600 }; }
    if (id === 'broken') return { source: id, streams: [], ms: 5, error: 'HTTP 500' };
    return { source: id, streams: [{ link: `https://${id}/v.mp4`, provider: id, type: 'mp4', height: 1080 }], ms: 20 };
  };
  const started = Date.now();
  const result = await sources.collectStreams(movie, { order: ['fast', 'broken', 'slow'], run, waitMs: 100, onLate: value => late.push(value) });
  assert.ok(Date.now() - started < 500, 'answered before the slow source finished');
  assert.deepEqual(result.streams.map(s => s.provider), ['fast']);
  assert.equal(result.provider, 'fast');
  assert.ok(result.sources.find(s => s.source === 'slow').pending);
  assert.equal(result.sources.find(s => s.source === 'broken').error, 'HTTP 500');
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(late.length, 1, 'the late source updates the cache');
  assert.deepEqual(late[0].streams.map(s => s.provider), ['fast', 'slow']);
});

test('everything is waited for while nothing plays yet, and excluded sources are skipped', async () => {
  const ran = [];
  const run = async id => { ran.push(id); await new Promise(resolve => setTimeout(resolve, id === 'b' ? 300 : 10)); return { source: id, streams: id === 'b' ? [{ link: 'https://b/v.mp4', provider: 'b', type: 'mp4' }] : [], ms: 10 }; };
  const result = await sources.collectStreams(movie, { order: ['a', 'b', 'c'], excludedProviders: ['c'], run, waitMs: 50 });
  assert.deepEqual(ran.sort(), ['a', 'b']);
  assert.equal(result.provider, 'b');
  await assert.rejects(sources.collectStreams(movie, { order: ['a'], run, waitMs: 50 }), error => error.status === 503 && Array.isArray(error.sources));
});



test('Internet Archive only runs for old films', async () => {
  assert.equal(sources.skipReason('internetArchive', { release_year: 2014 }), 'only for films up to 1980');
  assert.equal(sources.skipReason('internetArchive', { release_year: 1922 }), '');
  assert.equal(sources.skipReason('4khdhub', { release_year: 2014 }), '');
  const skipped = await sources.runSource('internetArchive', { imdb_id: 'tt0816692', title: 'Interstellar', release_year: 2014, title_type: 'Movie' });
  assert.deepEqual(skipped.streams, []);
  assert.equal(skipped.ms, 0);
});

test('only direct url streams are used; torrents, YouTube, web pages and notices are skipped', () => {
  assert.equal(sources.fromAddon({ infoHash: 'abc', url: 'https://x/v.mp4' }, 'hdhub'), null);
  assert.equal(sources.fromAddon({ ytId: 'abc', url: 'https://x/v.mp4' }, 'hdhub'), null);
  assert.equal(sources.fromAddon({ externalUrl: 'https://site.example/watch' }, 'hdhub'), null);
  assert.equal(sources.fromAddon({ name: 'PenguPlay', title: 'You must sign in', url: 'https://pengu.uk/signin.mp4' }, 'pengu'), null);
  assert.ok(sources.fromAddon({ name: 'HdHub 1080p', title: 'Jawan.2023.1080p.Hindi.WEB-DL.mkv', url: 'https://pixeldrain.dev/api/file/x' }, 'hdhub'));
});

test('STREMIO_ADDONS sets the add-ons; PenguPlay needs a signed-in link; SOURCE_<NAME>=off turns one off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sources-'));
  const file = path.join(dir, 'state.json');
  withEnv({
    STREMIO_ADDONS: 'desiflix=https://d.example/manifest.json,hdhub=https://h.example/,censored=https://c.example,pengu=https://pengu.uk,bad=ftp://x',
    STREAM_SOURCES: 'desiflix,hdhub,censored,pengu,4khdhub,internetArchive,nope',
    ENABLED_PROVIDERS: '4khdhub', SOURCE_STATE_FILE: file, SOURCE_CENSORED: undefined, SOURCE_HDHUB: undefined,
  }, () => {
    sources.resetStateCache();
    assert.deepEqual(Object.keys(sources.stremioAddons()), ['desiflix', 'hdhub', 'censored', 'pengu']);
    assert.equal(sources.sourceDef('desiflix').base(), 'https://d.example');
    assert.equal(sources.sourceDef('hdhub').base(), 'https://h.example');
    assert.equal(sources.sourceDef('censored').timeoutMs(), 20000);
    assert.equal(sources.sourceDef('hdhub').timeoutMs(), 10000);
    assert.equal(sources.sourceDef('pengu').timeoutMs(), 25000);
    assert.equal(sources.sourceDef('pengu').probeTimeoutMs(), 12000);
    assert.equal(sources.sourceDef('hdhub').probeTimeoutMs(), undefined);
    // pengu.uk without a config path only offers a sign-in notice.
    assert.deepEqual(sources.sourceOrder(), ['desiflix', 'hdhub', 'censored', '4khdhub']);
    process.env.STREMIO_ADDONS += ',pengu=https://pengu.uk/%7Bmy-config%7D';
    assert.ok(sources.sourceOrder().includes('pengu'));
    process.env.SOURCE_CENSORED = 'off';
    assert.ok(!sources.sourceOrder().includes('censored'));
    fs.writeFileSync(file, JSON.stringify({ hdhub: { failures: 2, disabled: true } }));
    sources.resetStateCache();
    assert.ok(!sources.sourceOrder().includes('hdhub'), 'switched off by the weekly check');
    assert.ok(sources.sourceOrder({ includeOff: true }).includes('hdhub'), 'but the weekly check still tests it');
  });
  sources.resetStateCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Indian titles put Hindi audio first; others put English before Hindi', () => {
  const list = [
    { link: 'en', provider: 'hdhub', type: 'mp4', height: 1080, audio: ['English'] },
    { link: 'hi', provider: 'hdhub', type: 'mp4', height: 1080, audio: ['Hindi'] },
    { link: 'ta', provider: 'hdhub', type: 'mp4', height: 1080, audio: ['Tamil'] },
  ];
  assert.deepEqual(sources.rank(list, ['hdhub'], { indian: true }).map(s => s.link), ['hi', 'en', 'ta']);
  assert.deepEqual(sources.rank(list, ['hdhub']).map(s => s.link), ['en', 'hi', 'ta']);
  assert.ok(sources.isIndian({ countries: ['India'] }));
  assert.ok(sources.isIndian({ country: 'India, United States' }));
  assert.ok(!sources.isIndian({ countries: ['United States'] }));
});

test('expired links are dropped by the probe and the next link is used', async () => {
  const fetch = async () => json({ streams: [
    { url: 'https://h.example/expired-1.mkv', title: '1080p Hindi' },
    { url: 'https://h.example/expired-2.mkv', title: '1080p Hindi' },
    { url: 'https://h.example/live.mkv', title: '720p Hindi' },
  ] });
  const probed = [];
  const check = async stream => { probed.push(stream.link); return /expired/.test(stream.link) ? { ok: false, reason: 'http-403' } : { ok: true, format: 'mkv', seekable: true }; };
  const result = await sources.runSource('desiflix', movie, { fetch, probe: streams => sourceProbe.filterPlayable(streams, { check }) });
  assert.deepEqual(result.streams.map(s => s.link), ['https://h.example/live.mkv']);
  assert.equal(probed.length, 3);
});

test('the weekly check counts films under 10 minutes and episodes under 3 as clips', () => {
  assert.equal(sources.minimumLength({ title_type: 'TV Series' }), 180);
  assert.equal(sources.minimumLength({ title_type: 'Movie' }), 600);
});

test('MKV codecs are read so HEVC / 10-bit files rank after H.264 on the web', async () => {
  const streams = [
    { link: 'https://x/hevc.mkv', type: 'mkv', provider: '4khdhub', height: 0 },
    { link: 'https://x/h264.mkv', type: 'mkv', provider: 'desiflix', height: 720 },
    { link: 'https://x/v.mp4', type: 'mp4', provider: 'hdhub' },
  ];
  const measured = [];
  await sources.markHeavy(streams, async s => { measured.push(s.link); return s.link.includes('hevc') ? { codec: 'hevc', tenBit: true, height: 816 } : { codec: 'h264', tenBit: false, height: 534 }; });
  assert.deepEqual(measured, ['https://x/hevc.mkv', 'https://x/h264.mkv'], 'only MKV is measured');
  assert.equal(streams[0].hevc, true);
  assert.equal(streams[0].height, 1080);
  assert.ok(!streams[1].hevc);
  assert.deepEqual(sources.rank(streams.slice(0, 2), ['4khdhub', 'desiflix']).map(s => s.link), ['https://x/h264.mkv', 'https://x/hevc.mkv']);
  let args;
  assert.deepEqual(await sources.videoOf({ link: 'https://x/a.mkv' }, { run: async given => { args = given; return 'hevc,yuv420p10le,816\n'; } }), { codec: 'hevc', tenBit: true, height: 816 });
  assert.ok(args.includes('v:0'));
  assert.equal(await sources.videoOf({ link: 'https://x/a.mkv' }, { run: async () => { throw new Error('x'); } }), null);
});

test('the cached path keeps HEVC MKV after H.264 MKV on the web, not for apps', async () => {
  const sourceProbe = require('../src/services/sourceProbe');
  const ok = async () => ({ ok: true, format: 'mkv', seekable: true });
  const list = [{ link: 'https://x/hevc.mkv', type: 'mkv', hevc: true }, { link: 'https://x/h264.mkv', type: 'mkv', height: 720 }];
  assert.deepEqual((await sourceProbe.filterPlayable(list, { check: ok })).map(s => s.link), ['https://x/h264.mkv', 'https://x/hevc.mkv']);
  assert.deepEqual((await sourceProbe.filterPlayable(list, { check: ok, client: 'app' })).map(s => s.link), ['https://x/hevc.mkv', 'https://x/h264.mkv']);
});

test('ffprobe output becomes a length in seconds', async () => {
  let args;
  assert.equal(await sources.durationOf({ link: 'https://x/v.mp4', headers: { Referer: 'https://r/' } }, { run: async given => { args = given; return '1362.5\n'; } }), 1362.5);
  assert.ok(args.includes('-headers') && args.includes('Referer: https://r/\r\n'));
  assert.equal(await sources.durationOf({ link: 'https://x/v.mp4' }, { run: async () => { throw new Error('no ffprobe'); } }), null);
  assert.equal(await sources.durationOf({ link: 'https://x/v.mp4' }, { run: async () => 'N/A' }), null);
});

test('apps wait for a 1080p-or-smaller source while only 4K was found, up to a limit', async () => {
  const uhdFast = { source: 'uhd', streams: [{ link: 'https://u/4k.mkv', provider: 'uhd', type: 'mkv', height: 2160 }], ms: 10 };
  const run = delay => async id => {
    if (id === 'uhd') return uhdFast;
    await new Promise(resolve => setTimeout(resolve, delay));
    return { source: id, streams: [{ link: 'https://h/1080.mkv', provider: id, type: 'mkv', height: 1080 }], ms: delay };
  };
  const goodEnough = s => s.height > 0 && s.height <= 1080;
  // Without the rule (website): answers with the 4K file after waitMs.
  const web = await sources.collectStreams(movie, { order: ['uhd', 'hd'], run: run(400), waitMs: 50 });
  assert.deepEqual(web.streams.map(s => s.height), [2160]);
  // App: keeps waiting and gets the 1080p file too.
  const app = await sources.collectStreams(movie, { order: ['uhd', 'hd'], run: run(400), waitMs: 50, goodEnough, maxWaitMs: 2000 });
  assert.deepEqual(app.streams.map(s => s.height).sort(), [1080, 2160]);
  // But not forever: after maxWaitMs it answers with what it has.
  const started = Date.now();
  const capped = await sources.collectStreams(movie, { order: ['uhd', 'hd'], run: run(3000), waitMs: 50, goodEnough, maxWaitMs: 300 });
  assert.ok(Date.now() - started < 1500);
  assert.deepEqual(capped.streams.map(s => s.height), [2160]);
});
