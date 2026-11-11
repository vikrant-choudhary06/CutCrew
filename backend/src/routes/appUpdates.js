// App updates for the Android app.
//   GET /api/app/android          latest native build (APK) the app may offer
//   GET /api/updates/manifest     Expo Updates (OTA) manifest, protocol 1
//   GET /api/updates/assets?...   files of a published OTA update
// OTA updates are published with android/scripts/publish-update.cjs into
// UPDATES_DIR/<runtimeVersion>/<updateFolder>/ (an `expo export` output plus
// expoConfig.json). The newest folder for the app's runtime version is served.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const router = require('express').Router();

const LOCAL = path.resolve(__dirname, '../../.local');
const updatesDir = () => process.env.UPDATES_DIR || path.join(LOCAL, 'updates');
// Release info: a copy in .local (editable on the server without a rebuild)
// wins over the one in git.
const releaseFiles = () => [process.env.APP_RELEASE_FILE, path.join(LOCAL, 'app-releases/android.json'), path.resolve(__dirname, '../../app-releases/android.json')].filter(Boolean);
// CutCrew's own hosts.
const OWN_HOST = /(^|\.)cutcrew\.click$/i;
const ALLOWED_APK_HOSTS = /^(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com|web\.cutcrew\.click)$/i;

function readRelease() {
  for (const file of releaseFiles()) {
    try {
      const release = JSON.parse(fs.readFileSync(file, 'utf8'));
      const url = new URL(release.apkUrl);
      if (!/^\d+\.\d+\.\d+$/.test(release.version) || !Number.isInteger(release.versionCode) || url.protocol !== 'https:' || !ALLOWED_APK_HOSTS.test(url.hostname)) continue;
      return { version: release.version, versionCode: release.versionCode, apkUrl: url.href,
        ...(release.notes ? { notes: String(release.notes).slice(0, 500) } : {}), ...(release.sizeMb ? { sizeMb: Number(release.sizeMb) } : {}) };
    } catch { /* try the next file */ }
  }
  return null;
}

router.get('/app/android', (req, res) => {
  const release = readRelease();
  if (!release) return res.status(404).json({ message: 'No release information' });
  // The app downloads through our counting link (which redirects to GitHub),
  // so in-app updates show up in the admin panel's downloads.
  // (The proxies in front report http, so the host alone decides.)
  const host = req.get('host') || '';
  const apkUrl = OWN_HOST.test(host) ? `https://${host}/api/app/download/android?from=app` : release.apkUrl;
  // Not cached: the phone's HTTP cache would hide a new release.
  res.set('Cache-Control', 'no-store').json({ ...release, apkUrl });
});

// Download links (website, landing page, app update): count, then send the
// browser on to the file on GitHub.
router.get('/app/download/:platform', (req, res) => {
  const downloads = require('../services/appDownloads');
  const platform = req.params.platform;
  if (!downloads.FILES[platform]) return res.status(404).json({ message: 'Unknown download' });
  const from = ['app', 'landing', 'web'].includes(req.query.from) ? req.query.from : 'web';
  const release = platform === 'android' ? readRelease() : null;
  const target = release && from === 'app' ? release.apkUrl : downloads.latestUrl(platform);
  if (req.method === 'GET') downloads.record(req, { platform, version: release?.version, source: from }).catch(() => {});
  res.set('Cache-Control', 'no-store').redirect(302, target);
});

// ---- Expo Updates ----------------------------------------------------------

const safeName = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value) && !value.startsWith('.');
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('base64url');
const md5 = buffer => crypto.createHash('md5').update(buffer).digest('hex');
const asUuid = hex => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
const TYPES = { js: 'application/javascript', hbc: 'application/javascript', bundle: 'application/javascript', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ttf: 'font/ttf', otf: 'font/otf', json: 'application/json', svg: 'image/svg+xml' };

function latestUpdate(runtimeVersion) {
  if (!safeName(runtimeVersion)) return null;
  const dir = path.join(updatesDir(), runtimeVersion);
  let folders = [];
  try { folders = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && safeName(d.name)).map(d => d.name).sort(); } catch { return null; }
  const folder = folders.at(-1);
  return folder ? { folder, dir: path.join(dir, folder) } : null;
}

