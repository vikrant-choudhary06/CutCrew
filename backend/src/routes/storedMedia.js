// HTTP gateway for Telegram-stored videos (telegramintegration.md, Phase 3).
//   GET|HEAD /api/stored-media/:ticket
// Serves one Ready asset as a single MP4 with standard byte ranges. Returns
// 404 for everything while TELEGRAM_STORAGE_ENABLED is off.
const express = require('express');
const { videoStorageConfig } = require('../config/videoStorage');
const tickets = require('../services/storedMediaTicket');
const { parseRange } = require('../services/storedStream');

const ASSET_TTL_MS = 30000;

// Real dependencies, created on first use so a disabled server never connects to Telegram.
function defaultDeps() {
  let streamer, assets = new Map();
  return {
    config: () => videoStorageConfig(),
    streamer: () => {
      if (streamer) return streamer;
      const config = videoStorageConfig();
      const { createTelegramAdapter } = require('../services/videoStorageAdapter');
      const { BlockCache } = require('../services/streamCache');
      const { StoredStreamer } = require('../services/storedStream');
      const repo = require('../services/videoStorageRepository');
      streamer = new StoredStreamer({
        adapter: createTelegramAdapter(config.telegram, { downloadSessions: config.downloadSessions, downloadInflight: config.downloadInflight }),
        cache: new BlockCache({ dir: config.cacheDir, maxBytes: config.cacheMaxBytes }),
        fetchConcurrency: config.fetchConcurrency,
        prefetchBytes: config.prefetchBytes,
        // Only a confirmed missing Telegram message takes the asset out of playback.
        onPartMissing: part => repo.markPartMissing(part.assetId, part.partNumber).then(() => assets.delete(part.assetId)),
      });
      return streamer;
    },
    // Ready assets are immutable; a short cache avoids a database round trip per range request.
    asset: async id => {
      const hit = assets.get(id);
      if (hit && Date.now() - hit.at < ASSET_TTL_MS) return hit.asset;
      const asset = await require('../services/videoStorageRepository').getAsset(id);
      assets.set(id, { asset, at: Date.now() });
      return asset;
    },
  };
}

function createStoredMediaRouter(deps = defaultDeps()) {
  const router = express.Router();
  const handler = async (req, res) => {
    if (!deps.config().enabled) return res.status(404).json({ message: 'Not found' });
    const assetId = tickets.verify(req.params.ticket);
    if (!assetId) return res.status(403).json({ message: 'Invalid or expired playback ticket' });
    let asset;
    try { asset = await deps.asset(assetId); }
    catch { return res.status(503).json({ message: 'Stored video is temporarily unavailable' }); }
    if (!asset || asset.state !== 'ready' || !asset.parts?.length) return res.status(404).json({ message: 'Stored video not available' });

    const size = asset.totalSize;
    const range = parseRange(req.headers.range, size);
    res.set({
      'Accept-Ranges': 'bytes',
      'Content-Type': 'video/mp4',
      'Cache-Control': 'private, max-age=0, no-transform',
      'X-Content-Type-Options': 'nosniff',
      ETag: `"${asset.sha256.slice(0, 32)}"`,
    });
    if (range.type === 'unsatisfiable') return res.status(416).set('Content-Range', `bytes */${size}`).end();
    const start = range.type === 'partial' ? range.start : 0;
    const end = range.type === 'partial' ? range.end : size - 1;
    if (range.type === 'partial') res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
    else res.status(200);
    res.set('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD') return res.end();

    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      await deps.streamer().streamRange(asset, start, end, res, controller.signal);
      res.end();
    } catch (error) {
      if (controller.signal.aborted) return; // viewer left; nothing to report
      // Headers are already out, so the only safe signal is a broken connection.
      res.destroy(error);
    }
  };
  router.get('/:ticket', handler);
  router.head('/:ticket', handler);
  return router;
}

module.exports = createStoredMediaRouter();
module.exports.createStoredMediaRouter = createStoredMediaRouter;
