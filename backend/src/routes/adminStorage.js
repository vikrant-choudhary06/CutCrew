// Admin API for Telegram video storage (telegramintegration.md, Phase 5).
// Mounted at /api/admin/storage behind adminAuth. Actions (POST) also require
// the X-CutCrew-Admin header, which a cross-site form cannot send, so a
// browser's saved admin login can't be used to trigger them from elsewhere.
// Responses contain codes, counts and private Telegram links only, never
// tokens, hashes of secrets or raw download URLs.
const express = require('express');
const { videoStorageConfig, describe } = require('../config/videoStorage');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATES = ['pending', 'validating', 'preparing', 'uploading', 'verifying', 'ready', 'failed', 'unavailable', 'superseded'];

function defaultDeps() {
  const runtime = require('../services/storedMediaRuntime');
  return {
    repo: require('../services/videoStorageRepository'),
    maintenance: require('../services/storageMaintenance'),
    metrics: require('../services/storedMetrics'),
    config: () => videoStorageConfig(),
    // Admin checks work even while playback is switched off, as long as the
    // Telegram settings are valid.
    adapter: () => runtime.getAdapter(videoStorageConfig({ ...process.env, TELEGRAM_STORAGE_ENABLED: 'true' })),
    streamer: () => runtime.peekStreamer(),
    forgetAsset: id => runtime.forgetAsset(id),
    botApiReachable: async () => {
      const { configuration } = require('../services/telegramStorage');
      const url = configuration().baseUrl;
      if (!url) return false;
      try { await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'error' }); return true; } catch { return false; }
    },
  };
}

const publicPart = p => ({ part: p.partNumber, offset: p.offset, size: p.size, state: p.state, messageLink: p.messageLink,
  uploadedAt: p.uploadedAt, verifiedAt: p.verifiedAt, referenceRefreshedAt: p.referenceRefreshedAt });
const publicAsset = a => ({ id: a.id, imdbId: a.imdbId, contentType: a.contentType, season: a.season, episode: a.episode, title: a.title,
  releaseYear: a.releaseYear, quality: a.quality, edition: a.edition, audioLanguages: a.audioLanguages, state: a.state, isDefault: a.isDefault,
  failureReason: a.failureReason, totalSize: a.totalSize, partCount: a.partCount, durationSeconds: a.durationSeconds,
  video: a.videoCodec ? `${a.videoCodec} ${a.width}x${a.height}` : null, audioCodec: a.audioCodec, transcoded: a.transcoded,
  createdAt: a.createdAt, readyAt: a.readyAt, lastValidatedAt: a.lastValidatedAt, stateChangedAt: a.stateChangedAt, job: a.job });

function createAdminStorageRouter(deps = defaultDeps()) {
  const router = express.Router();
  const fail = (res, error) => {
    const code = error?.code || 'ADMIN_STORAGE_FAILED';
    const status = ['ASSET_NOT_FOUND', 'PART_NOT_FOUND'].includes(code) ? 404 : ['STATE_CONFLICT', 'ASSET_NOT_UNAVAILABLE', '23514'].includes(code) ? 409 : code === 'STORAGE_DISABLED' ? 503 : 500;
    res.status(status).json({ error: code });
  };
  const requireActionHeader = (req, res, next) => (req.get('x-cutcrew-admin') === '1' ? next() : res.status(403).json({ error: 'ADMIN_ACTION_HEADER_REQUIRED' }));
  const assetId = (req, res, next) => (UUID.test(req.params.id) ? next() : res.status(400).json({ error: 'INVALID_ASSET_ID' }));

  router.get('/summary', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const config = deps.config();
    const [counts, reachable] = await Promise.all([deps.repo.storageCounts().catch(e => ({ error: e.code || 'DATABASE_UNAVAILABLE' })), deps.botApiReachable()]);
    res.json({ switch: describe(config), counts, telegram: { localBotApiReachable: reachable }, monitoring: deps.metrics.summary({ streamer: deps.streamer() }),
      importHint: 'Imports run with: npm run video:import -- import ... (resume queued jobs with: npm run video:import -- resume)' });
  });

  router.get('/assets', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const state = STATES.includes(req.query.state) ? req.query.state : undefined;
    const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : undefined;
    try { res.json({ data: (await deps.repo.listAssetsWithJobs({ state, q, limit: 200 })).map(publicAsset) }); }
    catch (error) { fail(res, error); }
  });

  router.get('/assets/:id', assetId, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const asset = await deps.repo.getAsset(req.params.id);
      if (!asset) return res.status(404).json({ error: 'ASSET_NOT_FOUND' });
      const job = await deps.repo.getActiveJobForAsset(asset.id);
      res.json({ asset: publicAsset(asset), parts: asset.parts.map(publicPart),
        job: job && { id: job.id, stage: job.stage, status: job.status, attempts: job.attempts, maxAttempts: job.maxAttempts, nextRunAt: job.nextRunAt,
          errorCategory: job.errorCategory, progress: { partsUploaded: job.progress.partsUploaded, partsVerified: job.progress.partsVerified, verifyRounds: job.progress.verifyRounds },
          possibleOrphans: job.progress.possibleOrphans || [] } });
    } catch (error) { fail(res, error); }
  });

  const action = (name, run) => router.post(`/assets/:id/${name}`, requireActionHeader, assetId, express.json(), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { const result = await run(req.params.id, req.body || {}); deps.forgetAsset?.(req.params.id); res.json({ ok: true, result }); }
    catch (error) { fail(res, error); }
  });
  action('retry', id => deps.repo.retryJob(id).then(job => ({ jobStatus: job.status, nextRunAt: job.nextRunAt, note: 'Run "npm run video:import -- resume" to process it.' })));
  action('verify', (id, body) => deps.maintenance.verifyAsset(id, { adapter: deps.adapter(), mode: body.mode === 'deep' ? 'deep' : body.mode === 'lookup' ? 'lookup' : 'quick' }));
  action('restore', (id, body) => deps.maintenance.restoreAsset(id, { adapter: deps.adapter(), mode: body.mode === 'deep' ? 'deep' : 'quick' }));
  action('default', id => deps.repo.setDefault(id).then(() => ({ isDefault: true })));
  action('unavailable', id => deps.repo.transitionAsset(id, 'ready', 'unavailable').then(a => ({ state: a.state })));

  return router;
}

module.exports = createAdminStorageRouter();
module.exports.createAdminStorageRouter = createAdminStorageRouter;
