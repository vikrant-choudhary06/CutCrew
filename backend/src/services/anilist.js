// AniList: the catalogue for CutCrew's anime section (lists, details, search).
// AniList allows about 30 requests a minute, so requests are spaced out,
// answers are cached, and an old answer is reused when AniList is busy.
const axios = require('axios').create({ timeout: 15000 });

const URL = process.env.ANILIST_URL || 'https://graphql.anilist.co';
const LIST_MS = 30 * 60000, DETAIL_MS = 6 * 3600000, MAX_ENTRIES = 400, GAP_MS = 2100;
const FORMATS = ['TV', 'TV_SHORT', 'MOVIE', 'ONA', 'OVA'];
const GENRES = ['Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller'];
const KINDS = {
  trending: { sort: ['TRENDING_DESC', 'POPULARITY_DESC'] },
  season: { sort: ['POPULARITY_DESC'], season: true },
  airing: { sort: ['POPULARITY_DESC'], status: 'RELEASING' },
  popular: { sort: ['POPULARITY_DESC'] },
  top: { sort: ['SCORE_DESC'] },
  movies: { sort: ['POPULARITY_DESC'], format: 'MOVIE' },
};

const CARD = 'id idMal title{romaji english native} format status episodes seasonYear startDate{year} averageScore genres bannerImage coverImage{extraLarge large color} description(asHtml:false) nextAiringEpisode{episode}';

const cache = new Map(), pending = new Map();
let queue = Promise.resolve(), lastCall = 0;

function remember(key, value, ms) {
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { value, until: Date.now() + ms });
  return value;
}

// One request at a time, at least GAP_MS apart, so a burst never hits the limit.
function post(query, variables) {
  const run = queue.then(async () => {
    const wait = lastCall + GAP_MS - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastCall = Date.now();
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await axios.post(URL, { query, variables }, { headers: { 'Content-Type': 'application/json', Accept: 'application/json' } });
        if (response.data?.errors?.length && !response.data.data) throw new Error(response.data.errors[0].message || 'AniList error');
        return response.data.data;
      } catch (error) {
        const status = error.response?.status;
        if (attempt === 0 && (status === 429 || !status || status >= 500)) {
          // Rate limited: wait as long as AniList asks (up to a minute). Otherwise a short pause.
          const retryAfter = Number(error.response?.headers?.['retry-after']);
          const wait = status === 429 ? Math.min(60, retryAfter > 0 ? retryAfter : 10) * 1000 : 2000;
          await new Promise(resolve => setTimeout(resolve, wait));
          lastCall = Date.now();
          continue;
        }
        throw error;
      }
    }
  });
  queue = run.catch(() => {});
  return run;
}

// Cached call: fresh answer within `ms`, otherwise ask AniList; if that fails,
// fall back to the last answer we had.
async function cached(key, ms, load) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  if (pending.has(key)) return pending.get(key);
  const work = load().then(value => remember(key, value, ms)).catch(error => {
    if (hit) return hit.value;
    throw Object.assign(new Error('Anime catalogue is temporarily unavailable. Please retry.'), { status: 502, cause: error });
  }).finally(() => pending.delete(key));
  pending.set(key, work);
  return work;
}

function plainText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&mdash;/g, '—')
    .replace(/\(Source:[^)]*\)\s*$/i, '').replace(/\n{3,}/g, '\n\n').trim();
}

const FORMAT_LABEL = { TV: 'TV series', TV_SHORT: 'TV short', MOVIE: 'Movie', ONA: 'Web series', OVA: 'OVA', SPECIAL: 'Special', MUSIC: 'Music video' };

// AniList media -> the item shape CutCrew's pages use. `imdb_id` carries the
// "anilist:<id>" key so My List and Continue watching treat anime like any title.
function toItem(media) {
  if (!media?.id) return null;
  const title = media.title?.english || media.title?.romaji || media.title?.native;
  if (!title) return null;
  return {
    imdb_id: `anilist:${media.id}`, anilist_id: media.id, mal_id: media.idMal || null, kind: 'anime',
    title, romaji_title: media.title?.romaji || '', native_title: media.title?.native || '',
    title_type: media.format === 'MOVIE' ? 'Anime Movie' : 'Anime',
    format: media.format || '', format_label: FORMAT_LABEL[media.format] || '', status: media.status || '',
    release_year: media.seasonYear || media.startDate?.year || null,
    poster_url: media.coverImage?.extraLarge || media.coverImage?.large || '',
    backdrop_url: media.bannerImage || '', color: media.coverImage?.color || '',
    rating: media.averageScore ? media.averageScore / 10 : null, genres: media.genres || [],
    episodes: media.episodes || null, next_episode: media.nextAiringEpisode?.episode || null,
    plot: plainText(media.description),
  };
}

function currentSeason(date = new Date()) {
  const month = date.getUTCMonth() + 1;
  const season = month <= 3 ? 'WINTER' : month <= 6 ? 'SPRING' : month <= 9 ? 'SUMMER' : 'FALL';
  return { season, seasonYear: date.getUTCFullYear() };
}

function filterArgs(kind, genre) {
  const spec = KINDS[kind];
  const args = { type: 'ANIME', isAdult: false, sort: spec.sort };
  if (spec.format) args.format = spec.format; else args.format_in = FORMATS;
  if (spec.status) args.status = spec.status;
  if (spec.season) Object.assign(args, currentSeason());
  if (genre) args.genre = genre;
  return args;
}

const literal = value => Array.isArray(value) ? `[${value.join(',')}]` : typeof value === 'string' && !/^[A-Z_]+$/.test(value) ? JSON.stringify(value) : String(value);
const argString = args => Object.entries(args).map(([key, value]) => `${key}:${literal(value)}`).join(',');

