const db = require('../config/db');

function plain(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (value?._bsontype === 'ObjectId') return value.toHexString();
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  return value;
}
function movieRow(source) {
  const data = plain(source);
  if (!/^tt\d{5,12}$/.test(data.imdb_id || '') || typeof data.title !== 'string' || !data.title.trim()) {
    throw new Error('Source contains a movie without a valid IMDb ID/title');
  }
  const { imdb_id, createdAt, updatedAt, __v, ...rest } = data;
  // Legacy numeric empty strings cannot be cast by PostgreSQL generated columns.
  for (const key of ['release_year', 'vote_count', 'rating']) {
    if (rest[key] === '') rest[key] = null;
    if (rest[key] !== undefined && rest[key] !== null && !Number.isFinite(Number(rest[key]))) throw new Error(`Invalid movie ${key}`);
  }
  return { imdb_id, data: rest, createdAt, updatedAt };
}

// Source cursors are read only. The entire import is atomic in PostgreSQL.
// Existing target identities are skipped, never overwritten on re-runs.
async function importRecords({ movies, users, apply = false }) {
  const totals = { mode: apply ? 'apply' : 'dry-run', movies: { read: 0, inserted: 0, skipped: 0 }, users: { read: 0, inserted: 0, skipped: 0 } };
  await db.transaction(async client => {
    if (!apply) await client.query('SAVEPOINT dry_run');
    for await (const source of movies) {
      const row = movieRow(source);
      totals.movies.read++;
      const saved = await client.query(`INSERT INTO movies(imdb_id, data, created_at, updated_at)
        VALUES ($1, $2::jsonb, COALESCE($3::timestamptz, now()), COALESCE($4::timestamptz, now()))
        ON CONFLICT (imdb_id) DO NOTHING RETURNING imdb_id`,
      [row.imdb_id, JSON.stringify(row.data), row.createdAt || null, row.updatedAt || null]);
      if (saved.rows.length) totals.movies.inserted++; else totals.movies.skipped++;
    }
    for await (const source of users) {
      const row = plain(source);
      totals.users.read++;
      if (!row._id || typeof row.email !== 'string' || !row.email || typeof row.password !== 'string' || !row.password || !['user', 'admin'].includes(row.role || 'user')) {
        throw new Error('Source contains an invalid user');
      }
      const saved = await client.query(`INSERT INTO users(id, email, password, role, created_at, updated_at)
        VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()), COALESCE($6::timestamptz, now()))
        ON CONFLICT DO NOTHING RETURNING id`,
      [String(row._id), row.email, row.password, row.role || 'user', row.createdAt || null, row.updatedAt || null]);
      if (saved.rows.length) totals.users.inserted++; else totals.users.skipped++;
    }
    if (!apply) await client.query('ROLLBACK TO SAVEPOINT dry_run');
  });
  if (!apply) for (const kind of ['movies', 'users']) {
    totals[kind].wouldInsert = totals[kind].inserted;
    totals[kind].inserted = 0;
  }
  return totals;
}
module.exports = { importRecords, movieRow };
