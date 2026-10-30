const fs = require('node:fs/promises');
const path = require('node:path');
let pool, embedded, idleInTransactionMs = 60000;
const prepared = new WeakSet();
const isTimeout = error => /timeout/i.test(error?.message || '');

// Checks out a connection and, once per connection, applies the session time
// limit. (The Supabase pooler ignores it as a startup parameter.)
async function checkout() {
  if (!pool) throw new Error('Database is not connected');
  const client = await pool.connect();
  if (!prepared.has(client)) {
    // A connection the server closes while checked out (e.g. after the idle
    // transaction limit) emits 'error'; without this the process would crash.
    client.on('error', () => { client.lostConnection = true; });
    try { await client.query(`SET idle_in_transaction_session_timeout = ${Math.floor(idleInTransactionMs)}`); }
    catch (error) { client.release(error); throw error; }
    prepared.add(client);
  }
  return client;
}
// A connection that timed out or was closed may be out of sync: discard it.
const finish = (client, error) => client.release(client.lostConnection || (error && isTimeout(error)) ? (error || new Error('connection lost')) : undefined);

async function query(sql, params = []) {
  if (embedded) return embedded.query(sql, params);
  const client = await checkout();
  let failure;
  try { return await client.query(sql, params); }
  catch (error) { failure = error; throw error; }
  finally { finish(client, failure); }
}
async function transaction(work) {
  if (embedded) return embedded.transaction(work);
  const client = await checkout();
  let failure;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    failure = error;
    // If the connection itself is stuck (e.g. a lost pooler reply), ROLLBACK
    // can fail too; then the connection is discarded instead of reused.
    try { await client.query('ROLLBACK'); } catch (rollbackError) { failure = rollbackError; client.lostConnection = true; }
    throw error;
  }
  finally { finish(client, failure); }
}
async function migrate() {
  const directory = path.join(__dirname, '../../migrations');
  const files = (await fs.readdir(directory)).filter(file => /^\d+_.*\.sql$/.test(file)).sort();
  await transaction(async client => {
    if (!embedded) await client.query('SELECT pg_advisory_xact_lock(731904201)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    await client.query('LOCK TABLE schema_migrations IN EXCLUSIVE MODE');
    for (const file of files) {
      const version = Number(file.split('_')[0]);
      if ((await client.query('SELECT version FROM schema_migrations WHERE version = $1', [version])).rows.length) continue;
      const sql = await fs.readFile(path.join(directory, file), 'utf8');
      if (client.exec) await client.exec(sql); else await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version]);
    }
  });
}
async function connectDB(options = {}) {
  if (pool || embedded) return;
  try {
    if (options.embedded) {
      // Explicit development/test mode, never selected by the production server.
      const { PGlite } = require('@electric-sql/pglite');
      embedded = new PGlite(options.dataDir);
      await embedded.waitReady;
    } else {
      if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL in backend/.env before starting the backend');
      const { Pool } = require('pg');
      // Time limits so a lost reply (seen through the Supabase pooler) fails
      // instead of hanging forever, and abandoned transactions release locks.
      const queryTimeout = Number(process.env.DB_QUERY_TIMEOUT_MS) || 60000;
      idleInTransactionMs = Number(process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS) || 60000;
      pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10,
        connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, query_timeout: queryTimeout });
      pool.on('error', () => console.error('PostgreSQL idle connection failed'));
      await query('SELECT 1');
    }
    await migrate();
  } catch (error) { await close(); throw error; }
}
async function close() {
  const a = pool, b = embedded; pool = undefined; embedded = undefined;
  if (a) await a.end();
  if (b) await b.close();
}

module.exports = Object.assign(connectDB, { query, transaction, close, migrate });
