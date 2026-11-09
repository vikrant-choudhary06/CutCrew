// Anime playback: AniList title + episode number -> a playable stream from the
// anime providers (provider/anime/animeparadise, bundled into provider/dist-anime/anime.cjs).
// Providers are tried in ANIME_PROVIDERS order; ANIME_PLAYBACK=false turns
// playback off while the catalogue keeps working.
const path = require('path');
const anilist = require('./anilist');

const BUNDLE = process.env.ANIME_PROVIDER_BUNDLE || path.resolve(__dirname, '../../../provider/dist-anime/anime.cjs');
const MATCH_MS = 24 * 3600000, MISS_MS = 3600000, UNITS_MS = 30 * 60000;
const NAMES = { animeparadise: 'AnimeParadise' };

let sdk;
function load() {
  if (sdk === undefined) {
    try { sdk = require(BUNDLE); } catch { sdk = null; }
  }
  return sdk;
}

const playbackEnabled = () => process.env.ANIME_PLAYBACK !== 'false';
function providerIds({ includeSwitchedOff = false } = {}) {
  const bundle = load();
  if (!bundle) return [];
  const wanted = (process.env.ANIME_PROVIDERS || 'animeparadise').split(',').map(id => id.trim()).filter(Boolean);
  // Switched off in the admin panel.
  return wanted.filter(id => bundle.PROVIDERS[id] && (includeSwitchedOff || !require('./providerSwitches').isOff(id)));
}

const instances = new Map();
function provider(id) {
  if (!instances.has(id)) instances.set(id, load().createProvider(id, 20000));
  return instances.get(id);
}

const memo = new Map();
async function remembered(key, ms, missMs, work) {
  const hit = memo.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await work();
  if (memo.size > 2000) memo.delete(memo.keys().next().value);
  memo.set(key, { value, until: Date.now() + (value ? ms : missMs) });
  return value;
}

const normalize = text => String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[×✕]/g, 'x').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

// AniList cover URLs carry the AniList id ("…/cover/large/bx140960-….jpg").
// Providers that reuse AniList artwork can be matched on that exactly.
function anilistIdFromImage(url) {
  const match = /anilistcdn\/media\/anime\/cover\/[a-z]+\/(?:bx|nx|b|n)?(\d+)-/i.exec(String(url || ''));
  return match ? Number(match[1]) : null;
}

// Best search result for this AniList entry: same AniList artwork first,
// otherwise an exact title match (with the year when the provider gives one).
function pickResult(anime, results) {
  const exact = results.find(r => anilistIdFromImage(r.thumbnailUrl) === anime.anilist_id);
  if (exact) return exact;
  const names = new Set([anime.title, anime.romaji_title, anime.native_title, ...(anime.synonyms || [])].map(normalize).filter(Boolean));
  return results.find(r => {
    if (!names.has(normalize(r.title))) return false;
    if (r.year && anime.release_year && r.year !== anime.release_year) return false;
    const other = anilistIdFromImage(r.thumbnailUrl);
    return !other || other === anime.anilist_id;
  }) || null;
}

function searchTerms(anime) {
  const terms = [anime.title, anime.romaji_title, ...(anime.synonyms || []).slice(0, 2)].filter(Boolean);
  // Also try the series name without a season suffix, which some sites drop.
  for (const term of [...terms]) {
    const base = term.replace(/\s*[:\-–]?\s*(season\s*\d+|part\s*\d+|cour\s*\d+|\d+(st|nd|rd|th)\s+season)\b.*$/i, '').trim();
    if (base && base !== term) terms.push(base);
  }
  return [...new Set(terms.map(t => t.slice(0, 80)))].slice(0, 5);
}

async function findMedia(providerId, anime) {
  return remembered(`match:${providerId}:${anime.anilist_id}`, MATCH_MS, MISS_MS, async () => {
    const seen = new Map();
    for (const term of searchTerms(anime)) {
      let results = [];
      try { results = await provider(providerId).search(term); } catch { continue; }
      for (const result of results) if (!seen.has(result.id)) seen.set(result.id, result);
      const found = pickResult(anime, [...seen.values()]);
      if (found) return { id: found.id, title: found.title, exact: anilistIdFromImage(found.thumbnailUrl) === anime.anilist_id };
    }
    return null;
  });
}

