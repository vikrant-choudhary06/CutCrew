// PostgreSQL index for Telegram-stored videos (telegramintegration.md, Phase 1).
// The schema (migrations/005) is the final authority on layout and Ready rules;
// this module validates input early and keeps every multi-row change atomic.
const { randomUUID } = require('node:crypto');
const db = require('../config/db');

class VideoStorageError extends Error {
  constructor(code, message) { super(message ? `${code}: ${message}` : code); this.code = code; }
}
const fail = (code, message) => { throw new VideoStorageError(code, message); };

const SHA256 = /^[0-9a-f]{64}$/;
const IMDB = /^tt[0-9]{5,12}$/;
const STATES = ['pending', 'validating', 'preparing', 'uploading', 'verifying', 'ready', 'failed', 'unavailable', 'superseded'];
const STAGES = ['validate', 'prepare', 'upload', 'verify', 'publish'];

const int = value => (value === null || value === undefined ? value : Number(value));
const errorCode = value => {
  const code = String(value || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 64);
  return code || 'UNKNOWN';
};

// ---------- identity and variant ----------

function normalizeIdentity({ imdbId, contentType, season, episode } = {}) {
  if (!IMDB.test(imdbId || '')) fail('INVALID_IMDB_ID');
  const type = contentType || (season !== undefined || episode !== undefined ? 'episode' : 'movie');
  if (type === 'movie') {
    if (season != null || episode != null) fail('INVALID_IDENTITY', 'movies have no season/episode');
    return { imdbId, contentType: 'movie', season: null, episode: null };
  }
  if (type !== 'episode') fail('INVALID_IDENTITY', 'contentType must be movie or episode');
  if (!Number.isSafeInteger(season) || season < 0 || !Number.isSafeInteger(episode) || episode < 1) {
    fail('INVALID_IDENTITY', 'episodes need explicit season (>=0) and episode (>=1) numbers');
  }
  return { imdbId, contentType: 'episode', season, episode };
}

function normalizeVariant({ quality, edition = 'original', audioLanguages = [] } = {}) {
  if (!/^[A-Za-z0-9]{1,16}$/.test(quality || '')) fail('INVALID_VARIANT', 'quality must be a short label such as 1080p');
  const ed = String(edition).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(ed)) fail('INVALID_VARIANT', 'edition must be a short slug');
  if (!Array.isArray(audioLanguages) || audioLanguages.length > 16) fail('INVALID_VARIANT', 'audioLanguages must be a list');
  const languages = [...new Set(audioLanguages.map(lang => String(lang).trim().toLowerCase()))].sort();
  if (languages.some(lang => !/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(lang))) {
    fail('INVALID_VARIANT', 'audio languages must be ISO codes such as hi or en');
  }
  return { quality: quality.toLowerCase(), edition: ed, audioLanguages: languages };
}

// ---------- exact binary layout ----------

// Parts are raw byte slices of the prepared file: joining them in order
// reproduces it exactly. Offsets come from measured sizes, never labels.
function planParts(totalSize, partSize) {
  if (!Number.isSafeInteger(totalSize) || totalSize < 1) fail('INVALID_SIZE', 'totalSize must be a positive integer');
  if (!Number.isSafeInteger(partSize) || partSize < 1) fail('INVALID_SIZE', 'partSize must be a positive integer');
  const count = Math.ceil(totalSize / partSize);
  return Array.from({ length: count }, (_, index) => {
    const offset = index * partSize;
    return { partNumber: index + 1, offset, size: Math.min(partSize, totalSize - offset), end: Math.min(offset + partSize, totalSize) - 1 };
  });
}

// Telegram private-chat message link (membership required to open it).
function messageLink(chatId, messageId) {
  const match = /^-100(\d+)$/.exec(String(chatId));
  if (!match || !Number.isSafeInteger(Number(messageId)) || Number(messageId) < 1) fail('INVALID_TELEGRAM_REFERENCE');
  return `https://t.me/c/${match[1]}/${Number(messageId)}`;
}

// ---------- row mapping ----------

