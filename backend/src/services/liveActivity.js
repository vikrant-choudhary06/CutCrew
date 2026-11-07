// Live activity for the admin panel: who is using CutCrew right now and what
// is being streamed. Kept in memory: it is live, not history (APK downloads
// are saved in Postgres, see appDownloads.js).
const crypto = require('crypto');

let geo = null;
// Country code for an IP address, from a database bundled with the server
// (no IP is sent anywhere).
function countryOf(ip) {
  try { geo ||= require('geoip-country'); return geo.lookup(ip)?.country || ''; } catch { return ''; }
}

const VISITOR_MS = 2 * 60000;     // seen in the last 2 minutes = online
const STREAM_MS = 30000;          // bytes sent in the last 30 s = streaming
const visitors = new Map();       // ip -> visitor
const streams = new Map();        // ip + ticket -> stream

const cleanIp = ip => String(ip || '').replace(/^::ffff:/, '');
const local = ip => !ip || ip === '::1' || ip === '127.0.0.1';

function clientOf(req) {
  const ua = req.get('user-agent') || '';
  if (req.query?.client === 'app' || /okhttp|ExoPlayer|CutCrew|Dalvik|androidx\.media3/i.test(ua)) return 'app';
  if (/Electron/i.test(ua)) return 'desktop';
  return 'web';
}

function prune(now = Date.now()) {
  for (const [key, v] of visitors) if (now - v.lastSeen > VISITOR_MS) visitors.delete(key);
  for (const [key, s] of streams) if (s.open === 0 && now - s.lastData > STREAM_MS) streams.delete(key);
}

// Express middleware for /api: notes the visitor, and counts the bytes of
// video requests (relay, converted copies and stored videos).
function track(req, res, next) {
  const ip = cleanIp(req.ip);
  if (local(ip) || req.path.startsWith('/admin') || req.path === '/health' || req.path === '/ready') return next();
  const now = Date.now();
  let visitor = visitors.get(ip);
  if (!visitor) {
    if (visitors.size >= 5000) prune(now);
    visitor = { ip, country: countryOf(ip), client: clientOf(req), path: '', firstSeen: now, lastSeen: now, requests: 0, watching: null };
    visitors.set(ip, visitor);
  }
  visitor.lastSeen = now; visitor.requests++;
  const video = req.path === '/media' ? (req.query.start != null ? 'converted' : 'relay') : req.path.startsWith('/stored-media/') ? 'stored' : '';
  if (!video) { visitor.path = req.path.slice(0, 120); visitor.client = clientOf(req); return next(); }

  // One player makes many range requests for one video: group them.
  const ticket = String(req.query.token || req.path);
  const key = ip + ':' + crypto.createHash('sha1').update(ticket).digest('hex').slice(0, 12);
  let stream = streams.get(key);
  if (!stream) {
    if (streams.size >= 2000) prune(now);
    stream = { id: key, ip, country: visitor.country, client: visitor.client, kind: video, watching: visitor.watching, startedAt: now, lastData: now, bytes: 0, open: 0, samples: [] };
    streams.set(key, stream);
  }
  stream.open++;
  const count = chunk => {
    if (!chunk || typeof chunk === 'function') return;
    const size = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length || 0;
    const t = Date.now();
    stream.bytes += size; stream.lastData = t;
    const last = stream.samples[stream.samples.length - 1];
    if (last && t - last.t < 1000) last.b += size;
    else { stream.samples.push({ t, b: size }); if (stream.samples.length > 15) stream.samples.shift(); }
  };
  const write = res.write, end = res.end;
  res.write = function (chunk, ...rest) { count(chunk); return write.call(this, chunk, ...rest); };
  res.end = function (chunk, ...rest) { count(chunk); return end.call(this, chunk, ...rest); };
  let closed = false;
  res.on('close', () => { if (!closed) { closed = true; stream.open = Math.max(0, stream.open - 1); } });
  next();
}

// The play route says what a visitor asked to watch.
function notePlay(req, { imdbId, title, season = null, episode = null }) {
  const visitor = visitors.get(cleanIp(req.ip));
  if (visitor) visitor.watching = { imdbId, title: String(title || '').slice(0, 120), season, episode, at: Date.now() };
}

function snapshot() {
  const now = Date.now();
  prune(now);
  const online = [...visitors.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  const live = [...streams.values()].filter(s => s.open > 0 || now - s.lastData <= STREAM_MS).map(s => {
    const bytes10 = s.samples.filter(x => now - x.t <= 10000).reduce((sum, x) => sum + x.b, 0);
    return { id: s.id, ip: s.ip, country: s.country, client: s.client, kind: s.kind, watching: s.watching || visitors.get(s.ip)?.watching || null,
      startedAt: s.startedAt, lastData: s.lastData, bytes: s.bytes, mbps: Number((bytes10 * 8 / 10 / 1e6).toFixed(2)) };
  }).sort((a, b) => b.mbps - a.mbps);
  const byClient = { app: 0, web: 0, desktop: 0 };
  for (const v of online) byClient[v.client] = (byClient[v.client] || 0) + 1;
  return {
    online: online.length, byClient, streaming: live.length,
    bandwidthMbps: Number(live.reduce((sum, s) => sum + s.mbps, 0).toFixed(2)),
    visitors: online.slice(0, 300).map(v => ({ ip: v.ip, country: v.country, client: v.client, path: v.path, firstSeen: v.firstSeen, lastSeen: v.lastSeen, requests: v.requests, watching: v.watching })),
    streams: live.slice(0, 300),
  };
}

module.exports = { track, notePlay, snapshot, countryOf, clientOf, cleanIp, _reset: () => { visitors.clear(); streams.clear(); } };
