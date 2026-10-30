const scraper = require('../services/scraperService');
let cached, pending;
const validImage = value => typeof value === 'string' && /^https?:\/\//i.test(value);
function eligible(items, now = Date.now()) {
  const seen = new Set();
  return items.filter(item => {
    if (!/^tt\d{5,12}$/.test(item.imdb_id || '') || seen.has(item.imdb_id) ||
        !item.title || !item.plot || !validImage(item.poster_url) || !validImage(item.backdrop_url) ||
        (item.release_date && Date.parse(item.release_date) > now)) return false;
    seen.add(item.imdb_id); return true;
  }).slice(0, 30);
}
async function load() {
  if (cached?.until > Date.now()) return cached.items;
  if (!pending) pending = Promise.allSettled([
    scraper.fetchTrending('movie', 20), scraper.fetchTrending('series', 10),
  ]).then(results => {
    const items = eligible(results.flatMap(result => result.status === 'fulfilled' ? result.value : []));
    if (items.length >= 5) { cached = { items, until: Date.now() + 600000 }; return items; }
    if (cached) return cached.items;
    throw new Error('Featured catalogue unavailable');
  }).finally(() => { pending = null; });
  return pending;
}
module.exports = async (_req, res) => {
  try { res.set('Cache-Control', 'private, max-age=60').json({ data: await load() }); }
  catch { res.status(503).json({ message: 'Featured titles are temporarily unavailable' }); }
};
module.exports.eligible = eligible;
