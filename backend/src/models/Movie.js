// SQL repository retaining the small call shape used by the existing routes.
// This intentionally supports only this application's query/update operations.
const db = require('../config/db');
const { randomUUID } = require('node:crypto');
const columns = new Set(['imdb_id', 'title', 'title_type', 'release_year', 'release_date', 'vote_count', 'rating']);
function document(row) {
  if (!row) return null;
  const value = { ...row.data, imdb_id: row.imdb_id, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at) };
  if (value.stream_fetched_at) value.stream_fetched_at = new Date(value.stream_fetched_at);
  for (const season of value.seasons || []) for (const episode of season.episodes || []) {
    if (episode.stream_fetched_at) episode.stream_fetched_at = new Date(episode.stream_fetched_at);
  }
  Object.defineProperty(value, 'toObject', { enumerable: false, value: () => structuredClone({ ...value }) });
  return value;
}
function where(filter, values) {
  const bind = value => { values.push(value); return '$' + values.length; };
  return Object.entries(filter).map(([field, condition]) => {
    if (!columns.has(field) && !['genres', 'country'].includes(field)) throw new Error('Unsupported catalogue filter');
    if (['genres', 'country'].includes(field)) {
      if (!Array.isArray(condition?.$in)) throw new Error('Expected array filter');
      const parts = condition.$in.map(value => value instanceof RegExp
        ? `element ~* ${bind(value.source)}` : `element = ${bind(value)}`);
      return `EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(data->'${field}', '[]'::jsonb)) element WHERE ${parts.join(' OR ') || 'false'})`;
    }
    if (condition instanceof RegExp) return `${field} ${condition.ignoreCase ? '~*' : '~'} ${bind(condition.source)}`;
    if (condition && typeof condition === 'object') {
      const list = condition.$in || condition.$nin;
      if (!Array.isArray(list)) throw new Error('Unsupported catalogue comparison');
      const expression = `${field} IN (${list.map(bind).join(',') || 'NULL'})`;
      return condition.$nin ? `(NOT (${expression}) OR ${field} IS NULL)` : expression;
    }
    return condition === null ? `${field} IS NULL` : `${field} = ${bind(condition)}`;
  }).join(' AND ') || 'true';
}
class MovieQuery {
  constructor(filter) { this.filter = filter; this.order = {}; this.maximum = 1000; }
  limit(value) { this.maximum = Math.max(1, Math.min(1000, Number(value) || 20)); return this; }
  sort(order) { this.order = order; return this; }
  lean() { return this.exec(); }
  then(resolve, reject) { return this.exec().then(resolve, reject); }
  async exec() {
    const values = [], clause = where(this.filter, values);
    const order = Object.entries(this.order).map(([field, direction]) => {
      if (!columns.has(field)) throw new Error('Unsupported catalogue sort');
      return `${field} ${direction === -1 ? 'DESC' : 'ASC'} NULLS LAST`;
    });
    values.push(this.maximum);
    const result = await db.query(`SELECT * FROM movies WHERE ${clause} ORDER BY ${[...order, 'imdb_id ASC'].join(',')} LIMIT $${values.length}`, values);
    return result.rows.map(document);
  }
}
function clean(input) {
  const result = { ...input };
  delete result.imdb_id; delete result.createdAt; delete result.updatedAt; delete result.__v;
  return JSON.parse(JSON.stringify(result));
}
const defaults = () => ({ _id: randomUUID(), metadata_complete: false, seasons: [], genres: [], country: [], cast: [],
  streaming_url: '', defaultStreamLink: '', provider_name: '' });
