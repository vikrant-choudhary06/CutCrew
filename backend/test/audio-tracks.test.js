// Audio tracks: language detection, the default choice, ranking by the
// preferred language, the conversion's track argument and old cache entries.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const audio = require('../src/services/audioTracks');

test('a track language comes from its tag, or from its title when the tag is missing', () => {
  assert.equal(audio.detectLanguage({ language: 'hin' }), 'hi');
  assert.equal(audio.detectLanguage({ language: 'en-US' }), 'en');
  assert.equal(audio.detectLanguage({ language: 'TAM' }), 'ta');
  assert.equal(audio.detectLanguage({ language: 'jpn' }), 'ja');
  assert.equal(audio.detectLanguage({ language: 'und', title: 'Hindi DD 5.1' }), 'hi');
  assert.equal(audio.detectLanguage({ title: 'हिन्दी' }), 'hi');
  assert.equal(audio.detectLanguage({ title: 'हिंदी (Original)' }), 'hi');
  assert.equal(audio.detectLanguage({ title: 'Telugu [Original]' }), 'te');
  assert.equal(audio.detectLanguage({ title: 'తెలుగు' }), 'te');
  assert.equal(audio.detectLanguage({ title: 'Kannada - AAC 2.0' }), 'kn');
  assert.equal(audio.detectLanguage({ title: 'Español Latino' }), 'es');
  assert.equal(audio.detectLanguage({ title: 'Korean' }), 'ko');
  assert.equal(audio.detectLanguage({ language: 'und', title: 'Track 1' }), '');
  assert.equal(audio.detectLanguage({}), '');
});

test('tracks from ffprobe are numbered among audio tracks and named for people', () => {
  const tracks = audio.fromProbe([
    { index: 0, codec_type: 'video', codec_name: 'h264' },
    { index: 1, codec_type: 'audio', codec_name: 'eac3', channels: 6, tags: { language: 'kan' }, disposition: { default: 1 } },
    { index: 2, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { title: 'Hindi' } },
    { index: 3, codec_type: 'audio', codec_name: 'ac3', channels: 8, tags: { language: 'eng', title: "Director's commentary" } },
    { index: 4, codec_type: 'audio', codec_name: 'aac', channels: 2 },
  ]);
  assert.deepEqual(tracks.map(t => t.index), [0, 1, 2, 3]);
  assert.deepEqual(tracks.map(t => t.language), ['kn', 'hi', 'en', '']);
  assert.deepEqual(tracks.map(t => t.label), ['Kannada 5.1', 'Hindi', 'English 7.1 · Commentary', 'Audio 4']);
  assert.equal(tracks[0].default, true);
});

test('HLS master playlists list their audio renditions in order', () => {
  const tracks = audio.fromPlaylist([
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Tamil",LANGUAGE="ta",DEFAULT=YES,AUTOSELECT=YES,URI="ta.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="हिन्दी",ASSOC-LANGUAGE="en",DEFAULT=NO,CHANNELS="6",URI="hi.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="en.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="aud"', 'v.m3u8',
  ].join('\n'));
  assert.deepEqual(tracks.map(t => [t.index, t.language, t.label, t.default]), [[0, 'ta', 'Tamil', true], [1, 'hi', 'Hindi 5.1', false]]);
  assert.deepEqual(audio.fromPlaylist('#EXTM3U\n#EXTINF:4,\nseg.ts'), []);
});

test('the default track is the preferred language, then English, then the file default, then the first', () => {
  const t = (index, language, extra = {}) => ({ index, language, title: '', default: false, ...extra });
  const southFilm = [t(0, 'kn', { default: true }), t(1, 'ta'), t(2, 'hi'), t(3, 'en')];
  assert.deepEqual(audio.chooseTrack(southFilm, 'hi'), { index: 2, language: 'hi', matched: true });
  assert.deepEqual(audio.chooseTrack(southFilm, 'en'), { index: 3, language: 'en', matched: true });
  assert.deepEqual(audio.chooseTrack(southFilm, 'te'), { index: 3, language: 'en', matched: false });
  assert.deepEqual(audio.chooseTrack([t(0, 'ko'), t(1, 'es', { default: true })], 'hi'), { index: 1, language: 'es', matched: false });
  assert.deepEqual(audio.chooseTrack([t(0, ''), t(1, '')], 'hi'), { index: 0, language: '', matched: false });
  // A commentary track is not picked as the language's main track.
  assert.deepEqual(audio.chooseTrack([t(0, 'en', { title: 'Commentary' }), t(1, 'hi'), t(2, 'en')], 'en'), { index: 2, language: 'en', matched: true });
  assert.equal(audio.chooseTrack([], 'hi'), null);
  assert.equal(audio.preferredLanguage('english'), 'en');
  assert.equal(audio.preferredLanguage('hi'), 'hi');
  assert.equal(audio.preferredLanguage(''), 'hi');
  assert.equal(audio.preferredLanguage('<script>'), 'hi');
});

