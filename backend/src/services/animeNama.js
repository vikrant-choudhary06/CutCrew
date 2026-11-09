// Indian dubs (Hindi, Tamil, Telugu…) for the anime section, from the NAMA
// providers WatchAnimeWorld and MultiMovies, which run in the nuvio-runner
// container. They want a TMDB id and season: the anime's AniList id is mapped
// with arm.haglund.dev (a public id-mapping service, no key needed).
const sourceProbe = require('./sourceProbe');
const switches = require('./providerSwitches');

const SOURCES = ['watchanimeworld', 'multimovies'];
const ids = new Map();

// { tmdb, season, movie } for an AniList id, or null. Kept for a week; a
// failed lookup is tried again after 10 minutes.
async function tmdbFor(anilistId, { fetch: get = fetch, signal } = {}) {
  const cached = ids.get(anilistId);
  if (cached && cached.until > Date.now()) return cached.value;
  let value = null;
  try {
    const response = await get(`https://arm.haglund.dev/api/v2/ids?source=anilist&id=${encodeURIComponent(anilistId)}`, { headers: { Accept: 'application/json' }, signal: signal || AbortSignal.timeout(8000) });
    if (response.ok) {
      const body = await response.json();
      const tmdb = Number(body?.themoviedb) || 0;
      if (tmdb) value = { tmdb, movie: body.media === 'MOVIE', season: Number(body['themoviedb-season']) || 1 };
    }
  } catch { /* tried again later */ }
  if (ids.size > 5000) ids.delete(ids.keys().next().value);
  ids.set(anilistId, { value, until: Date.now() + (value ? 7 * 86400000 : 600000) });
  return value;
}

// The audio the player starts with: the wanted language when the playlist has
// it (DEFAULT=YES), the others stay in the player's audio menu.
function preferAudio(doc, language) {
  const lines = String(doc).split('\n');
  const audio = lines.filter(l => /^#EXT-X-MEDIA:/.test(l) && /TYPE=AUDIO/.test(l));
  const wanted = audio.find(l => new RegExp(`LANGUAGE="${language}`, 'i').test(l) || (language === 'hi' && /LANGUAGE="hin|NAME="Hindi/i.test(l)));
  if (!wanted) return doc;
  return lines.map(l => {
    if (!audio.includes(l)) return l;
    const value = l === wanted ? 'YES' : 'NO';
    return /DEFAULT=(YES|NO)/.test(l) ? l.replace(/DEFAULT=(YES|NO)/, `DEFAULT=${value}`) : l.replace('#EXT-X-MEDIA:', `#EXT-X-MEDIA:DEFAULT=${value},`);
  }).join('\n');
}

// Playable dubbed streams for one episode (or the film), Hindi first by default.
async function streams(anime, episode, { language = 'hi', fetch: get, nuvio, probe } = {}) {
  const sources = require('./streamSources');
  const enabled = SOURCES.filter(id => sources.nuvioSources()[id] && !switches.isOff(id));
  if (!enabled.length) return [];
  const ids = await tmdbFor(anime.anilist_id || anime.id, { fetch: get });
  if (!ids) return [];
  const ask = nuvio || sources.nuvioStreams;
  const lists = await Promise.all(enabled.map(id => ask(id, anime, {
    fetch: get, tmdb: ids.tmdb, type: ids.movie ? 'movie' : 'tv', ...(ids.movie ? {} : { season: ids.season, episode }),
    signal: AbortSignal.timeout(sources.nuvioSources()[id].timeoutMs()),
  }).catch(() => [])));
  const found = lists.flat().map(s => (s.playlist ? { ...s, playlist: preferAudio(s.playlist, language) } : s));
  if (!found.length) return [];
  const check = probe || (list => sourceProbe.filterPlayable(list, { timeoutMs: 8000 }));
  return check(found);
}

module.exports = { streams, tmdbFor, preferAudio, SOURCES };
