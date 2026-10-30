// In-memory monitoring for Telegram-stored playback (Phase 5). Keeps the most
// recent events per kind and summarises them for the admin page. Resets on
// restart by design: no viewer data is persisted.
const LIMIT = 500;
const requests = [];  // gateway range responses
const playback = [];  // player samples (startup, stalls)
const push = (list, item) => { list.push(item); if (list.length > LIMIT) list.splice(0, list.length - LIMIT); };

function recordRequest({ assetId, start, end, firstByteMs, bytes, ms, outcome, code }) {
  push(requests, { at: Date.now(), assetId, start, end, firstByteMs, bytes, ms, outcome, code });
}
function recordPlayback({ assetId, event, startupMs, stalls, stalledSeconds, playedSeconds, bufferAhead }) {
  push(playback, { at: Date.now(), assetId, event, startupMs, stalls, stalledSeconds, playedSeconds, bufferAhead });
}

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]);
};

function summary({ windowMs = 24 * 3600 * 1000, streamer, now = Date.now() } = {}) {
  const recent = requests.filter(r => now - r.at <= windowMs);
  const ok = recent.filter(r => r.outcome === 'ok');
  const firstBytes = recent.filter(r => Number.isFinite(r.firstByteMs)).map(r => r.firstByteMs);
  const sent = recent.reduce((n, r) => n + (r.bytes || 0), 0);
  const throughput = ok.filter(r => r.bytes > 4 * 1024 * 1024 && r.ms > 0).map(r => r.bytes * 8 / r.ms / 1000);
  const errors = {};
  for (const r of recent.filter(r => r.outcome === 'error')) errors[r.code || 'UNKNOWN'] = (errors[r.code || 'UNKNOWN'] || 0) + 1;

  // Each player session reports cumulative numbers; keep the latest per asset/time bucket.
  const samples = playback.filter(s => now - s.at <= windowMs);
  const startups = samples.filter(s => Number.isFinite(s.startupMs) && s.startupMs > 0).map(s => s.startupMs);
  const latest = new Map();
  for (const s of samples) latest.set(`${s.assetId}:${Math.floor(s.at / 3600000)}`, s);
  const totals = [...latest.values()].reduce((t, s) => ({ played: t.played + (s.playedSeconds || 0), stalls: t.stalls + (s.stalls || 0), stalled: t.stalled + (s.stalledSeconds || 0) }), { played: 0, stalls: 0, stalled: 0 });

  const cache = streamer?.cache?.usage();
  const fetched = streamer?.stats;
  return {
    windowHours: Math.round(windowMs / 3600000),
    requests: { total: recent.length, ok: ok.length, aborted: recent.filter(r => r.outcome === 'aborted').length, errors },
    firstByteMs: { p50: percentile(firstBytes, 0.5), p95: percentile(firstBytes, 0.95) },
    deliveredMB: Math.round(sent / 1e6),
    deliveryMbps: { p50: percentile(throughput, 0.5) },
    player: { sessions: latest.size, startupMs: { p50: percentile(startups, 0.5), p95: percentile(startups, 0.95) },
      playedMinutes: Math.round(totals.played / 60), stalls: totals.stalls, stalledSeconds: Math.round(totals.stalled),
      stallsPerHour: totals.played > 0 ? +(totals.stalls / (totals.played / 3600)).toFixed(2) : null },
    cache: cache ? { usedMB: Math.round(cache.bytes / 1e6), maxMB: Math.round(cache.maxBytes / 1e6), blocks: cache.blocks,
      hitRate: cache.hits + cache.misses ? +(cache.hits / (cache.hits + cache.misses)).toFixed(3) : null, evictions: cache.evictions, corrupt: cache.corrupt } : null,
    telegram: fetched ? { blocksFetched: fetched.blocksFetched, fetchedMB: Math.round(fetched.bytesFetched / 1e6), retries: fetched.chunkRetries,
      integrityRefetches: fetched.integrityRefetches, missingPartsReported: streamer.reportedMissing?.size || 0 } : null,
  };
}

function reset() { requests.length = 0; playback.length = 0; }

module.exports = { recordRequest, recordPlayback, summary, reset };