test('streams that surely carry the preferred language move up, without beating quality or heavy conversions', () => {
  const tracks = (...langs) => langs.map((language, index) => ({ index, language, label: language, title: '', default: index === 0 }));
  const english = { link: 'a', type: 'mp4', height: 1080, audioTracks: tracks('en') };
  const hindiMkv = { link: 'b', type: 'mkv', height: 720, audioTracks: tracks('ta', 'hi') };
  const hindiLow = { link: 'c', type: 'mp4', height: 360, audioTracks: tracks('hi') };
  const hindiHeavy = { link: 'd', type: 'mkv', height: 1080, hevc: true, audioTracks: tracks('hi') };
  const unknown = { link: 'e', type: 'hls' };
  const order = list => list.map(s => s.link).join('');
  assert.equal(order(audio.preferLanguage([english, unknown, hindiLow, hindiMkv, hindiHeavy], 'hi')), 'baecd');
  assert.equal(order(audio.preferLanguage([english, unknown, hindiLow, hindiMkv, hindiHeavy], 'en')), 'aecbd');
  // Apps play HEVC MKV themselves, so it is not held back there.
  assert.equal(order(audio.preferLanguage([english, hindiHeavy], 'hi', { client: 'app' })), 'da');
  // A browser cannot switch MP4 tracks: Hindi as the second MP4 track does not count on the web.
  const dualMp4 = { link: 'f', type: 'mp4', height: 1080, audioTracks: tracks('en', 'hi') };
  assert.equal(order(audio.preferLanguage([english, dualMp4], 'hi')), 'af');
  assert.equal(order(audio.preferLanguage([english, dualMp4], 'hi', { client: 'app' })), 'fa');
});

test('each stream says which track to play', () => {
  const tracks = [{ index: 0, language: 'kn', default: true, title: '' }, { index: 1, language: 'hi', default: false, title: '' }];
  const [mkv, mp4, none] = audio.withChoice([{ type: 'mkv', audioTracks: tracks }, { type: 'mp4', audioTracks: tracks }, { type: 'hls' }], 'hi');
  assert.deepEqual([mkv.audioIndex, mkv.audioLanguage, mkv.audioMatched], [1, 'hi', true]);
  // The browser plays an MP4's default track, so the answer is honest about it.
  assert.deepEqual([mp4.audioIndex, mp4.audioLanguage, mp4.audioMatched], [0, 'kn', false]);
  assert.equal(none.audioIndex, undefined);
  const app = audio.withChoice([{ type: 'mp4', audioTracks: tracks }], 'hi', 'app')[0];
  assert.deepEqual([app.audioIndex, app.audioMatched], [1, true]);
});

test('reading tracks fills the language list, and a failed probe leaves the stream alone', async () => {
  const streams = [{ link: 'https://a.example/1.mkv', type: 'mkv', audio: ['Hindi'] }, { link: 'https://a.example/2.mp4', type: 'mp4' }, { link: 'https://a.example/3.m3u8', type: 'hls' }];
  const seen = [];
  await audio.addTracks(streams, { read: async s => { seen.push(s.link); return s.type === 'mkv' ? audio.fromProbe([{ codec_type: 'audio', tags: { language: 'tel' } }, { codec_type: 'audio', tags: { language: 'hin' } }]) : []; } });
  assert.deepEqual(seen, ['https://a.example/1.mkv', 'https://a.example/2.mp4']);
  assert.deepEqual(streams[0].audio, ['Telugu', 'Hindi']);
  assert.equal(streams[1].audioTracks, undefined);
  // ffprobe is run with the source's headers and reads audio only.
  let args;
  const tracks = await audio.readTracks({ link: 'https://a.example/x.mkv', headers: { Referer: 'https://a.example/' } }, { run: async a => { args = a; return JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'hin' } }] }); } });
  assert.deepEqual(tracks.map(t => t.label), ['Hindi']);
  assert.ok(args.includes('-headers') && args.includes('a'));
  assert.deepEqual(await audio.readTracks({ link: 'x' }, { run: async () => { throw new Error('timeout'); } }), []);
});

