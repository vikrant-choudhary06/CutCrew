// Audio tracks of a stream: which languages a file carries, what to call
// each track ("Hindi", "English 5.1"), and which one to play first.
//
// Tracks are read with ffprobe (MKV/MP4) or from an HLS master playlist
// (#EXT-X-MEDIA:TYPE=AUDIO). A track is
//   { index, language, label, codec, channels, title, default }
// where index counts audio tracks only (ffmpeg's 0:a:N, hls.js audioTracks[N])
// and language is a two-letter code ('hi', 'en', …) or '' when unknown.

// Language codes the app knows, with their English names.
const NAMES = {
  hi: 'Hindi', en: 'English', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam', kn: 'Kannada', bn: 'Bengali', mr: 'Marathi',
  gu: 'Gujarati', pa: 'Punjabi', or: 'Odia', ur: 'Urdu', bho: 'Bhojpuri', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
  es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', ru: 'Russian', ar: 'Arabic', tr: 'Turkish',
  th: 'Thai', id: 'Indonesian', vi: 'Vietnamese', pl: 'Polish', nl: 'Dutch', sv: 'Swedish', fa: 'Persian', he: 'Hebrew',
};
// ISO 639-2 (three-letter) tags as files write them, to the two-letter code.
const THREE = {
  hin: 'hi', eng: 'en', tam: 'ta', tel: 'te', mal: 'ml', kan: 'kn', ben: 'bn', mar: 'mr', guj: 'gu', pan: 'pa', ori: 'or',
  ory: 'or', urd: 'ur', bho: 'bho', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', cmn: 'zh', yue: 'zh', spa: 'es', fre: 'fr',
  fra: 'fr', ger: 'de', deu: 'de', ita: 'it', por: 'pt', rus: 'ru', ara: 'ar', tur: 'tr', tha: 'th', ind: 'id', vie: 'vi',
  pol: 'pl', dut: 'nl', nld: 'nl', swe: 'sv', per: 'fa', fas: 'fa', heb: 'he',
};
// Words in track titles (English and native script), checked when the tag is missing.
const WORDS = [
  ['hi', /\bhindi\b|हिन्दी|हिंदी|\bhin\b/i], ['en', /\benglish\b|\beng\b/i], ['ta', /\btamil\b|தமிழ்|\btam\b/i],
  ['te', /\btelugu\b|తెలుగు|\btel\b/i], ['ml', /\bmalayalam\b|മലയാളം|\bmal\b/i], ['kn', /\bkannada\b|ಕನ್ನಡ|\bkan\b/i],
  ['bn', /\bbengali\b|\bbangla\b|বাংলা/i], ['mr', /\bmarathi\b|मराठी/i], ['gu', /\bgujarati\b|ગુજરાતી/i],
  ['pa', /\bpunjabi\b|ਪੰਜਾਬੀ/i], ['ur', /\burdu\b|اردو/i], ['bho', /\bbhojpuri\b/i], ['ja', /\bjapanese\b|日本語|\bjpn\b/i],
  ['ko', /\bkorean\b|한국어|\bkor\b/i], ['zh', /\bchinese\b|\bmandarin\b|\bcantonese\b|中文/i], ['es', /\bspanish\b|espa[ñn]ol|\bcastellano\b|\blatino\b/i],
  ['fr', /\bfrench\b|fran[çc]ais/i], ['de', /\bgerman\b|deutsch/i], ['it', /\bitalian\b|italiano/i], ['pt', /\bportuguese\b|portugu[eê]s/i],
  ['ru', /\brussian\b|русский/i], ['ar', /\barabic\b|العربية/i], ['tr', /\bturkish\b|t[üu]rk[çc]e/i], ['th', /\bthai\b|ไทย/i],
  ['id', /\bindonesian\b|bahasa indonesia/i],
];

// Two-letter code from a tag ('hin', 'hi', 'en-US') and/or a title ('Hindi 5.1'), or ''.
function detectLanguage({ language, title, name } = {}) {
  const tag = String(language || '').trim().toLowerCase().split(/[-_]/)[0];
  if (tag && tag !== 'und' && tag !== 'unk' && tag !== 'mul' && tag !== 'zxx') {
    if (NAMES[tag]) return tag;
    if (THREE[tag]) return THREE[tag];
  }
  const text = [title, name].filter(Boolean).join(' ');
  for (const [code, pattern] of WORDS) if (pattern.test(text)) return code;
  // An unknown tag like "fil" is still a language: keep it rather than guess.
  return tag && /^[a-z]{2,3}$/.test(tag) && !['und', 'unk', 'mul', 'zxx'].includes(tag) ? tag : '';
}