async function write(filter, update, options = {}) {
  const id = filter.imdb_id;
  if (!/^tt\d{5,12}$/.test(id || '')) throw new Error('Invalid IMDb ID');
  if (!update.$set || Object.keys(update).some(key => key !== '$set')) throw new Error('Unsupported movie update');
  const patch = clean(update.$set);
  if (patch.title !== undefined && (typeof patch.title !== 'string' || !patch.title.trim())) throw new Error('Movie title is required');
  if (patch.admin_overrides !== undefined && (typeof patch.admin_overrides !== 'object' || Array.isArray(patch.admin_overrides) || patch.admin_overrides === null)) throw new Error('Invalid admin overrides');
  if (Object.keys(filter).length === 1 && !Object.keys(patch).some(key => key.includes('.'))) {
    // Merge into the current locked version, not a stale application snapshot.
    // Fields an admin edited by hand (data.admin_overrides) are applied last, so
    // a metadata refresh (nightly cron, details fetch) can never undo them.
    const merged = (current, incoming) => `(${current} || ${incoming}) ||
      jsonb_build_object('admin_overrides', COALESCE(${current}->'admin_overrides', '{}'::jsonb) || COALESCE(${incoming}->'admin_overrides', '{}'::jsonb)) ||
      COALESCE(${current}->'admin_overrides', '{}'::jsonb) || COALESCE(${incoming}->'admin_overrides', '{}'::jsonb)`;
    const result = options.upsert
      ? await db.query(`INSERT INTO movies(imdb_id, data) VALUES ($1, $2::jsonb)
          ON CONFLICT(imdb_id) DO UPDATE SET data = ${merged('movies.data', '$3::jsonb')}, updated_at = now() RETURNING *`,
        [id, JSON.stringify({ ...defaults(), ...patch, ...(patch.admin_overrides || {}) }), JSON.stringify(patch)])
      : await db.query(`UPDATE movies SET data = ${merged('data', '$2::jsonb')}, updated_at = now() WHERE imdb_id = $1 RETURNING *`, [id, JSON.stringify(patch)]);
    return { record: document(result.rows[0]), matchedCount: result.rows.length };
  }
  return db.transaction(async client => {
    const row = (await client.query('SELECT * FROM movies WHERE imdb_id = $1 FOR UPDATE', [id])).rows[0];
    if (!row) return { record: null, matchedCount: 0 };
    const data = row.data, match = filter.seasons?.$elemMatch;
    if (match) {
      const season = data.seasons?.find(s => s.season_number === match.season_number);
      const episode = season?.episodes?.find(e => e.episode_number === match.episodes.$elemMatch.episode_number);
      if (!episode) return { record: null, matchedCount: 0 };
      for (const [key, value] of Object.entries(patch)) {
        const prefix = 'seasons.$[s].episodes.$[e].';
        if (!key.startsWith(prefix) || !['stream_data', 'stream_fetched_at', 'provider_name', 'link'].includes(key.slice(prefix.length))) throw new Error('Unsupported episode update');
        episode[key.slice(prefix.length)] = value;
      }
    } else if (filter['seasons.0']?.$exists === false) {
      if (data.seasons?.length) return { record: null, matchedCount: 0 };
      Object.assign(data, patch, data.admin_overrides || {});
    } else throw new Error('Unsupported conditional movie update');
    const result = await client.query('UPDATE movies SET data = $2::jsonb, updated_at = now() WHERE imdb_id = $1 RETURNING *', [id, JSON.stringify(data)]);
    return { record: document(result.rows[0]), matchedCount: 1 };
  });
}
module.exports = {
  find: (filter = {}) => new MovieQuery(filter),
  async findOne(filter) { return (await new MovieQuery(filter).limit(1))[0] || null; },
  async findOneAndUpdate(filter, update, options) { return (await write(filter, update, options)).record; },
  async updateOne(filter, update, options) { return write(filter, update, options); },
  async create(input) {
    const insert = async item => {
      if (typeof item.title !== 'string' || !item.title.trim()) throw new Error('Movie title is required');
      const result = await db.query('INSERT INTO movies(imdb_id, data, created_at, updated_at) VALUES ($1, $2::jsonb, COALESCE($3::timestamptz, now()), COALESCE($4::timestamptz, now())) RETURNING *',
        [item.imdb_id, JSON.stringify({ ...defaults(), ...clean(item) }), item.createdAt || null, item.updatedAt || null]);
      return document(result.rows[0]);
    };
    return Array.isArray(input) ? Promise.all(input.map(insert)) : insert(input);
  },
};