test('one ffprobe per source file gives both the codec check and the tracks', async () => {
  const sources = require('../src/services/streamSources');
  const streams = [{ link: 'https://a.example/1.mkv', type: 'mkv' }, { link: 'https://a.example/2.mp4', type: 'mp4' }];
  const calls = [];
  await sources.inspect(streams, { mediaOf: async s => { calls.push(s.link); return { video: { codec: 'hevc', tenBit: true, height: 816 }, tracks: audio.fromProbe([{ codec_type: 'audio', tags: { language: 'hin' } }]) }; } });
  assert.equal(calls.length, 2);
  assert.equal(streams[0].hevc, true);
  assert.equal(streams[0].height, 1080);
  assert.equal(streams[1].hevc, undefined, 'MP4 is not marked heavy');
  assert.deepEqual(streams.map(s => s.audioTracks[0].language), ['hi', 'hi']);
  let args;
  await sources.mediaOf({ link: 'https://a.example/1.mkv' }, { run: async a => { args = a; return '{"streams":[]}'; } });
  assert.match(args.join(' '), /codec_type.*channels.*stream_tags=language,title/);
});

test('the conversion maps the chosen audio track', () => {
  const { ffmpegArgs } = require('../src/services/remuxService');
  const args = ffmpegArgs('http://127.0.0.1/media', false, 0, 2);
  const maps = args.flatMap((a, i) => (a === '-map' ? [args[i + 1]] : []));
  assert.deepEqual(maps, ['0:v:0', '0:a:2?']);
});

test('cached streams keep their tracks, and older entries without tracks still play', () => {
  const { normalizeStreams } = require('../src/services/providerService');
  const [old] = normalizeStreams([{ link: 'https://cdn.example/a.mkv', type: 'mkv', server: 'X' }]);
  assert.equal(old.audioTracks, undefined);
  assert.equal(audio.withChoice([old], 'hi')[0].audioIndex, undefined);
  const [fresh] = normalizeStreams([{ link: 'https://cdn.example/b.mkv', type: 'mkv', audio: ['Hindi', 7], audioTracks: [
    { index: 0, language: 'ta', label: 'Tamil', codec: 'aac', channels: 2, title: '', default: true },
    { index: 1, language: 'hi', label: 'Hindi 5.1', codec: 'eac3', channels: 6, title: 'Hindi', default: false },
    { index: 'x' }, null,
  ] }]);
  assert.deepEqual(fresh.audioTracks.map(t => t.label), ['Tamil', 'Hindi 5.1']);
  assert.deepEqual(fresh.audio, ['Hindi']);
  assert.equal(audio.withChoice([fresh], 'hi')[0].audioIndex, 1);
});

test('a slow file inspection never makes a source time out; it finishes in the background', async () => {
  const sources = require('../src/services/streamSources');
  const started = Date.now();
  const result = await sources.runSource('4khdhub', { imdb_id: 'tt0816692', title: 'Interstellar', title_type: 'Movie', release_year: 2014 }, {
    timeoutMs: 300, inspectWaitMs: 50,
    attemptProvider: async () => ({ streams: [{ link: 'https://cdn.example/interstellar.mkv', type: 'mkv', quality: '1080p', subtitles: [] }] }),
    mediaOf: () => new Promise(resolve => setTimeout(() => resolve({ video: { codec: 'h264', tenBit: false, height: 1080 }, tracks: audio.fromProbe([{ codec_type: 'audio', tags: { language: 'hin' } }, { codec_type: 'audio', tags: { language: 'eng' } }]) }), 600)),
  });
  assert.equal(result.error, undefined);
  assert.equal(result.streams.length, 1);
  assert.ok(Date.now() - started < 500, 'the answer did not wait for the whole inspection');
  assert.equal(result.streams[0].audioTracks, undefined);
  await result.inspection;
  assert.deepEqual(result.streams[0].audioTracks.map(t => t.label), ['Hindi', 'English']);
});

