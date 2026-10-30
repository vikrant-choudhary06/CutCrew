const { getProviderContext, getAvailableProvidersLocal, loadProvider } = require('../utils/providerHelper');
const { isSeries } = require('./movieService');
const { validateUrl } = require('./mediaService');
const sourceProbe = require('./sourceProbe');
const providerStatus = require('./providerStatus');

function bounded(work, timeoutMs = 15000) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Provider timed out')); }, timeoutMs);
  });
  return Promise.race([Promise.resolve().then(() => work(controller.signal)), timeout])
    .finally(() => { clearTimeout(timer); controller.abort(); });
}
const text = value => String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
function matches(movie, meta, result) {
  // A conflicting ID must never be accepted by a fuzzy fallback.
  if (meta.imdbId) return meta.imdbId === movie.imdb_id;
  const names = [movie.title, movie.original_title].filter(Boolean).map(text);
  // A provider may append the release year to its otherwise exact title.
  const providerTitle = String(meta.title || result.title || '').trim();
  const bareTitle = providerTitle.replace(/\s*\((?:19|20)\d{2}\)\s*$/, '');
  if (!names.includes(text(bareTitle))) return false;
  if (meta.type && isSeries({ title_type: meta.type }) !== isSeries(movie)) return false;
  const year = Number(meta.year || result.year || (meta.title || '').match(/\b(19\d{2}|20\d{2})\b/)?.[1]);
  return !year || !movie.release_year || year === movie.release_year;
}
function linkOf(item) {
  if (typeof item === 'string') return item;
  const link = item?.link || item?.url;
  return typeof link === 'string' ? link : link ? JSON.stringify(link) : '';
}
function parseEpisode(ep, groupTitle, index) {
  const link = linkOf(ep);
  if (!link) return null;
  let payload = {};
  try { payload = JSON.parse(link); } catch { /* Most links are URLs. */ }
  const title = ep.title || '';
  const seasonMatch = title.match(/(?:Season\s*|S)(\d+)/i) || String(groupTitle || '').match(/(?:Season\s*|S)(\d+)/i);
  const episodeMatch = title.match(/(?:Episode|Ep\.?|E)[\s._-]*(\d+)/i);
  const season = Number(payload.season || ep.season_number || seasonMatch?.[1] || 1);
  const episode = Number(payload.episode || ep.episode_number || episodeMatch?.[1] || index + 1);
  if (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1) return null;
  return { season, episode, title: title || 'Episode ' + episode, link };
}
async function normalizeMetadata(movie, meta, provider, context) {
  const groups = Array.isArray(meta.linkList) ? meta.linkList : [];
  if (!isSeries(movie)) {
    const sorted = [...groups].sort((a, b) => rank(a) - rank(b));
    const choices = sorted.flatMap(group => group.directLinks?.length ? group.directLinks.map(item => typeof item==='string'?{link:item,quality:group.title||group.quality}:{...item,quality:[group.title,group.quality,item.quality].filter(Boolean).join(' ')}) : [group]);
    const links = choices.sort((a,b)=>rank(a)-rank(b)).map(linkOf).filter(Boolean);
    return links.length ? { provider_name: provider, defaultStreamLink: links[0], links } : null;
  }
  const seasons = new Map();
  for (const group of [...groups].sort((a, b) => rank(a) - rank(b))) {
    let episodes = group.directLinks || [];
    if (group.episodesLink) {
      const module = loadProvider(provider, 'episodes');
      const getEpisodes = module.getEpisodes || module.getEpisodeLinks;
      if (getEpisodes) {
        try { episodes = await getEpisodes({ url: group.episodesLink, providerContext: context }); }
        catch { continue; }
      }
    }
    for (const [index, ep] of (Array.isArray(episodes) ? episodes : []).entries()) {
      const parsed = parseEpisode(ep, group.title, index);
      if (!parsed) continue;
      if (!seasons.has(parsed.season)) seasons.set(parsed.season, new Map());
      const list = seasons.get(parsed.season);
      // Quality variants often repeat an episode. Keep the first valid link.
      if (!list.has(parsed.episode)) list.set(parsed.episode, {
        episode_number: parsed.episode,
        title: /\d+(?:\.\d+)?\s*(?:GB|MB)\b|\b(?:720p|1080p|2160p)\b/i.test(parsed.title) ? 'Episode ' + parsed.episode : parsed.title,
        link: parsed.link,
      });
    }
  }
  const normalized = [...seasons].sort(([a], [b]) => a - b).map(([season, episodes]) => ({
    season_number: season, episodes: [...episodes.values()].sort((a, b) => a.episode_number - b.episode_number),
  }));
  return normalized.length ? { provider_name: provider, seasons: normalized } : null;
}
function rank(group) {
  const quality = [group.quality, group.title, group.name].filter(Boolean).join(' ');
  const incompatible = /\b(?:HEVC|x265|H[. ]?265|VC[. -]?1|10bit|10-bit)\b/i.test(quality) ? 3 : 0;
  const size=quality.match(/(\d+(?:\.\d+)?)\s*(GB|MB)\b/i);
  const gigabytes=size?Number(size[1])*(size[2].toUpperCase()==='MB'?1/1024:1):0;
  return incompatible + (quality.includes('720') ? 0 : quality.includes('1080') ? 1 : 4) + Math.min(gigabytes,50);
}
async function discoverProvider(movie, provider, signal) {
  const posts = loadProvider(provider, 'posts');
  const metadata = loadProvider(provider, 'meta');
  if (!posts.getSearchPosts || !metadata.getMeta) return null;
  const context = getProviderContext(signal);
  const results = await posts.getSearchPosts({ searchQuery: movie.title, page: 1, providerValue: provider, signal, providerContext: context });
  const candidates = await Promise.all((Array.isArray(results) ? results : []).slice(0, 5).map(async result => {
    try {
      const meta = await metadata.getMeta({ link: result.link, provider: provider, signal, providerContext: context });
      return meta && matches(movie, meta, result) ? meta : null;
    } catch { return null; }
  }));
  for (const meta of candidates.filter(Boolean)) {
    const normalized = await normalizeMetadata(movie, meta, provider, context);
    if (normalized) return normalized;
  }
  return null;
}
async function fetchAndAttachProviderLinks(movie, { timeoutMs = 40000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (const provider of getAvailableProvidersLocal()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const found = await bounded(signal => discoverProvider(movie, provider, signal), Math.min(12000, remaining));
      if (found) return { ...movie, ...found };
    } catch (error) { console.warn('[Provider discovery]', provider, error.message); }
  }
  return movie;
}
function normalizeStreams(input) {
  const list = Array.isArray(input) ? input : Array.isArray(input?.streams) ? input.streams : [];
  const seen = new Set();
  return list.flatMap(item => {
    const link = linkOf(item);
    let url;
    try { url = validateUrl(link); } catch { return []; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(link)) return [];
    seen.add(link);
    const type = /m3u8|mpegurl|hls/i.test(item.type || '') || /\.m3u8(?:\?|$)/i.test(link) ? 'hls'
      : /mkv|matroska/i.test(item.type || '') || /\.mkv(?:\?|$)/i.test(link) ? 'mkv' : 'mp4';
    return [{ link, type, server: item.server || 'Source', quality: item.quality || '',
      headers: item.headers || {}, subtitles: Array.isArray(item.subtitles) ? item.subtitles : [] }];
  });
}
function episodeFor(movie, season, episode) {
  return movie.seasons?.find(s => s.season_number === season)?.episodes?.find(e => e.episode_number === episode);
}
async function resolvePlayback(movie, { season, episode, excludedProviders = [], rediscover = false, timeoutMs = 60000 } = {}) {
  const providers = getAvailableProvidersLocal();
  const savedEpisode = isSeries(movie) ? episodeFor(movie, season, episode) : null;
  const ordered = [...new Set([savedEpisode?.provider_name, movie.provider_name, ...providers])].filter(p => providers.includes(p) && !excludedProviders.includes(p));
  const deadline = Date.now() + timeoutMs;
  for (const provider of ordered) {
    const started = Date.now();
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const result = await bounded(async signal => {
        let candidate = !rediscover && provider === (savedEpisode?.provider_name || movie.provider_name) ? movie : null;
        let target = isSeries(movie) ? episodeFor(candidate || {}, season, episode)?.link : candidate?.defaultStreamLink;
        if (!target) {
          candidate = await discoverProvider(movie, provider, signal);
          target = isSeries(movie) ? episodeFor(candidate || {}, season, episode)?.link : candidate?.defaultStreamLink;
        }
        if (!target) return null;
        const module = loadProvider(provider, 'stream');
        if (!module.getStream) return null;
        const context = getProviderContext(signal);
        const attempt = async current => {
          const links = isSeries(movie) ? [episodeFor(current, season, episode)?.link] : current.links || [current.defaultStreamLink];
          for (const link of links.filter(Boolean).slice(0, 3)) {
            try {
              const streams = normalizeStreams(await module.getStream({
                link, type: isSeries(movie) ? (provider === 'guardahd' ? 'tv' : 'series') : 'movie',
                signal, providerContext: context,
              }));
              const usable = await sourceProbe.filterPlayable(streams,{signal});
              if (usable.length) return { streams:usable, provider, candidate: { ...current, defaultStreamLink: link } };
            } catch { if (signal.aborted) return null; }
          }
          return null;
        };
        let playable = await attempt(candidate);
        // Intermediate provider links can expire too. Rediscover them before abandoning a saved provider.
        if (!playable && candidate === movie && !signal.aborted) {
          candidate = await discoverProvider(movie, provider, signal);
          if (candidate) playable = await attempt(candidate);
        }
        return playable;
      }, Math.min(provider === 'autoEmbed' ? 30000 : 25000, remaining));
      providerStatus.record(provider,!!result,Date.now()-started);
      if (result) return result;
    } catch (error) { providerStatus.record(provider,false,Date.now()-started); console.warn('[Provider playback]', provider, error.message); }
  }
  throw Object.assign(new Error('No playable sources found. Please try again later.'), { status: 503 });
}
module.exports = { fetchAndAttachProviderLinks, resolvePlayback, normalizeMetadata, normalizeStreams, parseEpisode, matches, bounded, episodeFor };
