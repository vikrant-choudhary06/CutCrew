const scraper = require('./scraperService');
const cache = new Map();
const pending = new Map();
async function liveTrending(type) {
  const cached = cache.get(type);
  if (cached && cached.expires > Date.now()) return cached.items;
  if (pending.has(type)) return pending.get(type);
  const work = scraper.fetchTrending(type, 10).then(items => {
    if (items.length) cache.set(type, { items, expires: Date.now() + 600000 });
    return items;
  }).catch(() => {
    if (cached) return cached.items;
    throw Object.assign(new Error('Trending titles are temporarily unavailable. Please retry.'), { status: 502 });
  }).finally(() => pending.delete(type));
  pending.set(type, work);
  return work;
}
async function trendingSelection(type, stored) {
  if (stored.length >= 10) return { items: stored, source: 'database' };
  let live;
  try { live = await liveTrending(type); }
  catch (error) { if (stored.length) return { items: stored, source: 'database' }; throw error; }
  const unique = new Map(stored.map(item => [item.imdb_id, item]));
  for (const item of live) if (!unique.has(item.imdb_id)) unique.set(item.imdb_id, item);
  return { items: [...unique.values()].slice(0, 10), source: stored.length ? 'mixed' : 'cinemeta' };
}
module.exports = { liveTrending, trendingSelection };