const languageName = code => NAMES[code] || (code ? code.toUpperCase() : '');
const layout = channels => (channels >= 8 ? '7.1' : channels >= 6 ? '5.1' : '');

// "Hindi", "English 5.1", "Audio 2" (unknown language), "Tamil 5.1 · Commentary".
function trackLabel(track) {
  const base = track.language ? languageName(track.language) : `Audio ${track.index + 1}`;
  const extra = /commentary|director/i.test(track.title || '') ? 'Commentary' : '';
  return [[base, layout(track.channels)].filter(Boolean).join(' '), extra].filter(Boolean).join(' · ');
}

// ffprobe JSON streams → tracks (audio only, numbered among audio tracks).
function fromProbe(streams = []) {
  return streams.filter(s => s.codec_type === 'audio' || (s.codec_type === undefined && s.channels)).map((s, index) => {
    const title = s.tags?.title || s.tags?.TITLE || '';
    const track = { index, language: detectLanguage({ language: s.tags?.language || s.tags?.LANGUAGE, title }), codec: s.codec_name || '',
      channels: Number(s.channels) || 0, title, default: s.disposition?.default === 1 };
    return { ...track, label: trackLabel(track) };
  });
}

// HLS master playlist → audio renditions, in playlist order (as hls.js lists them).
function fromPlaylist(body) {
  const tracks = [];
  for (const line of String(body || '').split(/\r?\n/)) {
    if (!/^#EXT-X-MEDIA:/i.test(line) || !/TYPE=AUDIO/i.test(line)) continue;
    // NAME="Hindi" or CHANNELS=6; the [:,] before the name keeps ASSOC-LANGUAGE from matching LANGUAGE.
    const attr = name => { const m = line.match(new RegExp(`[:,]${name}=(?:"([^"]*)"|([^,]*))`, 'i')); return m ? (m[1] ?? m[2] ?? '') : ''; };
    const title = attr('NAME');
    const channels = Number(String(attr('CHANNELS')).split('/')[0]) || 0;
    const track = { index: tracks.length, language: detectLanguage({ language: attr('LANGUAGE'), title }), codec: '', channels, title,
      default: /^yes$/i.test(attr('DEFAULT')) };
    tracks.push({ ...track, label: trackLabel(track) });
  }
  return tracks;
}

// Preferred language from a request value, or the default (Hindi).
function preferredLanguage(value, fallback = 'hi') {
  const text = String(value || '').slice(0, 20);
  const code = detectLanguage({ language: text, title: text });
  return NAMES[code] ? code : fallback;
}

// Which track to play: the preferred language, then English, then the file's
// default track, then the first. matched says whether the preferred one was found.
function chooseTrack(tracks, preferred = 'hi') {
  if (!Array.isArray(tracks) || !tracks.length) return null;
  const find = code => tracks.find(t => t.language === code && !/commentary/i.test(t.title || ''));
  const hit = find(preferred);
  if (hit) return { index: hit.index, language: hit.language, matched: true };
  const pick = find('en') || tracks.find(t => t.default) || tracks[0];
  return { index: pick.index, language: pick.language, matched: false };
}

// Languages a browser can actually play from this stream: every track of an
// MKV (the server converts it with the chosen track) or HLS rendition, but only
// the default track of an MP4 (browsers cannot switch MP4 tracks).
function playableLanguages(stream, client = 'web') {
  const tracks = stream.audioTracks || [];
  if (!tracks.length) return [];
  if (client === 'web' && stream.type === 'mp4' && tracks.length > 1) {
    const first = tracks.find(t => t.default) || tracks[0];
    return first.language ? [first.language] : [];
  }
  return [...new Set(tracks.map(t => t.language).filter(Boolean))];
}

// Streams that surely carry the preferred language move up, keeping their
// order otherwise. Low quality (under 480p) and web-heavy MKV (needs a full
// re-encode, which stalls) are not moved above better streams.
function preferLanguage(streams, preferred, { client = 'web' } = {}) {
  if (!preferred) return streams;
  const heavy = s => client === 'web' && s.type === 'mkv' && (s.hevc || (s.height || 0) > 720);
  const boost = s => !heavy(s) && (!s.height || s.height >= 480) && playableLanguages(s, client).includes(preferred);
  const cost = s => (client === 'app' ? phoneCost(s, preferred) : 0);
  return streams.map((s, i) => ({ s, i, c: cost(s) })).sort((a, b) => (heavy(a.s) - heavy(b.s)) || (boost(b.s) - boost(a.s)) || a.c - b.c || a.i - b.i).map(x => x.s);
}

// How likely a phone is to fail on a stream (higher is worse): 4K video, and
// for the track that would play, E-AC3 (some phones) or DTS / TrueHD (most
// phones) audio. Unknown codecs and heights cost nothing.
function phoneCost(stream, preferred) {
  let cost = (stream.height || 0) > 1080 ? 2 : 0;
  const tracks = stream.audioTracks || [];
  const pick = chooseTrack(tracks, preferred);
  const codec = pick ? tracks.find(t => t.index === pick.index)?.codec || '' : '';
  if (/dts|truehd|mlp/i.test(codec)) cost += 2;
  else if (/eac3/i.test(codec)) cost += 1;
  return cost;
}

// Adds the chosen track to each stream: { audioIndex, audioLanguage, audioMatched }.
function withChoice(streams, preferred, client = 'web') {
  return streams.map(stream => {
    const tracks = stream.audioTracks || [];
    if (!tracks.length) return stream;
    // An MP4 on the web plays its default track whatever is chosen.
    const usable = client === 'web' && stream.type === 'mp4' && tracks.length > 1 ? [tracks.find(t => t.default) || tracks[0]] : tracks;
    const choice = chooseTrack(usable, preferred);
    return choice ? { ...stream, audioIndex: choice.index, audioLanguage: choice.language, audioMatched: choice.matched } : stream;
  });
}

// Reads a stream's tracks with ffprobe (needs the stream's headers), or [] on failure.
function readTracks(stream, { timeoutMs = 15000, run } = {}) {
  const exec = run || ((args, options) => new Promise((resolve, reject) => {
    require('child_process').execFile(process.env.FFPROBE_PATH || 'ffprobe', args, options, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  }));
  const headers = Object.entries(stream.headers || {}).filter(([k, v]) => !/[\r\n]/.test(`${k}${v}`)).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  const args = ['-v', 'error', ...(headers ? ['-headers', headers] : []), '-analyzeduration', '3000000', '-probesize', '2000000',
    '-select_streams', 'a', '-show_entries', 'stream=index,codec_type,codec_name,channels:stream_tags=language,title:stream_disposition=default',
    '-of', 'json', stream.link];
  return exec(args, { timeout: timeoutMs, maxBuffer: 1 << 20 }).then(out => fromProbe(JSON.parse(String(out)).streams || [])).catch(() => []);
}

// Fills audioTracks (and the language list `audio`) on the first few MKV/MP4
// streams; HLS streams get theirs from the probe of the playlist.
async function addTracks(streams, { read = readTracks, limit = 4 } = {}) {
  await Promise.all(streams.filter(s => s.type !== 'hls' && !s.audioTracks?.length).slice(0, limit).map(async stream => {
    const tracks = await read(stream);
    if (tracks.length) setTracks(stream, tracks);
  }));
  return streams;
}
function setTracks(stream, tracks) {
  stream.audioTracks = tracks;
  const names = [...new Set(tracks.map(t => t.language).filter(Boolean).map(languageName))];
  if (names.length) stream.audio = names;
}

// Keeps only well-formed tracks (cached data is checked before use).
function cleanTracks(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 32).flatMap((t, i) => (t && Number.isInteger(t.index) && t.index >= 0 && t.index < 64
    ? [{ index: t.index, language: typeof t.language === 'string' ? t.language.slice(0, 3) : '', label: typeof t.label === 'string' ? t.label.slice(0, 60) : `Audio ${i + 1}`,
      codec: typeof t.codec === 'string' ? t.codec.slice(0, 20) : '', channels: Number(t.channels) || 0, title: typeof t.title === 'string' ? t.title.slice(0, 80) : '', default: !!t.default }]
    : []));
}

module.exports = {
  NAMES, detectLanguage, languageName, trackLabel, fromProbe, fromPlaylist, preferredLanguage, chooseTrack, playableLanguages,
  preferLanguage, phoneCost, withChoice, readTracks, addTracks, setTracks, cleanTracks,
};
