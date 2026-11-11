// CutCrew API access, artwork URLs and small formatting helpers.
// Same backend and endpoints as the website.
export const BASE = 'https://web.cutcrew.click';

export type Episode = { episode_number: number; title?: string };
export type Season = { season_number: number; episodes?: Episode[] };
export type Title = {
  imdb_id: string;
  kind?: string;
  anilist_id?: number;
  format?: string;
  format_label?: string;
  recommendations?: Title[];
  episodes_available?: number;
  title: string;
  title_type?: string;
  release_year?: number;
  release_date?: string;
  runtime_minutes?: number;
  content_rating?: string;
  rating?: number;
  genres?: string[];
  plot?: string;
  poster_url?: string;
  backdrop_url?: string;
  cast?: { name?: string }[];
  seasons?: Season[];
  episode_metadata?: { season: number; episode: number; title?: string; thumbnail?: string }[];
};
export type Stream = { link: string; type: string; server?: string; quality?: string; language?: string; stored?: boolean; remuxed?: boolean;
  // Audio tracks the server read from the file, and the one it chose for the preferred language.
  audioTracks?: { index: number; language: string; label: string }[]; audioIndex?: number; audioLanguage?: string; audioMatched?: boolean };
export type PlayResponse = { streams: Stream[]; provider?: string; stored?: boolean };

const cache = new Map<string, { at: number; body: unknown }>();
const CACHE_MS = 5 * 60 * 1000;

// GET JSON with a timeout; successful answers are cached for a few minutes.
export async function getJSON<T = any>(path: string, { timeout = 30000, fresh = false } = {}): Promise<T> {
  const hit = cache.get(path);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.body as T;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(BASE + path, { signal: controller.signal, headers: { Accept: 'application/json' } });
    let body: any = null;
    try { body = await response.json(); } catch { /* handled below */ }
    if (!response.ok || !body) throw new Error(body?.message || body?.error || 'The server did not respond. Check your connection and try again.');
    cache.set(path, { at: Date.now(), body });
    return body as T;
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new Error('This is taking too long. Check your connection and try again.');
    throw error;
  } finally { clearTimeout(timer); }
}
export const peekJSON = <T = any>(path: string) => cache.get(path)?.body as T | undefined;

// Anime titles come from AniList and are keyed "anilist:<id>"; a TV anime has
// its episodes in season 1, an anime film plays like a movie.
export const isAnime = (item?: Partial<Title> | string | null) => typeof item === 'string' ? /^anilist:\d+$/.test(item) : item?.kind === 'anime' || /^anilist:\d+$/.test(item?.imdb_id || '');
export const anilistId = (id: string) => Number(id.split(':')[1]) || 0;
export const isSeries = (item?: Partial<Title> | null) => /series|episode/i.test(item?.title_type || '') || item?.title_type === 'Anime';
export const typeLabel = (item: Partial<Title>) => (isAnime(item) ? (item.title_type === 'Anime Movie' ? 'Anime movie' : 'Anime') : isSeries(item) ? 'Series' : 'Movie');

// Where a title's details and its streams come from.
export const titlePath = (id: string) => (isAnime(id) ? `/api/anime/${anilistId(id)}` : `/api/movies/${id}`);
// client=app: MKV comes as the original file (seekable), not converted.
export function playPath(id: string, { season, episode, exclude = [], refresh = false, lang }: { season?: number; episode?: number; exclude?: string[]; refresh?: boolean; lang?: string }) {
  const q = new URLSearchParams({ client: 'app' });
  if (lang && !isAnime(id)) q.set('lang', lang);
  if (isAnime(id)) q.set('episode', String(episode || 1));
  else if (season) { q.set('season', String(season)); q.set('episode', String(episode)); }
  if (exclude.length) q.set('exclude', exclude.join(','));
  if (refresh) q.set('refresh', '1');
  return isAnime(id) ? `/api/anime/${anilistId(id)}/play?${q}` : `/api/movies/play/${id}?${q}`;
}

// Cinemeta artwork exists for every IMDb title.
const art = (kind: string, size: string, id: string) => `https://images.metahub.space/${kind}/${size}/${id}/img`;
// Anime artwork comes from AniList (cover, banner); anime has no logos.
export const posterUrl = (item: Partial<Title>, size = 'small') => (isAnime(item) ? item.poster_url || '' : (size === 'small' && item.poster_url) || (item.imdb_id ? art('poster', size, item.imdb_id) : ''));
export const backdropUrl = (item: Partial<Title>, size = 'medium') => (isAnime(item) ? item.backdrop_url || item.poster_url || '' : (size !== 'small' && item.backdrop_url) || (item.imdb_id ? art('background', size, item.imdb_id) : ''));
// Small (480 px, ~12 KB) version of the backdrop, shown while the full one loads.
export const backdropPreview = (item: Partial<Title>) => (isAnime(item) || !item.imdb_id ? '' : art('background', 'small', item.imdb_id));
export const logoUrl = (item: Partial<Title>) => (item.imdb_id && !isAnime(item) ? art('logo', 'medium', item.imdb_id) : '');

export function runtimeLabel(minutes?: number) {
  const m = Number(minutes);
  if (!(m > 0)) return '';
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}
export const ratingLabel = (rating?: number) => (Number(rating) > 0 ? Number(rating).toFixed(1) : '');

export const GENRES = ['Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy',
  'History', 'Horror', 'Music', 'Mystery', 'Romance', 'Sci-Fi', 'Thriller', 'War', 'Western'];
// AniList's genres, as the website's anime page lists them.
export const ANIME_GENRES = ['Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mecha', 'Music', 'Mystery',
  'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller'];

// Released in the last year or so, newest first.
export function recent(items: Title[]) {
  const year = new Date().getFullYear(), now = new Date();
  return items.filter(x => (x.release_year || 0) >= year - 1 && (x.release_year || 0) <= year && (!x.release_date || new Date(x.release_date) <= now))
    .sort((a, b) => Number(b.release_year) - Number(a.release_year));
}

// Small summary kept in My List / Continue watching.
export const summary = (t: Title): Title => ({
  imdb_id: t.imdb_id, title: t.title, ...(t.kind ? { kind: t.kind, anilist_id: t.anilist_id } : {}), title_type: t.title_type, release_year: t.release_year,
  poster_url: t.poster_url, backdrop_url: t.backdrop_url, runtime_minutes: t.runtime_minutes, genres: t.genres?.slice(0, 3),
});

export const sortedSeasons = (t: Title) => [...(t.seasons || [])].filter(s => s.season_number >= 1).sort((a, b) => a.season_number - b.season_number);
export const sortedEpisodes = (s?: Season) => [...(s?.episodes || [])].sort((a, b) => a.episode_number - b.episode_number);

// The episode after (season, episode), crossing into the next season.
export function nextEpisode(t: Title, season: number, episode: number) {
  const seasons = sortedSeasons(t);
  const si = seasons.findIndex(s => s.season_number === season);
  if (si < 0) return null;
  const eps = sortedEpisodes(seasons[si]);
  const ei = eps.findIndex(e => e.episode_number === episode);
  if (ei >= 0 && ei + 1 < eps.length) return { season, episode: eps[ei + 1].episode_number };
  const next = seasons[si + 1];
  const first = sortedEpisodes(next)[0];
  return next && first ? { season: next.season_number, episode: first.episode_number } : null;
}
