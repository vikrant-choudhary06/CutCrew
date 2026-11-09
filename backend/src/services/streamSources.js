// Multi-source playback. Two kinds of sources, one stream format:
//   vega    - CutCrew's provider modules (provider/dist), via attemptProvider()
//   stremio - Stremio add-on APIs (/stream/<type>/<imdbId>.json): DesiFlix,
//             HdHub, CENSORED, PenguPlay (listed in STREMIO_ADDONS)
// All enabled sources run in parallel, each with its own time limit. A slow or
// failing source is skipped without holding up the others. Results are
// probed, de-duplicated and ranked (web-playable first, then source order,
// then quality and audio language).
const fs = require('fs');
const path = require('path');
const { getAvailableProvidersLocal } = require('../utils/providerHelper');
const { isSeries } = require('./movieService');
const { validateUrl } = require('./mediaService');
const sourceProbe = require('./sourceProbe');
const providerStatus = require('./providerStatus');

const DEFAULT_ORDER = ['desiflix', 'hdhub', 'censored', 'pengu', '4khdhub', 'internetArchive'];
const API_TIMEOUT_MS = Number(process.env.SOURCE_TIMEOUT_MS) || 10000;
const VEGA_TIMEOUT_MS = Number(process.env.VEGA_SOURCE_TIMEOUT_MS) || 25000;
const WAIT_MS = Number(process.env.SOURCE_WAIT_MS) || 10000;
// How long an answer waits for the file inspection (codec, audio tracks) after
// a source has found its streams; the inspection itself may take longer.
const INSPECT_WAIT_MS = Number(process.env.SOURCE_INSPECT_WAIT_MS) || 5000;
const stateFile = () => process.env.SOURCE_STATE_FILE || path.resolve(__dirname, '../../.local/provider-check/source-state.json');

// Stremio add-ons: STREMIO_ADDONS="id=https://base,id=https://base". Without
// it, the public DesiFlix, HdHub and CENSORED add-ons are used. PenguPlay only
// answers with a "You must sign in" video unless the link carries your own
// sign-in, so it runs only when its link has a path after the host.
const DEFAULT_ADDONS = 'desiflix=https://manifest.desitvhub.eu.org,hdhub=https://hdhub.thevolecitor.qzz.io,censored=https://censoredaddon.vercel.app';
const ADDON_INFO = {
  desiflix: { label: 'DesiFlix' }, hdhub: { label: 'HdHub' },
  // PenguPlay prepares each file when it is first asked for, which can take
  // several seconds; later requests are quick.
  pengu: { label: 'PenguPlay', timeoutMs: 25000, probeTimeoutMs: 12000 },
  // CENSORED gathers many sites and often needs 5–20 s.
  censored: { label: 'CENSORED', timeoutMs: 20000 },
};
function stremioAddons() {
  const addons = {};
  for (const part of (process.env.STREMIO_ADDONS ?? DEFAULT_ADDONS).split(',')) {
    const at = part.indexOf('=');
    const id = part.slice(0, at).trim(), raw = part.slice(at + 1).trim();
    if (at < 1 || !/^[a-z][a-z0-9_]{0,29}$/i.test(id) || !/^https:\/\/[^\s]+$/i.test(raw)) continue;
    const base = raw.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');
    addons[id] = {
      kind: 'stremio', label: ADDON_INFO[id]?.label || id, base: () => base,
      timeoutMs: () => Number(process.env[`${id.toUpperCase()}_TIMEOUT_MS`]) || ADDON_INFO[id]?.timeoutMs || API_TIMEOUT_MS,
      probeTimeoutMs: () => ADDON_INFO[id]?.probeTimeoutMs,
      configured: () => id !== 'pengu' || new URL(base).pathname.length > 1,
    };
  }
  return addons;
}