test('on phones, after the language, 1080p and AAC come before 4K and E-AC3 / DTS', () => {
  const t = (language, codec, index = 0) => ({ index, language, codec, label: language, title: '', default: index === 0 });
  const uhd = { link: 'uhd', type: 'mkv', height: 2160, hevc: true, audioTracks: [t('hi', 'aac'), t('en', 'aac', 1)] };
  const eac3 = { link: 'eac3', type: 'mkv', height: 1080, audioTracks: [t('hi', 'eac3'), t('en', 'eac3', 1)] };
  const dts = { link: 'dts', type: 'mkv', height: 1080, audioTracks: [t('hi', 'aac'), t('en', 'dts', 1)] };
  const aac = { link: 'aac', type: 'mkv', height: 720, audioTracks: [t('hi', 'aac'), t('en', 'aac', 1)] };
  const tamilOnly = { link: 'ta', type: 'mkv', height: 1080, audioTracks: [t('ta', 'aac')] };
  const order = (list, lang) => audio.preferLanguage(list, lang, { client: 'app' }).map(s => s.link).join(' ');
  assert.equal(order([uhd, eac3, dts, aac], 'en'), 'aac eac3 dts uhd');
  // For Hindi the DTS file plays its AAC Hindi track, so it is fine.
  assert.equal(order([uhd, eac3, dts, aac], 'hi'), 'dts aac eac3 uhd');
  // The language still comes first: a 4K file with it beats a phone-friendly one without.
  assert.equal(order([tamilOnly, uhd], 'hi'), 'uhd ta');
  // The website keeps its own order: it converts the audio anyway, and every MKV over 720p is heavy there.
  assert.equal(audio.preferLanguage([uhd, eac3, aac], 'en', { client: 'web' }).map(s => s.link).join(' '), 'aac uhd eac3');
  assert.equal(audio.phoneCost({ height: 0 }, 'hi'), 0);
});

test('a 4K cinema crop (3840x1608) is 2160p, not 1080p', async () => {
  const sources = require('../src/services/streamSources');
  const make = () => [{ link: 'https://a.example/uhd.mkv', type: 'mkv' }, { link: 'https://a.example/hd.mkv', type: 'mkv' }, { link: 'https://a.example/label.mkv', type: 'mkv', height: 1080 }];
  const sizes = { 'https://a.example/uhd.mkv': [3840, 1608], 'https://a.example/hd.mkv': [1920, 800], 'https://a.example/label.mkv': [3840, 2160] };
  const streams = make();
  await sources.inspect(streams, { mediaOf: async s => ({ video: { codec: 'hevc', tenBit: true, width: sizes[s.link][0], height: sizes[s.link][1] }, tracks: [] }) });
  assert.deepEqual(streams.map(s => s.height), [2160, 1080, 2160]);
});

test('a file that cannot seek goes after the ones that can, whatever its language or audio', () => {
  const t = (language, codec) => [{ index: 0, language, codec, label: language, title: '', default: true }];
  const stuck = { link: 'stuck', type: 'mkv', height: 1080, seekable: false, audioTracks: t('hi', 'aac') };
  const eac3 = { link: 'eac3', type: 'mkv', height: 1080, audioTracks: t('hi', 'eac3') };
  const english = { link: 'en', type: 'mkv', height: 1080, audioTracks: t('en', 'aac') };
  const order = (list, client) => audio.preferLanguage(list, 'hi', { client }).map(s => s.link).join(' ');
  assert.equal(order([stuck, eac3, english], 'app'), 'eac3 en stuck');
  assert.equal(order([stuck, english], 'web'), 'en stuck');
});

test('apps: 1080p before 4K, unless the 1080p file is known to lack the language', () => {
  const t = (language, codec) => [{ index: 0, language, codec, label: language, title: '', default: true }];
  const uhdHindi = { link: 'uhd-hi', type: 'mkv', height: 2160, audioTracks: t('hi', 'eac3') };
  const uhdUnknown = { link: 'uhd-?', type: 'mkv', height: 2160 };
  const hdUnknown = { link: 'hd-?', type: 'mkv', height: 1080 };
  const hdHindi = { link: 'hd-hi', type: 'mkv', height: 1080, audioTracks: t('hi', 'eac3') };
  const hdTamil = { link: 'hd-ta', type: 'mkv', height: 1080, audioTracks: t('ta', 'aac') };
  const hdStuck = { link: 'hd-stuck', type: 'mkv', height: 1080, seekable: false, audioTracks: t('hi', 'aac') };
  const order = list => audio.preferLanguage(list, 'hi', { client: 'app' }).map(s => s.link).join(' ');
  assert.equal(order([uhdHindi, uhdUnknown, hdStuck, hdTamil, hdUnknown, hdHindi]), 'hd-hi hd-? uhd-hi uhd-? hd-ta hd-stuck');
});

test('apps put an MKV without an index after ones that can jump, but before ones that cannot seek at all', () => {
  const t = [{ index: 0, language: 'hi', codec: 'aac', label: 'Hindi', title: '', default: true }];
  const noIndex = { link: 'no-index', type: 'mkv', height: 1080, noIndex: true, audioTracks: t };
  const stuck = { link: 'stuck', type: 'mkv', height: 1080, seekable: false, audioTracks: t };
  const uhd = { link: 'uhd', type: 'mkv', height: 2160, audioTracks: t };
  const order = client => audio.preferLanguage([stuck, noIndex, uhd], 'hi', { client }).map(s => s.link).join(' ');
  assert.equal(order('app'), 'uhd no-index stuck');
});
