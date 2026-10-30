// GET /api/stored/available -> { data: [imdbId, ...] }
// Titles that have at least one Ready Telegram-stored copy, so the website can
// mark them "Instant". Empty while TELEGRAM_STORAGE_ENABLED is off. Cached
// briefly; a slow or failing database returns an empty list rather than
// holding up the page.
const express = require('express');
const { videoStorageConfig } = require('../config/videoStorage');

const TTL_MS = 60000, TIMEOUT_MS = 3000;

function createStoredAvailableRouter({ config = () => videoStorageConfig(), query = (sql, params) => require('../config/db').query(sql, params) } = {}) {
  const router = express.Router();
  let cache = null, pending = null;
  router.get('/', async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    if (!config().enabled) return res.json({ data: [] });
    if (cache && Date.now() - cache.at < TTL_MS) return res.json({ data: cache.ids });
    pending ||= (async () => {
      let timer;
      try {
        const rows = await Promise.race([
          query("SELECT DISTINCT imdb_id FROM video_assets WHERE state = 'ready' ORDER BY imdb_id LIMIT 5000"),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS); }),
        ]);
        cache = { ids: rows.rows.map(r => r.imdb_id), at: Date.now() };
      } catch { /* keep the previous list, or none */ }
      finally { clearTimeout(timer); pending = null; }
    })();
    await pending;
    res.json({ data: cache?.ids || [] });
  });
  return router;
}

module.exports = createStoredAvailableRouter();
module.exports.createStoredAvailableRouter = createStoredAvailableRouter;