const manifestCache = new Map();
function buildManifest(runtimeVersion, platform, publicBase) {
  const update = latestUpdate(runtimeVersion);
  if (!update) return null;
  const key = `${runtimeVersion}:${update.folder}:${platform}:${publicBase}`;
  if (manifestCache.has(key)) return manifestCache.get(key);
  const metadataBuffer = fs.readFileSync(path.join(update.dir, 'metadata.json'));
  const metadata = JSON.parse(metadataBuffer);
  const files = metadata.fileMetadata?.[platform];
  if (!files?.bundle) return null;
  let expoClient = {};
  try { expoClient = JSON.parse(fs.readFileSync(path.join(update.dir, 'expoConfig.json'), 'utf8')); } catch { /* optional */ }
  const asset = (given, ext, contentType) => {
    const relative = String(given).replace(/\\/g, '/'); // exports made on Windows use backslashes
    const buffer = fs.readFileSync(path.join(update.dir, relative));
    const query = new URLSearchParams({ runtime: runtimeVersion, update: update.folder, file: relative });
    return { hash: sha256(buffer), key: md5(buffer), contentType, fileExtension: ext ? `.${ext}` : undefined, url: `${publicBase}/api/updates/assets?${query}` };
  };
  const manifest = {
    id: asUuid(crypto.createHash('sha256').update(metadataBuffer).digest('hex')),
    createdAt: new Date(fs.statSync(path.join(update.dir, 'metadata.json')).mtimeMs).toISOString(),
    runtimeVersion,
    launchAsset: asset(files.bundle, 'bundle', 'application/javascript'),
    assets: (files.assets || []).map(item => asset(item.path, item.ext, TYPES[item.ext] || 'application/octet-stream')),
    metadata: {},
    extra: { expoClient },
  };
  manifestCache.set(key, manifest);
  return manifest;
}

router.get('/updates/manifest', (req, res) => {
  const platform = req.get('expo-platform') || req.query.platform;
  const runtimeVersion = req.get('expo-runtime-version') || req.query['runtime-version'];
  if (!['android', 'ios'].includes(platform) || !safeName(runtimeVersion)) return res.status(400).json({ message: 'Unsupported platform or runtime version' });
  // Phones refuse plain http, and the proxies in front report http, so asset
  // links are https except on a local test server.
  const host = req.get('host') || '';
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  const publicBase = process.env.UPDATES_PUBLIC_URL || `${local ? 'http' : 'https'}://${host}`;
  let manifest;
  try { manifest = buildManifest(runtimeVersion, platform, publicBase); } catch { manifest = null; }
  res.set({ 'expo-protocol-version': '1', 'expo-sfv-version': '0', 'Cache-Control': 'private, max-age=0' });
  // Nothing published for this runtime version: tell the app there is no update.
  if (!manifest) return res.status(204).end();
  const boundary = `cutcrew-${crypto.randomBytes(8).toString('hex')}`;
  const part = (name, body) => `--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${JSON.stringify(body)}\r\n`;
  res.type(`multipart/mixed; boundary=${boundary}`).send(part('manifest', manifest) + part('extensions', { assetRequestHeaders: {} }) + `--${boundary}--\r\n`);
});

router.get('/updates/assets', (req, res) => {
  // Errors must never be cached: a phone keeps a cached answer and stops asking.
  const fail = (status, message) => res.status(status).set('Cache-Control', 'no-store').json({ message });
  const { runtime, update, file } = req.query;
  if (!safeName(runtime) || !safeName(update) || typeof file !== 'string' || !/^[A-Za-z0-9._/-]{1,200}$/.test(file) || file.split('/').some(part => !part || part === '.' || part === '..')) {
    return fail(400, 'Invalid asset');
  }
  const root = path.join(updatesDir(), runtime, update);
  const target = path.resolve(root, file);
  if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) return fail(404, 'Asset not found');
  const ext = path.extname(target).slice(1).toLowerCase();
  // Files of a published update never change, so they may be cached for good.
  // dotfiles: the updates live under .local, which sendFile hides by default.
  res.sendFile(target, { dotfiles: 'allow', headers: { 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Type': TYPES[ext] || 'application/octet-stream' } }, error => {
    if (error && !res.headersSent) fail(404, 'Asset not found');
  });
});

module.exports = router;
module.exports.readRelease = readRelease;
module.exports.buildManifest = buildManifest;
