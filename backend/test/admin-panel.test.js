const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

process.env.PROVIDER_SWITCH_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-switch-')), 'switches.json');
const switches = require('../src/services/providerSwitches');
const live = require('../src/services/liveActivity');

test('a provider switched off stays off until switched on, and is saved', () => {
  switches._reset();
  assert.equal(switches.isOff('hdhub'), false);
  switches.set('hdhub', false);
  assert.equal(switches.isOff('hdhub'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(process.env.PROVIDER_SWITCH_FILE, 'utf8')).off, ['hdhub']);
  switches.set('hdhub', true);
  assert.equal(switches.isOff('hdhub'), false);
  assert.throws(() => switches.set('../etc', false), /Invalid provider/);
});

test('switched-off sources are left out of the play order', () => {
  const sources = require('../src/services/streamSources');
  const all = sources.sourceOrder({ includeOff: true });
  if (!all.length) return;
  switches.set(all[0], false);
  assert.ok(!sources.sourceOrder({ includeOff: true }).includes(all[0]));
  assert.ok(sources.sourceOrder({ includeOff: true, includeSwitchedOff: true }).includes(all[0]));
  switches.set(all[0], true);
});

function serve(app) {
  return new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
}

test('live activity: visitors by client and streams with their bytes', async () => {
  live._reset();
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use('/api', live.track);
  app.get('/api/home', (_req, res) => res.json({ ok: true }));
  app.get('/api/media', (_req, res) => res.end(Buffer.alloc(100000)));
  const server = await serve(app);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  await fetch(base + '/home', { headers: { 'X-Forwarded-For': '203.0.113.7', 'User-Agent': 'okhttp/4.12.0' } });
  await fetch(base + '/home', { headers: { 'X-Forwarded-For': '198.51.100.9', 'User-Agent': 'Mozilla/5.0' } });
  await (await fetch(base + '/media?token=abc', { headers: { 'X-Forwarded-For': '203.0.113.7', 'User-Agent': 'okhttp/4.12.0' } })).arrayBuffer();
  await fetch(base + '/home'); // the server itself is not a visitor
  server.close();
  const now = live.snapshot();
  assert.equal(now.online, 2);
  assert.deepEqual([now.byClient.app, now.byClient.web], [1, 1]);
  assert.equal(now.streaming, 1);
  assert.equal(now.streams[0].ip, '203.0.113.7');
  assert.equal(now.streams[0].bytes, 100000);
  assert.equal(now.streams[0].kind, 'relay');
});

test('admin panel: provider switch needs the action header and a real provider', async () => {
  const app = express();
  app.use('/api/admin/panel', require('../src/routes/adminPanel'));
  const server = await serve(app);
  const base = `http://127.0.0.1:${server.address().port}/api/admin/panel`;
  const list = await (await fetch(base + '/providers')).json();
  assert.ok(list.data.some(p => p.id === 'cutcrew-storage'));
  const post = (id, body, headers = {}) => fetch(base + '/providers/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('cutcrew-storage', { on: false })).status, 403);
  assert.equal((await post('nope', { on: false }, { 'X-CutCrew-Admin': '1' })).status, 404);
  const off = await post('cutcrew-storage', { on: false }, { 'X-CutCrew-Admin': '1' });
  assert.deepEqual(await off.json(), { ok: true, id: 'cutcrew-storage', on: false });
  assert.equal(switches.isOff('cutcrew-storage'), true);
  await post('cutcrew-storage', { on: true }, { 'X-CutCrew-Admin': '1' });
  server.close();
});

test('download links redirect to GitHub', async () => {
  const app = express();
  app.use('/api', require('../src/routes/appUpdates'));
  const server = await serve(app);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const response = await fetch(base + '/app/download/windows', { method: 'HEAD', redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /releases\/latest\/download\/cutcrew-windows-setup\.exe$/);
  assert.equal((await fetch(base + '/app/download/linux', { redirect: 'manual' })).status, 404);
  server.close();
});