async function units(providerId, mediaId) {
  return remembered(`units:${providerId}:${mediaId}`, UNITS_MS, 60000, async () => {
    const list = await provider(providerId).fetchContentUnits(mediaId);
    return Array.isArray(list) && list.length ? list : null;
  });
}

// SDK stream -> the stream shape the CutCrew player and media relay use.
function toStream(stream, providerId) {
  return {
    link: stream.sourceUrl,
    type: stream.isHLS ? 'hls' : 'mp4',
    headers: stream.headers || {},
    server: NAMES[providerId] || providerId,
    quality: !stream.quality || stream.quality === 'auto' ? 'Auto' : stream.quality,
    language: stream.language === 'dub' ? 'Dubbed' : 'Japanese',
    subtitles: (stream.subtitles || []).filter(track => ['vtt', 'srt'].includes(track.format) || /\.(vtt|srt)(\?|$)/i.test(track.url))
      .map(track => ({ uri: track.url, language: track.language || '', title: track.label || track.language || 'Subtitles', type: track.format || (/\.srt/i.test(track.url) ? 'srt' : 'vtt') })),
  };
}

// English first, and shown from the start: the audio is Japanese.
function englishFirst(streams) {
  const english = track => /^en/i.test(track.language) || /english/i.test(track.title);
  for (const stream of streams) {
    stream.subtitles.sort((a, b) => Number(english(b)) - Number(english(a)));
    if (stream.subtitles.length) stream.defaultSubtitle = 0;
  }
  return streams;
}

async function play(anilistId, episode, { exclude = [], language = 'hi' } = {}) {
  if (!playbackEnabled()) throw Object.assign(new Error('Anime playback is turned off right now.'), { status: 503 });
  const ids = providerIds().filter(id => !exclude.includes(id));
  if (!ids.length && !require('./animeNama').SOURCES.some(id => !exclude.includes(id) && require('./streamSources').nuvioSources()[id])) {
    throw Object.assign(new Error('No anime sources are available right now.'), { status: 503 });
  }
  const anime = await anilist.details(anilistId);
  if (!Number.isInteger(episode) || episode < 1 || (anime.episodes_available && episode > anime.episodes_available)) {
    throw Object.assign(new Error('This episode is not available yet.'), { status: 404 });
  }
  // Indian dubs (WatchAnimeWorld, MultiMovies) are looked up at the same time
  // and listed first; the Japanese source with English subtitles follows.
  const nama = require('./animeNama');
  const dubbed = nama.SOURCES.some(id => !exclude.includes(id))
    ? nama.streams(anime, episode, { language }).then(list => list.filter(s => !exclude.includes(s.provider))).catch(() => [])
    : Promise.resolve([]);
  const problems = [];
  for (const id of ids) {
    try {
      const media = await findMedia(id, anime);
      if (!media) { problems.push(`${id}: not found`); continue; }
      const list = await units(id, media.id);
      const unit = list?.find(u => Number(u.number) === episode) || (anime.format === 'MOVIE' && list?.length === 1 ? list[0] : null);
      if (!unit) { problems.push(`${id}: episode ${episode} missing`); continue; }
      const language = unit.availableLanguages?.includes('sub') ? 'sub' : unit.availableLanguages?.[0];
      const resolved = await provider(id).resolveStream(unit.id, language);
      const streams = (resolved?.type === 'video' ? resolved.streams : []).filter(s => /^https?:\/\//.test(s.sourceUrl || '')).map(s => toStream(s, id));
      if (streams.length) { const extra = await dubbed; return { provider: extra[0]?.provider || id, streams: [...extra, ...englishFirst(streams)], match: media }; }
      problems.push(`${id}: no stream`);
    } catch (error) {
      problems.push(`${id}: ${error.message}`);
    }
  }
  const extra = await dubbed;
  if (extra.length) return { provider: extra[0].provider, streams: extra, match: null };
  throw Object.assign(new Error('This episode could not be found on the anime sources. Try again later.'), { status: 404, problems });
}

function status() {
  return { playback: playbackEnabled(), providers: providerIds(), bundle: Boolean(load()) };
}

module.exports = { play, status, findMedia, pickResult, searchTerms, anilistIdFromImage, toStream, normalize, playbackEnabled, providerIds };