function mapAsset(row) {
  if (!row) return null;
  return {
    id: row.id, schemaVersion: int(row.schema_version), imdbId: row.imdb_id, contentType: row.content_type,
    season: int(row.season), episode: int(row.episode), title: row.title, releaseYear: int(row.release_year),
    episodeReleaseYear: int(row.episode_release_year), quality: row.quality, edition: row.edition,
    audioLanguages: row.audio_languages || [], tracks: row.tracks || {}, fileName: row.file_name,
    container: row.container, videoCodec: row.video_codec, audioCodec: row.audio_codec, pixelFormat: row.pixel_format,
    width: int(row.width), height: int(row.height), durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
    faststart: row.faststart, transcoded: row.transcoded, totalSize: int(row.total_size), sha256: row.sha256,
    partSize: int(row.part_size), partCount: int(row.part_count), state: row.state, isDefault: row.is_default,
    failureReason: row.failure_reason, stateChangedAt: row.state_changed_at, readyAt: row.ready_at,
    lastValidatedAt: row.last_validated_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function mapPart(row) {
  return {
    assetId: row.asset_id, partNumber: int(row.part_number), offset: int(row.byte_offset), size: int(row.size),
    sha256: row.sha256, integrityManifest: row.integrity_manifest, state: row.state,
    telegramChatId: row.telegram_chat_id == null ? null : String(row.telegram_chat_id),
    telegramMessageId: int(row.telegram_message_id), messageLink: row.message_link, botFileId: row.bot_file_id,
    botFileUniqueId: row.bot_file_unique_id, mtprotoDocumentId: row.mtproto_document_id,
    referenceRefreshedAt: row.reference_refreshed_at, uploadedAt: row.uploaded_at, verifiedAt: row.verified_at,
  };
}
function mapJob(row) {
  if (!row) return null;
  return {
    id: row.id, assetId: row.asset_id, idempotencyKey: row.idempotency_key, stage: row.stage, status: row.status,
    attempts: int(row.attempts), maxAttempts: int(row.max_attempts), nextRunAt: row.next_run_at,
    leaseOwner: row.lease_owner, leaseExpiresAt: row.lease_expires_at, heartbeatAt: row.heartbeat_at,
    progress: row.progress || {}, artifacts: row.artifacts || {}, errorCategory: row.error_category,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// ---------- imports ----------

// Creates an asset and its durable job atomically. Re-sending the same
// idempotency key returns the original records instead of a duplicate.
async function createImport(input = {}) {
  try { return await createImportOnce(input); }
  catch (error) {
    // Two requests raced with the same key: the loser returns the winner's records.
    if (error.code === '23505' && /idempotency_key/.test(error.constraint || '')) return createImportOnce(input);
    throw error;
  }
}
async function createImportOnce({ identity, variant, idempotencyKey, title, releaseYear, episodeReleaseYear, maxAttempts = 5, artifacts = {} } = {}) {
  const who = normalizeIdentity(identity);
  const what = normalizeVariant(variant);
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 200) fail('INVALID_IDEMPOTENCY_KEY');
  if (who.contentType === 'movie' && episodeReleaseYear != null) fail('INVALID_IDENTITY', 'episodeReleaseYear applies to episodes only');

  return db.transaction(async client => {
    const existing = await client.query('SELECT * FROM video_import_jobs WHERE idempotency_key = $1', [idempotencyKey]);
    if (existing.rows.length) {
      const job = mapJob(existing.rows[0]);
      const asset = mapAsset((await client.query('SELECT * FROM video_assets WHERE id = $1', [job.assetId])).rows[0]);
      if (asset.imdbId !== who.imdbId || asset.season !== who.season || asset.episode !== who.episode ||
          asset.quality !== what.quality || asset.edition !== what.edition ||
          asset.audioLanguages.join(',') !== what.audioLanguages.join(',')) {
        fail('IDEMPOTENCY_KEY_REUSED', 'idempotency key already belongs to a different import');
      }
      return { asset, job, created: false };
    }
    const assetId = randomUUID();
    const assetRow = (await client.query(
      `INSERT INTO video_assets (id, imdb_id, content_type, season, episode, title, release_year, episode_release_year,
         quality, edition, audio_languages)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [assetId, who.imdbId, who.contentType, who.season, who.episode, title ?? null, releaseYear ?? null,
        episodeReleaseYear ?? null, what.quality, what.edition, what.audioLanguages])).rows[0];
    const jobRow = (await client.query(
      'INSERT INTO video_import_jobs (id, asset_id, idempotency_key, max_attempts, artifacts) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [randomUUID(), assetId, idempotencyKey, maxAttempts, JSON.stringify(artifacts)])).rows[0];
    return { asset: mapAsset(assetRow), job: mapJob(jobRow), created: true };
  });
}

async function getAsset(id, { withParts = true } = {}) {
  const asset = mapAsset((await db.query('SELECT * FROM video_assets WHERE id = $1', [id])).rows[0]);
  if (asset && withParts) asset.parts = await listParts(id);
  return asset;
}
async function listParts(assetId, client = db) {
  return (await client.query('SELECT * FROM video_parts WHERE asset_id = $1 ORDER BY part_number', [assetId])).rows.map(mapPart);
}

// Compare-and-set state change; the schema rejects illegal transitions.
async function transitionAsset(id, from, to, { failureReason } = {}) {
  if (!STATES.includes(to)) fail('INVALID_STATE');
  const reason = to === 'failed' ? errorCode(failureReason) : null;
  const result = await db.query(
    'UPDATE video_assets SET state = $3, failure_reason = $4 WHERE id = $1 AND state = $2 RETURNING *',
    [id, from, to, reason]);
  if (!result.rows.length) fail('STATE_CONFLICT', `asset is not in state ${from}`);
  return mapAsset(result.rows[0]);
}

// Records the final prepared file and creates its exact pending part rows.
async function recordPreparedFile(assetId, file = {}) {
  const { totalSize, sha256, partSize, parts = [] } = file;
  if (!SHA256.test(sha256 || '')) fail('INVALID_CHECKSUM');
  const plan = planParts(totalSize, partSize);
  if (parts.length !== plan.length) fail('PART_PLAN_MISMATCH', `expected ${plan.length} part checksums`);
  parts.forEach((part, index) => {
    if (!SHA256.test(part?.sha256 || '')) fail('INVALID_CHECKSUM', `part ${index + 1} checksum is invalid`);
    if (part.size !== undefined && part.size !== plan[index].size) fail('PART_PLAN_MISMATCH', `part ${index + 1} size differs from the exact layout`);
  });
  const meta = file.media || {};
  return db.transaction(async client => {
    const row = (await client.query(
      `UPDATE video_assets SET total_size = $2, sha256 = $3, part_size = $4, part_count = $5,
         file_name = $6, container = $7, video_codec = $8, audio_codec = $9, pixel_format = $10,
         width = $11, height = $12, duration_seconds = $13, faststart = $14, transcoded = $15, tracks = $16
       WHERE id = $1 AND state = 'preparing' AND total_size IS NULL RETURNING *`,
      [assetId, totalSize, sha256, partSize, plan.length, meta.fileName ?? null, meta.container ?? null,
        meta.videoCodec ?? null, meta.audioCodec ?? null, meta.pixelFormat ?? null, meta.width ?? null,
        meta.height ?? null, meta.durationSeconds ?? null, meta.faststart ?? null, meta.transcoded ?? null,
        JSON.stringify(meta.tracks || {})])).rows[0];
    if (!row) fail('STATE_CONFLICT', 'asset must be preparing with no recorded file');
    for (const [index, slice] of plan.entries()) {
      await client.query(
        'INSERT INTO video_parts (asset_id, part_number, byte_offset, size, sha256, integrity_manifest) VALUES ($1,$2,$3,$4,$5,$6)',
        [assetId, slice.partNumber, slice.offset, slice.size, parts[index].sha256,
          parts[index].integrityManifest ? JSON.stringify(parts[index].integrityManifest) : null]);
    }
    const asset = mapAsset(row);
    asset.parts = await listParts(assetId, client);
    return asset;
  });
}

// Saves Telegram references as soon as an upload returns.
async function recordPartUpload(assetId, partNumber, ref = {}) {
  const chatId = String(ref.chatId ?? '');
  const messageId = Number(ref.messageId);
  const link = messageLink(chatId, messageId);
  if (ref.documentId != null && !/^-?\d{1,20}$/.test(String(ref.documentId))) fail('INVALID_TELEGRAM_REFERENCE');
  const result = await db.query(
    `UPDATE video_parts p SET state = 'uploaded', telegram_chat_id = $3, telegram_message_id = $4, message_link = $5,
       bot_file_id = $6, bot_file_unique_id = $7, mtproto_document_id = $8, uploaded_at = now(), verified_at = NULL
     FROM video_assets a
     WHERE p.asset_id = $1 AND p.part_number = $2 AND a.id = p.asset_id AND a.state IN ('uploading','verifying')
     RETURNING p.*`,
    [assetId, partNumber, chatId, messageId, link, ref.botFileId ?? null, ref.botFileUniqueId ?? null,
      ref.documentId == null ? null : String(ref.documentId)]);
  if (!result.rows.length) fail('STATE_CONFLICT', 'part not found or asset is not accepting uploads');
  return mapPart(result.rows[0]);
}

// Marks a part verified only when the bytes read back match its checksum.
async function markPartVerified(assetId, partNumber, { sha256 } = {}) {
  const result = await db.query(
    `UPDATE video_parts SET state = 'verified', verified_at = now()
     WHERE asset_id = $1 AND part_number = $2 AND state IN ('uploaded','verified') AND sha256 = $3 RETURNING *`,
    [assetId, partNumber, sha256]);
  if (!result.rows.length) {
    const part = (await db.query('SELECT state, sha256 FROM video_parts WHERE asset_id = $1 AND part_number = $2', [assetId, partNumber])).rows[0];
    if (!part) fail('PART_NOT_FOUND');
    if (part.sha256 !== sha256) fail('CHECKSUM_MISMATCH');
    fail('STATE_CONFLICT', `part is ${part.state}`);
  }
  return mapPart(result.rows[0]);
}

async function refreshPartReference(assetId, partNumber, { botFileId, documentId } = {}) {
  if (documentId != null && !/^-?\d{1,20}$/.test(String(documentId))) fail('INVALID_TELEGRAM_REFERENCE');
  const result = await db.query(
    `UPDATE video_parts SET bot_file_id = COALESCE($3, bot_file_id), mtproto_document_id = COALESCE($4, mtproto_document_id),
       reference_refreshed_at = now() WHERE asset_id = $1 AND part_number = $2 AND telegram_message_id IS NOT NULL RETURNING *`,
    [assetId, partNumber, botFileId ?? null, documentId == null ? null : String(documentId)]);
  if (!result.rows.length) fail('PART_NOT_FOUND');
  return mapPart(result.rows[0]);
}

// Atomically publishes Ready and retires the previous ready copy of the same
// variant. The schema refuses unless every part is verified and gap-free.
async function publishReady(assetId, { makeDefault = false } = {}) {
  return db.transaction(async client => {
    const asset = mapAsset((await client.query('SELECT * FROM video_assets WHERE id = $1 FOR UPDATE', [assetId])).rows[0]);
    if (!asset) fail('ASSET_NOT_FOUND');
    if (asset.state !== 'verifying') fail('STATE_CONFLICT', 'asset must be verifying');
    const previous = (await client.query(
      `SELECT id, is_default FROM video_assets WHERE state = 'ready' AND id <> $1 AND imdb_id = $2
         AND COALESCE(season,-1) = COALESCE($3::int,-1) AND COALESCE(episode,-1) = COALESCE($4::int,-1)
         AND quality = $5 AND edition = $6 AND audio_languages = $7 FOR UPDATE`,
      [asset.id, asset.imdbId, asset.season, asset.episode, asset.quality, asset.edition, asset.audioLanguages])).rows[0];
    if (previous) await client.query("UPDATE video_assets SET state = 'superseded' WHERE id = $1", [previous.id]);
    await client.query("UPDATE video_assets SET state = 'ready' WHERE id = $1", [assetId]);
    if (makeDefault || previous?.is_default) await setDefault(assetId, client);
    return { asset: mapAsset((await client.query('SELECT * FROM video_assets WHERE id = $1', [assetId])).rows[0]), supersededId: previous?.id || null };
  });
}

async function setDefault(assetId, client) {
  const run = async c => {
    const asset = (await c.query("SELECT imdb_id, season, episode FROM video_assets WHERE id = $1 AND state = 'ready' FOR UPDATE", [assetId])).rows[0];
    if (!asset) fail('STATE_CONFLICT', 'only ready assets can be the default');
    await c.query(
      `UPDATE video_assets SET is_default = false WHERE is_default AND imdb_id = $1
         AND COALESCE(season,-1) = COALESCE($2::int,-1) AND COALESCE(episode,-1) = COALESCE($3::int,-1)`,
      [asset.imdb_id, asset.season, asset.episode]);
    await c.query('UPDATE video_assets SET is_default = true WHERE id = $1', [assetId]);
  };
  return client ? run(client) : db.transaction(run);
}

// Confirmed loss of a part takes the asset out of playback.
async function markPartMissing(assetId, partNumber) {
  return db.transaction(async client => {
    const part = (await client.query(
      "UPDATE video_parts SET state = 'missing' WHERE asset_id = $1 AND part_number = $2 RETURNING *", [assetId, partNumber])).rows[0];
    if (!part) fail('PART_NOT_FOUND');
    await client.query("UPDATE video_assets SET state = 'unavailable' WHERE id = $1 AND state = 'ready'", [assetId]);
    return mapPart(part);
  });
}

// ---------- playback lookup ----------

const qualityRank = quality => {
  const value = String(quality).toLowerCase();
  if (value === '4k' || value === 'uhd') return 2160;
  const match = /^(\d{3,4})p$/.exec(value);
  return match ? Number(match[1]) : 0;
};

// Ready versions for one movie/episode, best match first. Only ready rows are
// ever returned, so partial uploads can never reach the player.
async function findReadyVersions({ imdbId, season, episode, quality, edition, audioLanguage } = {}) {
  const who = normalizeIdentity({ imdbId, season, episode });
  const rows = (await db.query(
    `SELECT * FROM video_assets WHERE state = 'ready' AND imdb_id = $1
       AND COALESCE(season,-1) = COALESCE($2::int,-1) AND COALESCE(episode,-1) = COALESCE($3::int,-1)`,
    [who.imdbId, who.season, who.episode])).rows.map(mapAsset);
  const wantQuality = quality ? String(quality).toLowerCase() : null;
  const wantLang = audioLanguage ? String(audioLanguage).toLowerCase() : null;
  const score = asset => [
    wantQuality && asset.quality === wantQuality ? 1 : 0,
    wantLang && asset.audioLanguages.includes(wantLang) ? 1 : 0,
    edition && asset.edition === edition ? 1 : 0,
    asset.isDefault ? 1 : 0,
    qualityRank(asset.quality),
    +new Date(asset.readyAt),
  ];
  return rows.sort((a, b) => {
    const x = score(a), y = score(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return 0;
  });
}

async function findReadyAsset(query) {
  const [best] = await findReadyVersions(query);
  if (!best) return null;
  best.parts = await listParts(best.id);
  return best;
}

// ---------- durable jobs ----------

// Claims the next due job (or one whose worker lease expired).
async function claimJob(workerId, { leaseMs = 120000 } = {}) {
  if (typeof workerId !== 'string' || !workerId || workerId.length > 100) fail('INVALID_WORKER_ID');
  return db.transaction(async client => {
    const row = (await client.query(
      `SELECT id FROM video_import_jobs
       WHERE (status = 'queued' AND next_run_at <= now()) OR (status = 'running' AND lease_expires_at < now())
       ORDER BY next_run_at, created_at LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
    if (!row) return null;
    const job = (await client.query(
      `UPDATE video_import_jobs SET status = 'running', lease_owner = $2, attempts = attempts + 1,
         lease_expires_at = now() + ($3::int * interval '1 millisecond'), heartbeat_at = now(), updated_at = now()
       WHERE id = $1 RETURNING *`, [row.id, workerId, leaseMs])).rows[0];
    return mapJob(job);
  });
}

// Claims one specific job (queued, or running with an expired lease). Used by
// the auto-save worker so it only ever runs the import it created.
async function claimJobById(jobId, workerId, { leaseMs = 120000 } = {}) {
  if (typeof workerId !== 'string' || !workerId || workerId.length > 100) fail('INVALID_WORKER_ID');
  const row = (await db.query(
    `UPDATE video_import_jobs SET status = 'running', lease_owner = $2, attempts = attempts + 1,
       lease_expires_at = now() + ($3::int * interval '1 millisecond'), heartbeat_at = now(), updated_at = now()
     WHERE id = $1 AND (status = 'queued' OR (status = 'running' AND lease_expires_at < now())) RETURNING *`,
    [jobId, workerId, leaseMs])).rows[0];
  return mapJob(row);
}

async function heartbeatJob(jobId, workerId, { leaseMs = 120000, progress } = {}) {
  const result = await db.query(
    `UPDATE video_import_jobs SET lease_expires_at = now() + ($3::int * interval '1 millisecond'), heartbeat_at = now(),
       progress = COALESCE($4::jsonb, progress), updated_at = now()
     WHERE id = $1 AND status = 'running' AND lease_owner = $2 RETURNING *`,
    [jobId, workerId, leaseMs, progress ? JSON.stringify(progress) : null]);
  if (!result.rows.length) fail('LEASE_LOST');
  return mapJob(result.rows[0]);
}

async function advanceJob(jobId, workerId, { stage, progress, artifacts } = {}) {
  if (stage && !STAGES.includes(stage)) fail('INVALID_STAGE');
  const result = await db.query(
    `UPDATE video_import_jobs SET stage = COALESCE($3, stage), progress = COALESCE($4::jsonb, progress),
       artifacts = artifacts || COALESCE($5::jsonb, '{}'::jsonb), updated_at = now()
     WHERE id = $1 AND status = 'running' AND lease_owner = $2 RETURNING *`,
    [jobId, workerId, stage ?? null, progress ? JSON.stringify(progress) : null, artifacts ? JSON.stringify(artifacts) : null]);
  if (!result.rows.length) fail('LEASE_LOST');
  return mapJob(result.rows[0]);
}

async function completeJob(jobId, workerId) {
  const result = await db.query(
    `UPDATE video_import_jobs SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL, error_category = NULL, updated_at = now()
     WHERE id = $1 AND status = 'running' AND lease_owner = $2 RETURNING *`, [jobId, workerId]);
  if (!result.rows.length) fail('LEASE_LOST');
  return mapJob(result.rows[0]);
}

// Retryable failures back off exponentially; the last attempt fails the job.
async function failJob(jobId, workerId, { errorCategory, retryable = true, baseDelayMs = 30000, retryAfterMs = 0 } = {}) {
  return db.transaction(async client => {
    const job = mapJob((await client.query(
      "SELECT * FROM video_import_jobs WHERE id = $1 AND status = 'running' AND lease_owner = $2 FOR UPDATE", [jobId, workerId])).rows[0]);
    if (!job) fail('LEASE_LOST');
    const final = !retryable || job.attempts >= job.maxAttempts;
    // Telegram wait responses set a floor on the delay.
    const delay = Math.min(6 * 3600 * 1000, Math.max(retryAfterMs, baseDelayMs * 2 ** Math.max(0, job.attempts - 1)));
    const row = (await client.query(
      `UPDATE video_import_jobs SET status = $3, lease_owner = NULL, lease_expires_at = NULL, error_category = $4,
         next_run_at = now() + ($5::int * interval '1 millisecond'), updated_at = now() WHERE id = $1 AND lease_owner = $2 RETURNING *`,
      [jobId, workerId, final ? 'failed' : 'queued', errorCode(errorCategory), final ? 0 : delay])).rows[0];
    return mapJob(row);
  });
}

// Highest message ID this index has seen in the storage chat. Used to bound
// the search for an upload that Telegram accepted before a worker crashed.
async function maxMessageId(chatId) {
  const row = (await db.query('SELECT max(telegram_message_id) AS max FROM video_parts WHERE telegram_chat_id = $1', [String(chatId)])).rows[0];
  return row?.max == null ? 0 : Number(row.max);
}

// Sends a part back for re-upload (e.g. read-back checksum mismatch). Only
// allowed before Ready; the schema protects stored assets.
async function resetPartForReupload(assetId, partNumber) {
  const result = await db.query(
    "UPDATE video_parts SET state = 'pending', verified_at = NULL WHERE asset_id = $1 AND part_number = $2 AND state IN ('uploaded','verified') RETURNING *",
    [assetId, partNumber]);
  if (!result.rows.length) fail('PART_NOT_FOUND');
  return mapPart(result.rows[0]);
}

async function getActiveJobForAsset(assetId) {
  return mapJob((await db.query("SELECT * FROM video_import_jobs WHERE asset_id = $1 ORDER BY created_at DESC LIMIT 1", [assetId])).rows[0]);
}

async function listAssets({ limit = 50 } = {}) {
  return (await db.query('SELECT * FROM video_assets ORDER BY created_at DESC LIMIT $1', [Math.min(500, Math.max(1, limit))])).rows.map(mapAsset);
}

// ---------- administration (Phase 5) ----------

// Assets with their latest job, newest first, optionally filtered.
async function listAssetsWithJobs({ state, q, limit = 100 } = {}) {
  const params = [], where = [];
  if (state) { params.push(state); where.push(`a.state = $${params.length}`); }
  if (q) { params.push(`%${String(q).slice(0, 100)}%`); where.push(`(a.imdb_id ILIKE $${params.length} OR a.title ILIKE $${params.length})`); }
  params.push(Math.min(500, Math.max(1, limit)));
  const rows = (await db.query(
    `SELECT a.*, j.id AS job_id, j.stage AS job_stage, j.status AS job_status, j.attempts AS job_attempts, j.max_attempts AS job_max_attempts,
       j.next_run_at AS job_next_run_at, j.error_category AS job_error_category
     FROM video_assets a
     LEFT JOIN LATERAL (SELECT * FROM video_import_jobs WHERE asset_id = a.id ORDER BY created_at DESC LIMIT 1) j ON true
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY a.created_at DESC LIMIT $${params.length}`, params)).rows;
  return rows.map(row => ({ ...mapAsset(row), job: row.job_id ? { id: row.job_id, stage: row.job_stage, status: row.job_status,
    attempts: int(row.job_attempts), maxAttempts: int(row.job_max_attempts), nextRunAt: row.job_next_run_at, errorCategory: row.job_error_category } : null }));
}

async function storageCounts() {
  const assets = (await db.query('SELECT state, count(*) AS n FROM video_assets GROUP BY state')).rows;
  const jobs = (await db.query('SELECT status, count(*) AS n FROM video_import_jobs GROUP BY status')).rows;
  const bytes = (await db.query("SELECT COALESCE(sum(total_size), 0) AS b FROM video_assets WHERE state = 'ready'")).rows[0];
  return { assets: Object.fromEntries(assets.map(r => [r.state, int(r.n)])), jobs: Object.fromEntries(jobs.map(r => [r.status, int(r.n)])), readyBytes: int(bytes.b) };
}

async function touchValidated(assetId) {
  await db.query('UPDATE video_assets SET last_validated_at = now() WHERE id = $1', [assetId]);
}

// A part confirmed present and correct again (only while the asset is unavailable).
async function markPartReverified(assetId, partNumber) {
  const result = await db.query(
    "UPDATE video_parts SET state = 'verified', verified_at = now() WHERE asset_id = $1 AND part_number = $2 AND state = 'missing' RETURNING *",
    [assetId, partNumber]);
  if (!result.rows.length) fail('STATE_CONFLICT', 'part is not missing');
  return mapPart(result.rows[0]);
}

// Puts a failed (or stuck) import back in the queue with fresh attempts.
async function retryJob(assetId) {
  const result = await db.query(
    `UPDATE video_import_jobs SET status = 'queued', attempts = 0, next_run_at = now(), lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE id = (SELECT id FROM video_import_jobs WHERE asset_id = $1 ORDER BY created_at DESC LIMIT 1) AND status IN ('failed','queued')
       AND EXISTS (SELECT 1 FROM video_assets WHERE id = $1 AND state NOT IN ('ready','unavailable','superseded')) RETURNING *`,
    [assetId]);
  if (!result.rows.length) fail('STATE_CONFLICT', 'no failed or queued import job for this asset');
  return mapJob(result.rows[0]);
}

// Assets due for a background check: ready, oldest check first.
async function assetsDueForValidation({ olderThanMs = 24 * 3600 * 1000, limit = 5 } = {}) {
  return (await db.query(
    `SELECT * FROM video_assets WHERE state = 'ready' AND (last_validated_at IS NULL OR last_validated_at < now() - ($1::int * interval '1 millisecond'))
     ORDER BY last_validated_at NULLS FIRST LIMIT $2`, [Math.min(olderThanMs, 2147483647), limit])).rows.map(mapAsset);
}

async function getJob(jobId) {
  return mapJob((await db.query('SELECT * FROM video_import_jobs WHERE id = $1', [jobId])).rows[0]);
}

module.exports = {
  VideoStorageError, normalizeIdentity, normalizeVariant, planParts, messageLink,
  createImport, getAsset, listParts, transitionAsset, recordPreparedFile, recordPartUpload, markPartVerified,
  refreshPartReference, publishReady, setDefault, markPartMissing, findReadyVersions, findReadyAsset,
  claimJob, claimJobById, heartbeatJob, advanceJob, completeJob, failJob, getJob, maxMessageId, resetPartForReupload, getActiveJobForAsset, listAssets,
  listAssetsWithJobs, storageCounts, touchValidated, markPartReverified, retryJob, assetsDueForValidation,
};
