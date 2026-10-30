export function shuffle(items, random = Math.random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
export function orderFeatured(items, previous = [], random = Math.random) {
  const seen = new Set(), old = new Set(previous);
  const unique = items.filter(item => {
    if (!item.imdb_id || seen.has(item.imdb_id)) return false;
    seen.add(item.imdb_id); return true;
  });
  const fresh = shuffle(unique.filter(item => !old.has(item.imdb_id)), random);
  const repeated = shuffle(unique.filter(item => old.has(item.imdb_id)), random);
  // Keep both movies and series in the first batch when the pool permits it.
  const other = fresh.findIndex(item => /series/i.test(item.title_type || '') !== /series/i.test(fresh[0]?.title_type || ''));
  if (other >= 5) [fresh[4], fresh[other]] = [fresh[other], fresh[4]];
  return [...fresh, ...repeated];
}
export function toFeatured(item, index = 0) {
  const minutes = Number(item.runtime_minutes);
  return {
    id: item.imdb_id, imdb_id: item.imdb_id, title: item.title, short: item.title,
    title_type: item.title_type, year: item.release_year || '', genre: (item.genres || []).slice(0, 2).join(' · '),
    runtime: minutes > 0 ? `${Math.floor(minutes / 60) ? Math.floor(minutes / 60) + 'h ' : ''}${minutes % 60}m` : /series/i.test(item.title_type || '') ? 'Series' : 'Film',
    rating: item.content_rating || (item.rating > 0 ? '★ ' + Number(item.rating).toFixed(1) : 'FEATURED'),
    accent: ['#e6b583', '#a4c4db', '#e779a8', '#a8b8ec', '#e56b58'][index % 5],
    description: item.plot, poster: item.poster_url, backdrop: item.backdrop_url,
  };
}