// Nuvio providers (third-party, obfuscated code) run in the separate
// nuvio-runner container, which holds no secrets; the backend only asks it for
// links. On when NUVIO_URL is set; NUVIO_SOURCES picks which ones.
const NUVIO_INFO = {
  castle: { label: 'Castle' },
  // MovieBox signs every request and often needs 5–15 s.
  moviebox: { label: 'MovieBox', timeoutMs: 25000 },
  playimdb: { label: 'PlayIMDb' },
  einthusan: { label: 'Einthusan' },
  // NAMA: Indian dubs of anime (and, for MultiMovies, films and series), one
  // stream per resolution carrying every audio language.
  watchanimeworld: { label: 'WatchAnimeWorld' },
  multimovies: { label: 'MultiMovies', timeoutMs: 35000 },
};
function nuvioSources() {
  const base = String(process.env.NUVIO_URL || '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/i.test(base)) return {};
  const sources = {};
  for (const id of (process.env.NUVIO_SOURCES || Object.keys(NUVIO_INFO).join(',')).split(',').map(x => x.trim())) {
    if (!NUVIO_INFO[id]) continue;
    sources[id] = { kind: 'nuvio', label: NUVIO_INFO[id].label, base: () => base,
      timeoutMs: () => Number(process.env[`${id.toUpperCase()}_TIMEOUT_MS`]) || NUVIO_INFO[id].timeoutMs || 15000 };
  }
  return sources;
}

const sourceDef = id => stremioAddons()[id] || nuvioSources()[id] || null;

// ---- Source list ---------------------------------------------------------

let stateCache = { at: 0, value: {} };
function sourceState() {
  if (Date.now() - stateCache.at < 60000) return stateCache.value;
  let value = {};
  try { value = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { /* no checks yet */ }
  stateCache = { at: Date.now(), value };
  return value;
}
const resetStateCache = () => { stateCache = { at: 0, value: {} }; };

// Default order from provider/provider-policy.json (streamSources), else DEFAULT_ORDER.
function policyOrder() {
  try {
    const policy = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../provider/provider-policy.json'), 'utf8'));
    if (Array.isArray(policy.streamSources) && policy.streamSources.length) return policy.streamSources;
  } catch { /* fall back */ }
  return DEFAULT_ORDER;
}

// STREAM_SOURCES lists the sources in order (remove a name, or set
// SOURCE_<NAME>=off, e.g. SOURCE_CENSORED=off, to turn one off).
// Vega names also need to be installed and allowed by ENABLED_PROVIDERS.
// Enabled vega providers missing from the list run last. A source the weekly
// check turned off (see check-sources.cjs) is skipped until it passes again.
function sourceOrder({ includeOff = false, includeSwitchedOff = false } = {}) {
  const wanted = (process.env.STREAM_SOURCES || policyOrder().join(',')).split(',').map(id => id.trim()).filter(Boolean);
  const vega = getAvailableProvidersLocal();
  const vegaAll = includeSwitchedOff ? getAvailableProvidersLocal({ includeSwitchedOff: true }) : vega;
  const list = [...new Set([...wanted, ...vegaAll])].filter(id => {
    if (process.env[`SOURCE_${id.toUpperCase()}`] === 'off') return false;
    // Switched off in the admin panel.
    if (!includeSwitchedOff && require('./providerSwitches').isOff(id)) return false;
    const def = sourceDef(id);
    return def ? (!def.configured || def.configured()) : vegaAll.includes(id);
  });
  if (includeOff) return list;
  const state = sourceState();
  return list.filter(id => !state[id]?.disabled);
}
const kindOf = id => sourceDef(id)?.kind || 'vega';
const labelOf = id => sourceDef(id)?.label || id;

// ---- Parsing stream descriptions ------------------------------------------

const LANGUAGES = ['Hindi', 'English', 'Tamil', 'Telugu', 'Malayalam', 'Kannada', 'Bengali', 'Marathi', 'Punjabi', 'Gujarati', 'Japanese', 'Korean', 'Spanish', 'French'];

function qualityOf(text) {
  const value = String(text || '');
  if (/\b(2160p?|4k|uhd)\b/i.test(value)) return 2160;
  const match = /\b(1440|1080|720|576|480|360|240)p?\b/i.exec(value);
  if (match) return Number(match[1]);
  if (/\bfhd\b/i.test(value)) return 1080;
  return 0;
}

function audioOf(text) {
  const value = String(text || '');
  const line = /audio\s*[:\-]\s*([^\n|•]+)/i.exec(value)?.[1] || value;
  const found = LANGUAGES.filter(language => new RegExp(`\\b${language}\\b`, 'i').test(line));
  if (/\b(dual|multi)[\s-]*audio\b/i.test(value) && !found.length) found.push('Hindi', 'English');
  if (!found.length && /\bhin\b/i.test(line)) found.push('Hindi');
  return found;
}

function sizeOf(text, hinted) {
  if (Number(hinted) > 0) return Number(hinted);
  const match = /([\d.]+)\s*(TB|GB|MB)\b/i.exec(String(text || ''));
  if (!match) return 0;
  return Math.round(Number(match[1]) * { TB: 1e12, GB: 1e9, MB: 1e6 }[match[2].toUpperCase()]);
}

function typeOf(link, filename, declared) {
  const value = `${declared || ''} ${link} ${filename || ''}`;
  if (/m3u8|mpegurl|\bhls\b/i.test(value)) return 'hls';
  if (/\.mkv\b|matroska|\bmkv\b/i.test(value)) return 'mkv';
  return 'mp4';
}

// Not a film: notices such as "You must sign in", sales or support links.
const PLACEHOLDER = /\b(sign[\s-]?in|log[\s-]?in|subscribe|upgrade|donate|support us|discount|sale|legacy users?)\b/i;

// Stremio stream object -> CutCrew stream. Only direct `url` streams:
// torrents (infoHash), YouTube (ytId) and web pages (externalUrl) are skipped.
function fromAddon(item, source) {
  const link = item?.url;
  if (typeof link !== 'string' || item.infoHash || item.ytId) return null;
  if (PLACEHOLDER.test([item.name, item.title, item.description].filter(Boolean).join(' '))) return null;
  let url;
  try { url = validateUrl(link); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const hints = item.behaviorHints || {};
  const text = [item.name, item.title, item.description, hints.filename].filter(Boolean).join('\n');
  const filename = hints.filename || item.fileName || '';
  const headers = { ...(hints.proxyHeaders?.request || {}), ...(item.headers || {}) };
  const quality = qualityOf(item.quality || text);
  const audio = audioOf(text);
  const firstLine = String(item.title || item.description || item.name || '').split('\n')[0].trim();
  return {
    link, type: typeOf(link, filename, item.type), provider: source,
    server: [labelOf(source), firstLine].filter(Boolean).join(' · ').slice(0, 120),
    quality: quality ? (quality === 2160 ? '4K' : `${quality}p`) : '', height: quality,
    language: audio.join(', '), audio, size: sizeOf(text, hints.videoSize || item.size), filename,
    hevc: /\b(hevc|x265|h\.?265|10.?bit)\b/i.test(text),
    headers, subtitles: Array.isArray(item.subtitles) ? item.subtitles.filter(s => s?.url).map(s => ({ uri: s.url, language: s.lang || '', title: s.lang || 'Subtitles' })) : [],
  };
}

// ---- Adapters --------------------------------------------------------------

// Stremio stream id: tt123 for a movie, tt123:1:2 for an episode.
function stremioId(imdbId, season, episode) {
  return season && episode ? `${imdbId}:${season}:${episode}` : imdbId;
}

async function stremioStreams(source, title, { signal, fetch: get = fetch } = {}) {
  const base = sourceDef(source).base();
  const series = isSeries(title);
  const url = `${base}/stream/${series ? 'series' : 'movie'}/${encodeURIComponent(stremioId(title.imdb_id, series && title.season, series && title.episode))}.json`;
  const response = await get(url, { headers: { Accept: 'application/json', 'User-Agent': 'CutCrew/1.0' }, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  return (Array.isArray(body?.streams) ? body.streams : []).map(item => fromAddon(item, source)).filter(Boolean);
}

// TMDB id for an IMDb title (the Nuvio providers want it), from Cinemeta,
// which needs no key. Kept for a day; a failed lookup is tried again later.
const tmdbCache = new Map();
async function tmdbIdOf(title, { signal, fetch: get = fetch } = {}) {
  const series = isSeries(title);
  const key = `${series ? 'series' : 'movie'}:${title.imdb_id}`;
  const cached = tmdbCache.get(key);
  if (cached && cached.until > Date.now()) return cached.id;
  let id = null;
  try {
    const response = await get(`https://v3-cinemeta.strem.io/meta/${series ? 'series' : 'movie'}/${encodeURIComponent(title.imdb_id)}.json`, { headers: { Accept: 'application/json' }, signal });
    if (response.ok) id = Number((await response.json())?.meta?.moviedb_id) || null;
  } catch (error) { if (signal?.aborted) throw error; }
  if (tmdbCache.size > 5000) tmdbCache.delete(tmdbCache.keys().next().value);
  tmdbCache.set(key, { id, until: Date.now() + (id ? 86400000 : 600000) });
  return id;
}

const isAnimated = title => title?.kind === 'anime' || [title?.genres].flat().some(g => /anim/i.test(String(g || '')));
const PACKED = 'data:application/vnd.apple.mpegurl;base64,';

// A stream whose link is a playlist packed into a data: link: kept as text
// (the relay serves it), checked through its first variant.
function fromPacked(item, source) {
  const { playlistUris } = require('./mediaService');
  const { fromPlaylist, languageName } = require('./audioTracks');
  let doc;
  try { doc = Buffer.from(item.url.slice(PACKED.length), 'base64').toString('utf8'); } catch { return null; }
  if (!doc.trimStart().startsWith('#EXTM3U')) return null;
  const variant = playlistUris(doc).find(uri => /^https?:\/\//i.test(uri) && !doc.includes(`URI="${uri}"`));
  if (!variant) return null;
  const stream = fromAddon({ ...item, url: variant }, source);
  if (!stream) return null;
  const audioTracks = fromPlaylist(doc);
  const names = [...new Set(audioTracks.map(t => languageName(t.language) || t.title).filter(Boolean))];
  return { ...stream, type: 'hls', playlist: doc, audioTracks, audio: names, language: names.join(', ') || stream.language };
}

async function nuvioStreams(source, title, { signal, fetch: get = fetch, tmdb: givenTmdb, type: givenType, season: givenSeason, episode: givenEpisode } = {}) {
  const tmdb = givenTmdb || await tmdbIdOf(title, { signal, fetch: get });
  if (!tmdb) return [];
  const series = givenType ? givenType === 'tv' : isSeries(title);
  const query = new URLSearchParams({ provider: source, tmdb: String(tmdb), type: series ? 'tv' : 'movie',
    ...(series ? { season: String(givenSeason || title.season || 1), episode: String(givenEpisode || title.episode || 1) } : {}) });
  const response = await get(`${sourceDef(source).base()}/streams?${query}`, { headers: { Accept: 'application/json' }, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  // Same shape as a Stremio add-on stream, so the same checks apply.
  const streams = (Array.isArray(body?.streams) ? body.streams : []).map(item => {
    const shaped = { url: item.url, name: item.name, title: item.title, description: typeof item.size === 'string' ? item.size : undefined,
      quality: item.quality, type: item.type, size: Number(item.size) || undefined, behaviorHints: { proxyHeaders: { request: item.headers || {} } } };
    return String(item.url).startsWith(PACKED) ? fromPacked(shaped, source) : fromAddon(shaped, source);
  }).filter(Boolean);
  // NAMA also sends one copy per language; the multi-audio one is enough.
  const multi = streams.filter(s => (s.audioTracks?.length || 0) > 1);
  return multi.length ? streams.filter(s => !s.playlist || (s.audioTracks?.length || 0) > 1) : streams;
}

// Video length in seconds (ffprobe), or null when it cannot be read.
function durationOf(stream, { timeoutMs = 8000, run } = {}) {
  const exec = run || ((args, options) => new Promise((resolve, reject) => {
    require('child_process').execFile(process.env.FFPROBE_PATH || 'ffprobe', args, options, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  }));
  const headers = Object.entries(stream.headers || {}).filter(([k, v]) => !/[\r\n]/.test(`${k}${v}`)).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  const args = ['-v', 'error', ...(headers ? ['-headers', headers] : []), '-show_entries', 'format=duration', '-of', 'csv=p=0', stream.link];
  return exec(args, { timeout: timeoutMs }).then(out => { const value = Number(String(out).trim()); return Number.isFinite(value) && value > 0 ? value : null; }).catch(() => null);
}
// Video codec of a stream: { codec, tenBit, height } (ffprobe), or null.
function videoOf(stream, { timeoutMs = 6000, run } = {}) {
  const exec = run || ((args, options) => new Promise((resolve, reject) => {
    require('child_process').execFile(process.env.FFPROBE_PATH || 'ffprobe', args, options, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  }));
  const headers = Object.entries(stream.headers || {}).filter(([k, v]) => !/[\r\n]/.test(`${k}${v}`)).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  const args = ['-v', 'error', ...(headers ? ['-headers', headers] : []), '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt,height', '-of', 'csv=p=0', stream.link];
  return exec(args, { timeout: timeoutMs }).then(out => {
    const [codec, pixFmt, height] = String(out).trim().split(/\r?\n/)[0].split(',');
    return codec ? { codec, tenBit: /10|12/.test(pixFmt || ''), height: Number(height) || 0 } : null;
  }).catch(() => null);
}
// MKV files that a browser cannot get by a plain copy (the server must re-encode).
async function markHeavy(streams, measure = videoOf) {
  await Promise.all(streams.filter(s => s.type === 'mkv').slice(0, 4).map(async stream => applyVideo(stream, await measure(stream))));
  return streams;
}
function applyVideo(stream, video) {
  if (!video) return;
  if (video.codec !== 'h264' || video.tenBit) stream.hevc = true;
  // Cinema crops are wide and short (3840x1608, 1920x816, 1280x534), so width counts too.
  const uhd = (video.width || 0) >= 3200 || video.height >= 1500;
  if (uhd) stream.height = 2160;
  else if (!stream.height && video.height) stream.height = video.height >= 760 || (video.width || 0) >= 1800 ? 1080 : video.height >= 500 || (video.width || 0) >= 1200 ? 720 : video.height >= 280 ? 480 : video.height;
}
// Video codec and every audio track of a file in one ffprobe: { video, tracks }, or null.
function mediaOf(stream, { timeoutMs = 15000, run } = {}) {
  const exec = run || ((args, options) => new Promise((resolve, reject) => {
    require('child_process').execFile(process.env.FFPROBE_PATH || 'ffprobe', args, options, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  }));
  const headers = Object.entries(stream.headers || {}).filter(([k, v]) => !/[\r\n]/.test(`${k}${v}`)).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  const args = ['-v', 'error', ...(headers ? ['-headers', headers] : []), '-analyzeduration', '3000000', '-probesize', '2000000',
    '-show_entries', 'stream=index,codec_type,codec_name,pix_fmt,width,height,channels:stream_tags=language,title:stream_disposition=default', '-of', 'json', stream.link];
  return exec(args, { timeout: timeoutMs, maxBuffer: 1 << 20 }).then(out => {
    const list = JSON.parse(String(out)).streams || [];
    const v = list.find(s => s.codec_type === 'video');
    return { video: v ? { codec: v.codec_name, tenBit: /10|12/.test(v.pix_fmt || ''), width: Number(v.width) || 0, height: Number(v.height) || 0 } : null,
      tracks: require('./audioTracks').fromProbe(list) };
  }).catch(() => null);
}

// Codec and audio tracks of the first files, read in parallel (two ffprobes each).
async function inspect(streams, options = {}) {
  const audio = require('./audioTracks');
  if (options.videoOf || options.readTracks) {
    await Promise.all([markHeavy(streams, options.videoOf), audio.addTracks(streams, { read: options.readTracks })]);
    return streams;
  }
  await Promise.all(streams.filter(s => s.type !== 'hls').slice(0, 4).map(async stream => {
    const media = await (options.mediaOf || mediaOf)(stream);
    if (!media) return;
    if (stream.type === 'mkv') applyVideo(stream, media.video);
    if (media.tracks.length && !stream.audioTracks?.length) audio.setTracks(stream, media.tracks);
  }));
  return streams;
}

// Shortest believable length: films 10 minutes, episodes 3 minutes.
const minimumLength = title => (isSeries(title) ? 180 : 600);

function withTimeout(work, ms, controller) {
  let timer;
  return Promise.race([
    work,
    new Promise((_, reject) => { timer = setTimeout(() => { controller?.abort(); reject(new Error('timed out')); }, ms); }),
  ]).finally(() => clearTimeout(timer));
}

// One source, start to finish (find, then probe), within its time limit.
// Resolves to { source, streams, candidate?, ms, error? } and never rejects.
// Internet Archive only has public-domain and Creative Commons films. For
// newer titles it returns trailers or uploads of the wrong thing, so it only
// runs for films up to IA_MAX_YEAR (default 1980).
function skipReason(source, title) {
  const maxYear = Number(process.env.IA_MAX_YEAR) || 1980;
  if (source === 'internetArchive' && Number(title.release_year) > maxYear) return `only for films up to ${maxYear}`;
  if (kindOf(source) === 'nuvio' && !/^tt\d{5,12}$/.test(title.imdb_id || '')) return 'needs an IMDb title';
  // Einthusan has Indian films only.
  if (source === 'einthusan' && (isSeries(title) || !isIndian(title))) return 'Indian films only';
  // WatchAnimeWorld has anime and cartoons only.
  if (source === 'watchanimeworld' && !isAnimated(title)) return 'animation only';
  return '';
}

async function runSource(source, title, options = {}) {
  const skipped = skipReason(source, title);
  if (skipped) return { source, streams: [], ms: 0, skipped };
  const started = Date.now();
  const controller = new AbortController();
  const kind = kindOf(source);
  const limit = options.timeoutMs || sourceDef(source)?.timeoutMs?.() || (kind === 'vega' ? VEGA_TIMEOUT_MS : API_TIMEOUT_MS);
  const probe = options.probe || (streams => sourceProbe.filterPlayable(streams, { signal: controller.signal, timeoutMs: sourceDef(source)?.probeTimeoutMs?.() }));
  try {
    const result = await withTimeout((async () => {
      if (kind === 'vega') {
        const attempt = options.attemptProvider || require('./providerService').attemptProvider;
        const found = await attempt(title.movie || title, source, { season: title.season, episode: title.episode, rediscover: options.rediscover, timeoutMs: limit });
        const streams = (found?.streams || []).map(stream => ({ ...stream, provider: source, server: [labelOf(source), stream.server].filter(Boolean).join(' · '), height: qualityOf(stream.quality), audio: [] }));
        return { streams, candidate: found?.candidate };
      }
      const found = kind === 'nuvio'
        ? await nuvioStreams(source, title, { signal: controller.signal, fetch: options.fetch })
        : await stremioStreams(source, title, { signal: controller.signal, fetch: options.fetch });
      // The probe checks only the first few, so put the best ones first.
      const indian = isIndian(title);
      const best = [...found].sort((a, b) => audioScore(a, indian) - audioScore(b, indian) || (b.height || 0) - (a.height || 0));
      return { streams: best.length ? await probe(best) : [] };
    })(), limit, controller);
    const ms = Date.now() - started;
    providerStatus.record(source, result.streams.length > 0, ms);
    // Outside the source's time limit: the file inspection never fails a source.
    let inspection;
    if (!options.skipCodec && result.streams.length) {
      inspection = inspect(result.streams, options).catch(() => result.streams);
      await Promise.race([inspection, new Promise(resolve => setTimeout(resolve, options.inspectWaitMs ?? INSPECT_WAIT_MS))]);
    }
    return { source, ...result, ms, ...(inspection ? { inspection } : {}) };
  } catch (error) {
    const ms = Date.now() - started;
    providerStatus.record(source, false, ms);
    return { source, streams: [], ms, error: error.message || 'failed' };
  }
}

// ---- Ranking and duplicates ------------------------------------------------

// The same file often comes from several sources: same name and size, or the
// same host and path with different query strings.
function duplicateKeys(stream) {
  const keys = [stream.link];
  try { const url = new URL(stream.link); keys.push(`path:${url.host}${url.pathname}`); } catch { /* invalid links are dropped earlier */ }
  if (stream.filename) keys.push(`file:${stream.filename.toLowerCase().replace(/\.[a-z0-9]{2,4}$/, '')}:${stream.size ? Math.round(stream.size / 5e7) : '?'}`);
  return keys;
}

function dedupe(streams) {
  const seen = new Set();
  return streams.filter(stream => {
    const keys = duplicateKeys(stream);
    if (keys.some(key => seen.has(key))) return false;
    keys.forEach(key => seen.add(key));
    return true;
  });
}

// Web: MP4/HLS before MKV (MKV needs a server-side conversion in the browser).
// Among MKV files, ones the server can pass through (H.264, up to 720p) come
// before HEVC / 10-bit / higher ones: those need a full re-encode, which is
// heavy and still comes out at 720p (DesiFlix's 1080p files are often HEVC).
// Then source order, then higher quality, then Hindi + English, Hindi, English.
// Apps play MKV themselves, so they get plain source order and quality.
// Indian titles: Hindi first. Others: Hindi + English, then English, then Hindi.
// Unknown audio comes before other languages.
function audioScore(stream, indian = false) {
  const audio = stream.audio || [];
  const hindi = audio.includes('Hindi'), english = audio.includes('English');
  if (indian) return hindi && english ? 0 : hindi ? 1 : english ? 2 : audio.length ? 4 : 3;
  return hindi && english ? 0 : english ? 1 : hindi ? 2 : audio.length ? 4 : 3;
}
const isIndian = title => [title?.countries, title?.country].flat().filter(Boolean).some(value => /india/i.test(String(value)));

function rank(streams, order, { client = 'web', indian = false } = {}) {
  const position = id => { const index = order.indexOf(id); return index < 0 ? order.length : index; };
  const tier = stream => (client === 'web' && stream.type === 'mkv' ? 1 : 0);
  const heavy = stream => (client === 'web' && stream.type === 'mkv' && (stream.hevc || (stream.height || 0) > 720) ? 1 : 0);
  return [...streams].sort((a, b) => tier(a) - tier(b) || heavy(a) - heavy(b) || position(a.provider) - position(b.provider)
    || (b.height || 0) - (a.height || 0) || audioScore(a, indian) - audioScore(b, indian));
}

// ---- All sources together ------------------------------------------------------

// Runs every enabled source in parallel. Answers as soon as all sources have
// finished, or after `waitMs` once at least one stream was found. Sources that
// finish later are passed to `onLate` with the complete list, so the cache can
// be updated for the next request.
// goodEnough: answer after waitMs only once a found stream passes it (until
// maxWaitMs); without it, any stream will do.
async function collectStreams(movie, { season, episode, excludedProviders = [], rediscover = false, client = 'web', waitMs = WAIT_MS, maxWaitMs = 0, goodEnough, onLate, run = runSource, order: given } = {}) {
  const order = (given || sourceOrder()).filter(id => !excludedProviders.includes(id));
  const title = { ...movie, season, episode, movie };
  const results = [];
  const started = Date.now();
  let answered = false;
  const finish = () => {
    const ok = results.filter(r => r.streams.length);
    const streams = rank(dedupe(ok.flatMap(r => r.streams)), order, { client, indian: isIndian(movie) });
    const vega = ok.find(r => r.candidate);
    return {
      streams, provider: streams[0]?.provider || '', candidate: vega?.candidate || null,
      // Resolves when every file inspection has finished (the streams are updated in place).
      inspection: Promise.allSettled(ok.map(r => r.inspection).filter(Boolean)),
      sources: order.map(id => {
        const r = results.find(item => item.source === id);
        return r ? { source: id, streams: r.streams.length, ms: r.ms, ...(r.error ? { error: r.error } : {}), ...(r.skipped ? { skipped: r.skipped } : {}) } : { source: id, pending: true };
      }),
      ms: Date.now() - started,
    };
  };
  const all = Promise.all(order.map(id => run(id, title, { rediscover }).then(result => { results.push(result); return result; })));
  all.then(() => { if (answered && onLate) onLate(finish()); }).catch(() => {});

  let result;
  if (!order.length) result = finish();
  else {
    // Wait for everything, but stop early once waitMs has passed and something plays.
    result = await new Promise(resolve => {
      let timer;
      const check = () => {
        const elapsed = Date.now() - started;
        const found = results.flatMap(r => r.streams);
        const enough = goodEnough && elapsed < maxWaitMs ? found.some(goodEnough) : found.length > 0;
        if (results.length === order.length || (elapsed >= waitMs && enough)) {
          clearInterval(timer); resolve(finish());
        }
      };
      timer = setInterval(check, 200);
      all.then(check);
    });
  }
  answered = results.length < order.length;
  if (!result.streams.length) throw Object.assign(new Error('No playable sources found. Please try again later.'), { status: 503, sources: result.sources });
  return result;
}

module.exports = {
  collectStreams, runSource, skipReason, nuvioStreams, tmdbIdOf, nuvioSources, fromPacked, isAnimated, durationOf, videoOf, markHeavy, mediaOf, inspect, minimumLength, sourceOrder, sourceDef, stremioAddons, isIndian, audioScore, sourceState, resetStateCache, stateFile, rank, dedupe, duplicateKeys, fromAddon,
  qualityOf, audioOf, sizeOf, typeOf, stremioId, kindOf, labelOf, DEFAULT_ORDER,
};