// Home rows in a single AniList request (aliases), cached for half an hour.
const HOME_ROWS = ['trending', 'season', 'airing', 'popular', 'top', 'movies'];
async function homeRows() {
  return cached('home', LIST_MS, async () => {
    const parts = HOME_ROWS.map(kind => `${kind}:Page(page:1,perPage:24){pageInfo{hasNextPage} media(${argString(filterArgs(kind))}){${CARD}}}`);
    const data = await post(`query{${parts.join(' ')}}`);
    return Object.fromEntries(HOME_ROWS.map(kind => [kind, {
      items: (data[kind]?.media || []).map(toItem).filter(Boolean), hasMore: !!data[kind]?.pageInfo?.hasNextPage,
    }]));
  });
}

async function browse({ kind = 'trending', genre = '', page = 1, perPage = 24 } = {}) {
  if (!KINDS[kind]) throw Object.assign(new Error('Unknown anime list'), { status: 400 });
  if (genre && !GENRES.includes(genre)) throw Object.assign(new Error('Unknown anime genre'), { status: 400 });
  if (!genre && page === 1 && perPage === 24 && HOME_ROWS.includes(kind)) return (await homeRows())[kind];
  return cached(`browse:${kind}:${genre}:${page}:${perPage}`, LIST_MS, async () => {
    const data = await post(`query($page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){pageInfo{hasNextPage} media(${argString(filterArgs(kind, genre))}){${CARD}}}}`, { page, perPage });
    return { items: (data.Page?.media || []).map(toItem).filter(Boolean), hasMore: !!data.Page?.pageInfo?.hasNextPage };
  });
}

async function search(query) {
  const text = String(query || '').trim().slice(0, 100);
  if (!text) return [];
  return cached('search:' + text.toLowerCase(), LIST_MS, async () => {
    const data = await post(`query($search:String){Page(page:1,perPage:20){media(search:$search,type:ANIME,isAdult:false,format_in:[${FORMATS.join(',')}],sort:SEARCH_MATCH){${CARD}}}}`, { search: text });
    return (data.Page?.media || []).map(toItem).filter(Boolean);
  });
}

// Episode numbers that can be watched now: aired so far for a running show,
// otherwise the full count.
function availableEpisodes(media) {
  if (media.status === 'NOT_YET_RELEASED') return 0;
  if (media.nextAiringEpisode?.episode) return Math.max(0, media.nextAiringEpisode.episode - 1);
  return media.episodes || (media.format === 'MOVIE' ? 1 : 0);
}

const RELATIONS = { PREQUEL: 'Previous season', SEQUEL: 'Next season', PARENT: 'Main story', SIDE_STORY: 'Side story', SPIN_OFF: 'Spin-off', ALTERNATIVE: 'Alternative version', SUMMARY: 'Recap' };

async function details(id) {
  const anilistId = Number(id);
  if (!Number.isInteger(anilistId) || anilistId < 1 || anilistId > 999999999) throw Object.assign(new Error('Invalid anime'), { status: 400 });
  return cached('details:' + anilistId, DETAIL_MS, async () => {
    const data = await post(`query($id:Int){Media(id:$id,type:ANIME){${CARD} duration season synonyms
      studios(isMain:true){nodes{name}}
      relations{edges{relationType node{${CARD} type}}}
      recommendations(perPage:12,sort:RATING_DESC){nodes{mediaRecommendation{${CARD} isAdult}}}
      streamingEpisodes{title thumbnail}
      externalLinks{site url type}}}`, { id: anilistId });
    const media = data.Media;
    if (!media) throw Object.assign(new Error('Anime not found'), { status: 404 });
    const total = availableEpisodes(media);
    // Crunchyroll-style "Episode 3 - Title" entries give names and stills.
    const named = new Map();
    for (const entry of media.streamingEpisodes || []) {
      const match = /^Episode\s+(\d+)\s*[-–:]\s*(.*)$/i.exec(entry.title || '');
      if (match && !named.has(Number(match[1]))) named.set(Number(match[1]), { title: match[2].trim(), thumbnail: entry.thumbnail || '' });
    }
    const episodes = Array.from({ length: Math.min(total, 5000) }, (_, i) => {
      const number = i + 1, info = named.get(number);
      return { episode_number: number, title: info?.title || (media.format === 'MOVIE' && total === 1 ? 'Movie' : `Episode ${number}`), thumbnail: info?.thumbnail || '' };
    });
    return {
      ...toItem(media),
      synonyms: media.synonyms || [],
      runtime_minutes: media.duration || null,
      season_name: media.season || '',
      studios: (media.studios?.nodes || []).map(node => node.name),
      episodes_available: total,
      seasons: [{ season_number: 1, episodes: episodes.map(({ episode_number, title }) => ({ episode_number, title })) }],
      episode_metadata: episodes.map(e => ({ season: 1, episode: e.episode_number, title: e.title, thumbnail: e.thumbnail })),
      relations: (media.relations?.edges || []).filter(edge => edge.node?.type === 'ANIME' && RELATIONS[edge.relationType])
        .map(edge => ({ ...toItem(edge.node), relation: RELATIONS[edge.relationType] })).filter(item => item.title),
      recommendations: (media.recommendations?.nodes || []).map(node => node.mediaRecommendation)
        .filter(m => m && !m.isAdult).map(toItem).filter(Boolean),
      external_links: (media.externalLinks || []).filter(link => link.type === 'STREAMING' && /^https:\/\//.test(link.url || ''))
        .map(link => ({ site: link.site, url: link.url })),
    };
  });
}

module.exports = { browse, search, details, homeRows, toItem, plainText, availableEpisodes, currentSeason, GENRES, KINDS, _cache: cache };
