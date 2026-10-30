// One shared Telegram connection, block cache and streamer per server process
// (Phase 5). The gateway, admin page and background checks all use it, so
// admin numbers describe the same cache and downloads viewers use.
// Nothing connects to Telegram until first use.
const { videoStorageConfig } = require('../config/videoStorage');

const ASSET_TTL_MS = 30000;
let adapter, streamer;
const assets = new Map();

function getAdapter(config = videoStorageConfig()) {
  if (adapter) return adapter;
  if (!config.telegram) throw Object.assign(new Error('STORAGE_DISABLED'), { code: 'STORAGE_DISABLED' });
  const { createTelegramAdapter } = require('./videoStorageAdapter');
  adapter = createTelegramAdapter(config.telegram, { downloadSessions: config.downloadSessions, downloadInflight: config.downloadInflight });
  return adapter;
}

function getStreamer(config = videoStorageConfig()) {
  if (streamer) return streamer;
  const { BlockCache } = require('./streamCache');
  const { StoredStreamer } = require('./storedStream');
  const repo = require('./videoStorageRepository');
  streamer = new StoredStreamer({
    adapter: getAdapter(config),
    cache: new BlockCache({ dir: config.cacheDir, maxBytes: config.cacheMaxBytes }),
    fetchConcurrency: config.fetchConcurrency,
    prefetchBytes: config.prefetchBytes,
    // Only a confirmed missing Telegram message takes the asset out of playback.
    onPartMissing: part => repo.markPartMissing(part.assetId, part.partNumber).then(() => assets.delete(part.assetId)),
  });
  return streamer;
}

const peekStreamer = () => streamer;

// Ready assets are immutable; a short cache avoids a database round trip per range request.
async function getAsset(id) {
  const hit = assets.get(id);
  if (hit && Date.now() - hit.at < ASSET_TTL_MS) return hit.asset;
  const asset = await require('./videoStorageRepository').getAsset(id);
  assets.set(id, { asset, at: Date.now() });
  return asset;
}
const forgetAsset = id => { assets.delete(id); };

module.exports = { getAdapter, getStreamer, peekStreamer, getAsset, forgetAsset };
