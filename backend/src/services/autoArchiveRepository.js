// Queue for auto-saving watched provider titles to Telegram (migration 006).
// Every write is guarded by the worker's lease, so two workers (or a restarted
// one) never process the same title at once.
const { randomUUID } = require('node:crypto');
const db = require('../config/db');
const { normalizeIdentity } = require('./videoStorageRepository');

const ACTIVE_ASSET_STATES = ['ready', 'pending', 'validating', 'preparing', 'uploading', 'verifying'];
const reasonCode = value => String(value || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 64) || 'UNKNOWN';
const int = value => (value == null ? null : Number(value));

function mapRequest(row) {
  if (!row) return null;
  return {
    id: row.id, imdbId: row.imdb_id, season: int(row.season), episode: int(row.episode), status: row.status,
    reason: row.reason, sourceToken: row.source_token, attempts: int(row.attempts), nextRunAt: row.next_run_at,
    leaseOwner: row.lease_owner, leaseExpiresAt: row.lease_expires_at, downloadStartedAt: row.download_started_at,
    assetId: row.asset_id, progress: row.progress || {}, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

const identityOf = ({ imdbId, season = null, episode = null }) =>
  normalizeIdentity({ imdbId, ...(season == null && episode == null ? { contentType: 'movie' } : { season, episode }) });

// The duplicate check: is this movie/episode already in Telegram, or being uploaded?
// Any quality counts. This reads the storage index, never Telegram itself.
async function isStored(identity, client = db) {
  const who = identityOf(identity);
  const row = (await client.query(
    `SELECT 1 FROM video_assets WHERE imdb_id = $1 AND COALESCE(season,-1) = COALESCE($2::int,-1)
       AND COALESCE(episode,-1) = COALESCE($3::int,-1) AND state = ANY($4::text[]) LIMIT 1`,
    [who.imdbId, who.season, who.episode, ACTIVE_ASSET_STATES])).rows[0];
  return Boolean(row);
}

// Queues a title once. A finished request whose copy later disappeared from
// storage is queued again; skipped and failed titles stay as they are.
async function request({ imdbId, season = null, episode = null, sourceToken = null }) {
  const who = identityOf({ imdbId, season, episode });
  if (await isStored(who)) return { queued: false, reason: 'ALREADY_STORED' };
  const row = (await db.query(
    `INSERT INTO auto_archive_requests (id, imdb_id, season, episode, source_token)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (imdb_id, (COALESCE(season, -1)), (COALESCE(episode, -1))) DO UPDATE SET
       source_token = CASE WHEN auto_archive_requests.status IN ('queued','done') THEN EXCLUDED.source_token ELSE auto_archive_requests.source_token END,
       status = CASE WHEN auto_archive_requests.status = 'done' THEN 'queued' ELSE auto_archive_requests.status END,
       attempts = CASE WHEN auto_archive_requests.status = 'done' THEN 0 ELSE auto_archive_requests.attempts END,
       reason = CASE WHEN auto_archive_requests.status = 'done' THEN NULL ELSE auto_archive_requests.reason END,
       asset_id = CASE WHEN auto_archive_requests.status = 'done' THEN NULL ELSE auto_archive_requests.asset_id END,
       next_run_at = CASE WHEN auto_archive_requests.status = 'done' THEN now() ELSE auto_archive_requests.next_run_at END,
       updated_at = now()
     RETURNING *, (xmax = 0) AS inserted`,
    [randomUUID(), who.imdbId, who.season, who.episode, sourceToken])).rows[0];
  const value = mapRequest(row);
  return { queued: value.status === 'queued', created: Boolean(row.inserted), request: value, reason: value.status === 'queued' ? null : value.status.toUpperCase() };
}

// Next due request, or one whose worker stopped renewing its lease. Once the
// daily download limit is reached, only requests that already downloaded
// (and are resuming their upload) can be claimed.
async function claim(workerId, { leaseMs = 600000, dailyLimit = 10 } = {}) {
  return db.transaction(async client => {
    const started = Number((await client.query(
      "SELECT count(*) AS n FROM auto_archive_requests WHERE download_started_at > now() - interval '24 hours'")).rows[0].n);
    const resumeOnly = started >= dailyLimit;
    const row = (await client.query(
      `SELECT id FROM auto_archive_requests
       WHERE ((status = 'queued' AND next_run_at <= now()) OR (status = 'running' AND lease_expires_at < now()))
         ${resumeOnly ? 'AND asset_id IS NOT NULL' : ''}
       ORDER BY next_run_at, created_at LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
    if (!row) return { request: null, limited: resumeOnly };
    const claimed = (await client.query(
      `UPDATE auto_archive_requests SET status = 'running', lease_owner = $2, attempts = attempts + 1,
         lease_expires_at = now() + ($3::int * interval '1 millisecond'), updated_at = now()
       WHERE id = $1 RETURNING *`, [row.id, workerId, leaseMs])).rows[0];
    return { request: mapRequest(claimed), limited: resumeOnly };
  });
}

class LeaseLostError extends Error { constructor() { super('AUTO_ARCHIVE_LEASE_LOST'); this.code = 'AUTO_ARCHIVE_LEASE_LOST'; } }

// Every change below only applies while this worker still holds the lease.
async function owned(id, workerId, sql, params = []) {
  const result = await db.query(
    `UPDATE auto_archive_requests SET ${sql}, updated_at = now() WHERE id = $1 AND status = 'running' AND lease_owner = $2 RETURNING *`,
    [id, workerId, ...params]);
  if (!result.rows.length) throw new LeaseLostError();
  return mapRequest(result.rows[0]);
}

const heartbeat = (id, workerId, { leaseMs = 600000, progress } = {}) =>
  owned(id, workerId, "lease_expires_at = now() + ($3::int * interval '1 millisecond'), progress = COALESCE($4::jsonb, progress)",
    [leaseMs, progress ? JSON.stringify(progress) : null]);
const markDownloadStarted = (id, workerId) => owned(id, workerId, 'download_started_at = now()');
const setAsset = (id, workerId, assetId) => owned(id, workerId, 'asset_id = $3', [assetId]);

// Ends a request for good: done (stored), skipped (cannot be stored) or failed.
const finish = (id, workerId, status, reason = null) => {
  if (!['done', 'skipped', 'failed'].includes(status)) throw new Error('Invalid final status');
  return owned(id, workerId, 'status = $3, reason = $4, lease_owner = NULL, lease_expires_at = NULL, source_token = NULL',
    [status, reason ? reasonCode(reason) : null]);
};

// Puts a request back in the queue to try again later.
const reschedule = (id, workerId, { delayMs, reason = null, clearAsset = false }) =>
  owned(id, workerId, `status = 'queued', reason = $4, lease_owner = NULL, lease_expires_at = NULL,
     next_run_at = now() + ($3::int * interval '1 millisecond')${clearAsset ? ', asset_id = NULL' : ''}`,
  [Math.max(0, Math.min(Math.round(delayMs), 2147483647)), reason ? reasonCode(reason) : null]);

async function list({ limit = 50 } = {}) {
  return (await db.query('SELECT * FROM auto_archive_requests ORDER BY updated_at DESC LIMIT $1',
    [Math.min(200, Math.max(1, limit))])).rows.map(mapRequest);
}

async function counts() {
  const rows = (await db.query('SELECT status, count(*) AS n FROM auto_archive_requests GROUP BY status')).rows;
  const today = (await db.query(
    "SELECT count(*) AS n FROM auto_archive_requests WHERE download_started_at > now() - interval '24 hours'")).rows[0];
  return { byStatus: Object.fromEntries(rows.map(r => [r.status, Number(r.n)])), downloadsLast24h: Number(today.n) };
}

// Admin: try a skipped or failed title again from the start.
async function retry(id) {
  const row = (await db.query(
    `UPDATE auto_archive_requests SET status = 'queued', attempts = 0, reason = NULL, asset_id = NULL, next_run_at = now(), updated_at = now()
     WHERE id = $1 AND status IN ('skipped','failed') RETURNING *`, [id])).rows[0];
  return mapRequest(row);
}

module.exports = { isStored, request, claim, heartbeat, markDownloadStarted, setAsset, finish, reschedule, list, counts, retry,
  mapRequest, LeaseLostError, ACTIVE_ASSET_STATES };
