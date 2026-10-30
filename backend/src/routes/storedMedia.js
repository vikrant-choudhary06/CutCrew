// HTTP gateway for Telegram-stored videos (telegramintegration.md, Phase 3/5).
//   GET|HEAD /api/stored-media/:ticket
// Serves one Ready asset as a single MP4 with standard byte ranges. Returns
// 404 for everything while TELEGRAM_STORAGE_ENABLED is off.
const express = require('express');
const { videoStorageConfig } = require('../config/videoStorage');
const tickets = require('../services/storedMediaTicket');
const { parseRange } = require('../services/storedStream');

// Real dependencies: the shared per-process runtime (one Telegram connection
// and cache), created on first use so a disabled server never connects.
function defaultDeps() {
  const runtime = require('../services/storedMediaRuntime');
  return {
    config: () => videoStorageConfig(),
    streamer: () => runtime.getStreamer(),
    asset: id => runtime.getAsset(id),
    metrics: require('../services/storedMetrics'),
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

    // Monitoring: time to first byte, bytes delivered, outcome.
    const began = Date.now();
    let firstByteMs = null, sent = 0;
    const write = res.write.bind(res);
    res.write = (chunk, ...rest) => { if (firstByteMs === null) firstByteMs = Date.now() - began; sent += chunk.length; return write(chunk, ...rest); };
    const record = (outcome, code) => deps.metrics?.recordRequest({ assetId, start, end, firstByteMs, bytes: sent, ms: Date.now() - began, outcome, code });

    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      await deps.streamer().streamRange(asset, start, end, res, controller.signal);
      res.end();
      record('ok');
    } catch (error) {
      if (controller.signal.aborted) { record('aborted'); return; } // viewer left or seeked away
      record('error', error.code || 'STREAM_FAILED');
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
