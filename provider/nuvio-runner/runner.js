// Runs a few Nuvio-style providers (their code is obfuscated and comes from
// other people) away from the CutCrew backend. This container has no secrets,
// no volumes and a read-only disk; the backend only asks it for links:
//   GET /streams?provider=castle&tmdb=872906&type=movie[&season=1&episode=2]
//   -> { streams: [{ url, name, title, quality, headers, ... }] }
const http = require('http');
const path = require('path');

const PORT = Number(process.env.PORT) || 7070;
const TIMEOUT_MS = Number(process.env.NUVIO_TIMEOUT_MS) || 40000;
// Only these files are ever loaded (see SOURCES.md next to this file; they come
// from provider/movie/nuvio and provider/anime/nuvio).
const ALLOWED = new Set(['castle', 'moviebox', 'playimdb', 'einthusan', 'watchanimeworld', 'multimovies']);
const MAX_ACTIVE = 8;
let active = 0;

// The providers print a lot; keep only short notices.
const realLog = console.log;
for (const level of ['log', 'info', 'debug', 'warn', 'error']) console[level] = () => {};
const note = (...parts) => realLog(new Date().toISOString(), ...parts);
process.on('unhandledRejection', () => {});
process.on('uncaughtException', error => note('uncaught', String(error && error.message || error).slice(0, 120)));

const loaded = new Map();
function provider(name) {
  if (!loaded.has(name)) loaded.set(name, require(path.join(__dirname, 'providers', `${name}.js`)));
  const mod = loaded.get(name);
  return mod.getStreams || (mod.default && mod.default.getStreams);
}

const clean = value => (typeof value === 'string' ? value.slice(0, 500) : undefined);
function tidy(item) {
  if (!item || typeof item !== 'object' || typeof item.url !== 'string') return null;
  // A web link, or (NAMA providers) an HLS playlist packed into a data: link.
  const packed = item.url.startsWith('data:application/vnd.apple.mpegurl;base64,') && item.url.length <= 40000;
  if (!packed && (!/^https?:\/\//i.test(item.url) || item.url.length > 4000)) return null;
  const headers = {};
  const given = item.headers || (item.behaviorHints && item.behaviorHints.proxyHeaders && item.behaviorHints.proxyHeaders.request) || {};
  for (const [key, value] of Object.entries(given)) if (typeof value === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(key)) headers[key] = value.slice(0, 1000);
  return { url: item.url, name: clean(item.name), title: clean(item.title), quality: clean(String(item.quality || '')), size: clean(item.size), type: clean(item.type), headers };
}

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms))]);
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://runner');
  if (url.pathname === '/health') return send(res, 200, { ok: true, providers: [...ALLOWED] });
  if (url.pathname !== '/streams' || req.method !== 'GET') return send(res, 404, { error: 'NOT_FOUND' });
  const name = url.searchParams.get('provider'), tmdb = url.searchParams.get('tmdb'), type = url.searchParams.get('type');
  const season = Number(url.searchParams.get('season')) || null, episode = Number(url.searchParams.get('episode')) || null;
  if (!ALLOWED.has(name) || !/^\d{1,9}$/.test(tmdb || '') || !['movie', 'tv'].includes(type)) return send(res, 400, { error: 'BAD_REQUEST' });
  if (active >= MAX_ACTIVE) return send(res, 503, { error: 'BUSY' });
  active++;
  const started = Date.now();
  try {
    const getStreams = provider(name);
    const list = await withTimeout(Promise.resolve(getStreams(tmdb, type, type === 'tv' ? season : null, type === 'tv' ? episode : null)), TIMEOUT_MS);
    const streams = (Array.isArray(list) ? list : []).slice(0, 40).map(tidy).filter(Boolean);
    note(name, tmdb, type, season || '', episode || '', streams.length, `${Date.now() - started}ms`);
    send(res, 200, { streams });
  } catch (error) {
    note(name, tmdb, 'failed', String(error && error.message || error).slice(0, 80));
    send(res, 502, { error: String(error && error.message || 'FAILED').slice(0, 80) });
  } finally { active--; }
}).listen(PORT, () => note(`nuvio runner on ${PORT}`));
