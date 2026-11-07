// API for the admin panel (adminpannel/, served at ccadmin.vikrant.sbs).
// Mounted at /api/admin/panel behind adminAuth. Changes (POST) also need the
// X-CutCrew-Admin header, which a form on another site cannot send.
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const live = require('../services/liveActivity');
const switches = require('../services/providerSwitches');
const downloads = require('../services/appDownloads');

const router = express.Router();
const needsHeader = (req, res, next) => (req.get('x-cutcrew-admin') === '1' ? next() : res.status(403).json({ error: 'ADMIN_ACTION_HEADER_REQUIRED' }));
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Every provider the server knows, with its switch, weekly check and results.
function providers() {
  const sources = require('../services/streamSources');
  const { getAvailableProvidersLocal } = require('../utils/providerHelper');
  const anime = require('../services/animeService');
  const results = require('../services/providerStatus').snapshot();
  const weekly = sources.sourceState();
  const list = [];
  const add = (id, kind, label) => {
    if (list.some(p => p.id === id)) return;
    const r = results[id];
    list.push({ id, kind, label, on: !switches.isOff(id), changedAt: switches.changedAt(id),
      weeklyCheck: weekly[id]?.disabled ? 'failed' : weekly[id] ? 'passed' : 'not run',
      attempts: r?.attempts || 0, successes: r?.successes || 0, failures: r?.failures || 0 });
  };
  add('cutcrew-storage', 'storage', 'CutCrew storage (Telegram)');
  for (const id of sources.sourceOrder({ includeOff: true, includeSwitchedOff: true })) add(id, sources.kindOf(id), sources.labelOf(id));
  for (const id of getAvailableProvidersLocal({ includeSwitchedOff: true })) add(id, 'vega', id);
  for (const id of anime.providerIds({ includeSwitchedOff: true })) add(id, 'anime', id);
  return list;
}

function server() {
  let disk = null;
  try {
    const stat = fs.statfsSync(path.resolve(__dirname, '../../.local'));
    disk = { freeGb: Number((stat.bavail * stat.bsize / 1e9).toFixed(1)), totalGb: Number((stat.blocks * stat.bsize / 1e9).toFixed(1)) };
  } catch { /* not available */ }
  const memory = process.memoryUsage();
  return { uptimeSeconds: Math.floor(process.uptime()), load: os.loadavg().map(x => Number(x.toFixed(2))), cpus: os.cpus().length,
    memory: { usedMb: Math.round((os.totalmem() - os.freemem()) / 1e6), totalMb: Math.round(os.totalmem() / 1e6), backendMb: Math.round(memory.rss / 1e6) },
    disk, conversions: require('../services/remuxService').activeConversions(), node: process.version };
}

router.get('/overview', async (_req, res) => {
  const now = live.snapshot();
  const [users, dl, storage] = await Promise.all([
    require('../models').User.countDocuments().catch(() => null),
    downloads.stats().then(s => s.totals).catch(() => []),
    require('../services/videoStorageRepository').storageCounts().catch(() => null),
  ]);
  const list = providers();
  res.json({
    live: { online: now.online, byClient: now.byClient, streaming: now.streaming, bandwidthMbps: now.bandwidthMbps },
    server: server(), registeredUsers: users, downloads: dl, storage,
    providers: { on: list.filter(p => p.on).length, off: list.filter(p => !p.on).length },
    app: require('./appUpdates').readRelease(), autoArchive: require('../services/autoArchive').status(),
  });
});

router.get('/live', (_req, res) => res.json(live.snapshot()));

router.get('/downloads', async (_req, res) => {
  try {
    const [stats, github] = await Promise.all([downloads.stats(), downloads.githubCounts()]);
    res.json({ ...stats, github: github || [] });
  } catch (error) { res.status(500).json({ error: error.code || 'DOWNLOADS_UNAVAILABLE' }); }
});

router.get('/providers', (_req, res) => res.json({ data: providers() }));
router.post('/providers/:id', needsHeader, express.json(), (req, res) => {
  if (typeof req.body?.on !== 'boolean') return res.status(400).json({ error: 'ON_MUST_BE_TRUE_OR_FALSE' });
  if (!providers().some(p => p.id === req.params.id)) return res.status(404).json({ error: 'PROVIDER_NOT_FOUND' });
  try {
    const result = switches.set(req.params.id, req.body.on);
    console.warn(JSON.stringify({ event: 'provider-switched', provider: result.id, on: result.on }));
    res.json({ ok: true, ...result });
  } catch (error) { res.status(400).json({ error: error.code || 'SWITCH_FAILED' }); }
});

module.exports = router;
