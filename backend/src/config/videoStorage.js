// Telegram video storage settings (telegramintegration.md, Phase 1).
// Disabled unless TELEGRAM_STORAGE_ENABLED is exactly "true". Nothing here
// returns secret values; describe() is the only shape safe to log or expose.
const { configuration: telegramConfiguration } = require('../services/telegramStorage');

const DEFAULT_PART_SIZE = 1500000000; // 1500 decimal MB, exact bytes
const MIN_PART_SIZE = 1024 * 1024;
const MAX_PART_SIZE = 2000 * 1024 * 1024; // Local Bot API upload limit
const SECRET_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_API_HASH'];

function integer(env, key, fallback, min, max, errors) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(String(raw).trim()) || !Number.isSafeInteger(value) || value < min || value > max) {
    errors.push(key);
    return fallback;
  }
  return value;
}

function videoStorageConfig(env = process.env) {
  const errors = [];
  const flag = (env.TELEGRAM_STORAGE_ENABLED ?? '').trim().toLowerCase();
  if (flag && !['true', 'false'].includes(flag)) errors.push('TELEGRAM_STORAGE_ENABLED');
  const requested = flag === 'true';
  const partSize = integer(env, 'VIDEO_PART_SIZE_BYTES', DEFAULT_PART_SIZE, MIN_PART_SIZE, MAX_PART_SIZE, errors);
  const uploadConcurrency = integer(env, 'VIDEO_UPLOAD_CONCURRENCY', 2, 1, 4, errors);
  const importMaxAttempts = integer(env, 'VIDEO_IMPORT_MAX_ATTEMPTS', 5, 1, 100, errors);
  const jobLeaseMs = integer(env, 'VIDEO_JOB_LEASE_MS', 120000, 10000, 3600000, errors);
  // Streaming (Phase 3). Defaults come from the measured best on this setup:
  // 4 connections x 2 requests in flight.
  const downloadSessions = integer(env, 'TELEGRAM_DOWNLOAD_SESSIONS', 4, 1, 16, errors);
  const downloadInflight = integer(env, 'TELEGRAM_DOWNLOAD_INFLIGHT', 2, 1, 8, errors);
  const fetchConcurrency = integer(env, 'STREAM_FETCH_CONCURRENCY', 8, 1, 64, errors);
  const prefetchBytes = integer(env, 'STREAM_PREFETCH_BYTES', 24 * 1024 ** 2, 0, 512 * 1024 ** 2, errors);
  const cacheMaxBytes = integer(env, 'STREAM_CACHE_MAX_BYTES', 4 * 1024 ** 3, 64 * 1024 ** 2, 1024 ** 4, errors);
  const cacheDir = env.STREAM_CACHE_DIR ? require('node:path').resolve(env.STREAM_CACHE_DIR) : require('../services/telegramStorage').localWorkDir('stream-cache');
  const ticketTtlMs = integer(env, 'STREAM_TICKET_TTL_MS', 6 * 3600 * 1000, 60000, 24 * 3600 * 1000, errors);

  const telegram = telegramConfiguration(env);
  const missing = requested ? telegram.missing : [];
  if (requested) errors.push(...telegram.errors);

  // A misconfigured switch never enables storage; providers stay in charge.
  const enabled = requested && !missing.length && !errors.length;
  return {
    enabled,
    requested,
    missing,
    errors: [...new Set(errors)],
    partSize,
    uploadConcurrency,
    importMaxAttempts,
    jobLeaseMs,
    downloadSessions, downloadInflight, fetchConcurrency, prefetchBytes, cacheMaxBytes, cacheDir, ticketTtlMs,
    channelId: telegram.channelId,
    telegram: enabled ? telegram : undefined,
  };
}

// Safe summary for logs/admin views: names and numbers only.
function describe(config = videoStorageConfig()) {
  return {
    enabled: config.enabled,
    requested: config.requested,
    missing: config.missing,
    errors: config.errors,
    partSize: config.partSize,
    uploadConcurrency: config.uploadConcurrency,
    importMaxAttempts: config.importMaxAttempts,
    jobLeaseMs: config.jobLeaseMs,
    downloadSessions: config.downloadSessions,
    downloadInflight: config.downloadInflight,
    fetchConcurrency: config.fetchConcurrency,
    prefetchBytes: config.prefetchBytes,
    cacheMaxBytes: config.cacheMaxBytes,
    storageChatConfigured: Boolean(config.channelId),
  };
}

// Defence in depth for any text that might reach a log line.
function redact(text, env = process.env) {
  let output = String(text);
  for (const key of SECRET_KEYS) {
    const value = env[key];
    if (value && value.length >= 8) output = output.split(value).join('[redacted]');
  }
  return output.replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, 'bot[redacted]');
}

module.exports = { videoStorageConfig, describe, redact, DEFAULT_PART_SIZE, MIN_PART_SIZE, MAX_PART_SIZE };
