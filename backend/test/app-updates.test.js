// App update endpoints: latest APK info and the self-hosted OTA (Expo Updates) server.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-'));
process.env.UPDATES_DIR = path.join(dir, 'updates');
process.env.APP_RELEASE_FILE = path.join(dir, 'android.json');
const express = require('express');
const app = express().use('/api', require('../src/routes/appUpdates'));
const server = http.createServer(app);
const ready = new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
test.after(() => new Promise(resolve => { server.close(resolve); fs.rmSync(dir, { recursive: true, force: true }); }));
async function get(pathname, headers = {}) {
  await ready;
  const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, { headers });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

test('latest APK info is served, and unsafe release info is refused', async () => {
  fs.writeFileSync(process.env.APP_RELEASE_FILE, JSON.stringify({ version: '1.0.3', versionCode: 4, apkUrl: 'https://github.com/vikrant-choudhary06/CutCrew/releases/download/v1.0.3/CutCrew-android-1.0.3.apk', notes: 'Faster home', sizeMb: 72 }));
  const ok = await get('/api/app/android');
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.text), { version: '1.0.3', versionCode: 4, apkUrl: 'https://github.com/vikrant-choudhary06/CutCrew/releases/download/v1.0.3/CutCrew-android-1.0.3.apk', notes: 'Faster home', sizeMb: 72 });
  // A link to an unknown host or plain http is never offered; the copy in git is used instead.
  fs.writeFileSync(process.env.APP_RELEASE_FILE, JSON.stringify({ version: '9.9.9', versionCode: 99, apkUrl: 'http://evil.example/x.apk' }));
  const fallback = JSON.parse((await get('/api/app/android')).text);
  assert.notEqual(fallback.versionCode, 99);
  assert.match(fallback.apkUrl, /^https:\/\/github\.com\//);
});

test('without a published update the manifest answers 204 (no update)', async () => {
  const none = await get('/api/updates/manifest', { 'expo-platform': 'android', 'expo-runtime-version': '1.0.2', 'expo-protocol-version': '1' });
  assert.equal(none.status, 204);
  assert.equal(none.headers.get('expo-protocol-version'), '1');
  assert.equal((await get('/api/updates/manifest', { 'expo-platform': 'android', 'expo-runtime-version': '../etc' })).status, 400);
});

test('a published update gives a multipart manifest with correct hashes, and its files are served', async () => {
  const update = path.join(process.env.UPDATES_DIR, '1.0.2', '20261106-1200');
  fs.mkdirSync(path.join(update, '_expo/static/js/android'), { recursive: true });
  fs.mkdirSync(path.join(update, 'assets'), { recursive: true });
  const bundle = Buffer.from('console.log("CutCrew OTA test")');
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  fs.writeFileSync(path.join(update, '_expo/static/js/android/entry-abc.hbc'), bundle);
  fs.writeFileSync(path.join(update, 'assets/9f1c'), image);
  fs.writeFileSync(path.join(update, 'metadata.json'), JSON.stringify({ version: 0, bundler: 'metro', fileMetadata: { android: { bundle: '_expo/static/js/android/entry-abc.hbc', assets: [{ path: 'assets\\9f1c', ext: 'png' }] /* as written by expo export on Windows */ } } }));
  fs.writeFileSync(path.join(update, 'expoConfig.json'), JSON.stringify({ name: 'CutCrew', version: '1.0.2' }));
  const response = await get('/api/updates/manifest', { 'expo-platform': 'android', 'expo-runtime-version': '1.0.2', 'expo-protocol-version': '1', 'x-forwarded-proto': 'https' });
  assert.equal(response.status, 200);
  const boundary = /boundary=([^;]+)/.exec(response.headers.get('content-type'))[1];
  const manifestPart = response.text.split(`--${boundary}`).find(part => part.includes('name="manifest"'));
  const manifest = JSON.parse(manifestPart.slice(manifestPart.indexOf('\r\n\r\n') + 4).trim());
  assert.equal(manifest.runtimeVersion, '1.0.2');
  assert.match(manifest.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(manifest.launchAsset.hash, crypto.createHash('sha256').update(bundle).digest('base64url'));
  assert.equal(manifest.assets[0].hash, crypto.createHash('sha256').update(image).digest('base64url'));
  assert.equal(manifest.assets[0].contentType, 'image/png');
  assert.equal(manifest.extra.expoClient.name, 'CutCrew');
  // The test server is local, so its links are http; a public host gets https (below).
  assert.match(manifest.launchAsset.url, /^http:\/\/127\.0\.0\.1:\d+\/api\/updates\/assets\?/);
  const asset = await get(new URL(manifest.launchAsset.url).pathname + new URL(manifest.launchAsset.url).search);
  assert.equal(asset.status, 200);
  assert.equal(asset.text, bundle.toString());
  // Behind the proxies (which report http), a public host still gets https links.
  const express = require('express');
  const proxied = express().use((req, _res, next) => { req.headers.host = 'webcutcrew.vikrant.sbs'; req.headers['x-forwarded-proto'] = 'http'; next(); }).use('/api', require('../src/routes/appUpdates'));
  const other = http.createServer(proxied);
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  const viaProxy = await fetch(`http://127.0.0.1:${other.address().port}/api/updates/manifest`, { headers: { 'expo-platform': 'android', 'expo-runtime-version': '1.0.2' } }).then(r => r.text());
  other.close();
  assert.match(viaProxy, /"url":"https:\/\/webcutcrew\.vikrant\.sbs\/api\/updates\/assets\?/);
  // Other runtime versions (other native builds) do not get this update.
  assert.equal((await get('/api/updates/manifest', { 'expo-platform': 'android', 'expo-runtime-version': '1.0.1' })).status, 204);
  // Files outside the update folder cannot be read.
  assert.equal((await get('/api/updates/assets?runtime=1.0.2&update=20261106-1200&file=../../../android.json')).status, 400);
});
