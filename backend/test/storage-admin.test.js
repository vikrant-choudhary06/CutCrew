// Telegram storage Phase 5: checks, repair, admin API and monitoring.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const db = require('../src/config/db');
const repo = require('../src/services/videoStorageRepository');
const { createMemoryAdapter } = require('../src/services/videoStorageAdapter');
const { verifyAsset, restoreAsset, revalidateDue } = require('../src/services/storageMaintenance');
const { hashStoredPart } = require('../src/services/storageRead');
const metrics = require('../src/services/storedMetrics');
const tickets = require('../src/services/storedMediaTicket');
const { createAdminStorageRouter } = require('../src/routes/adminStorage');

const CHAT = '-1001234567890', MiB = 1024 * 1024;
const sha = b => createHash('sha256').update(b).digest('hex');
let tmp, adapter, n = 0;

before(async () => {
  await require('./connect-test-db.cjs')();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcrew-admin-'));
  adapter = createMemoryAdapter({ chatId: CHAT });
});
after(async () => { await db.close(); await fs.rm(tmp, { recursive: true, force: true }); });

// A Ready asset with 1 MiB check-blocks, stored in the memory adapter.
async function readyAsset({ bytes = randomBytes(2 * MiB + 4321), partSize = MiB + 512 * 1024, imdbId = `tt95000${String(++n).padStart(2, '0')}`, store = adapter } = {}) {
  const { asset } = await repo.createImport({ identity: { imdbId, contentType: 'movie' }, variant: { quality: '1080p', audioLanguages: ['en'] }, idempotencyKey: 'admin-' + randomUUID(), title: 'Admin Test ' + n });
  await repo.transitionAsset(asset.id, 'pending', 'validating');
  await repo.transitionAsset(asset.id, 'validating', 'preparing');
  const slices = repo.planParts(bytes.length, partSize).map(p => bytes.subarray(p.offset, p.offset + p.size));
  await repo.recordPreparedFile(asset.id, { totalSize: bytes.length, sha256: sha(bytes), partSize,
    parts: slices.map(s => { const blocks = []; for (let b = 0; b < s.length; b += MiB) blocks.push(sha(s.subarray(b, b + MiB))); return { sha256: sha(s), integrityManifest: { algorithm: 'sha256', blockSize: MiB, blocks } }; }) });
  await repo.transitionAsset(asset.id, 'preparing', 'uploading');
  for (const [i, s] of slices.entries()) {
    const file = path.join(tmp, `${randomUUID()}.bin`); await fs.writeFile(file, s);
    await repo.recordPartUpload(asset.id, i + 1, await store.uploadPart({ filePath: file, caption: 'x' }));
  }
  await repo.transitionAsset(asset.id, 'uploading', 'verifying');
  for (const [i, s] of slices.entries()) await repo.markPartVerified(asset.id, i + 1, { sha256: sha(s) });
  await repo.publishReady(asset.id);
  return { id: asset.id, imdbId, bytes };
}

// ---------- checks and repair ----------

test('ordered parallel read-back hashes a whole part exactly', async () => {
  const { id, bytes } = await readyAsset();
  const [part] = await repo.listParts(id);
  let peak = 0, active = 0;
  const counting = { ...adapter, readRange: async (...a) => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); try { return await adapter.readRange(...a); } finally { active--; } } };
  const result = await hashStoredPart(counting, part, { concurrency: 4 });
  assert.equal(result.sha256, sha(bytes.subarray(0, part.size)));
  assert.equal(result.bytes, part.size);
  assert.ok(peak > 1 && peak <= 4, `parallel but bounded (peak ${peak})`);
});

test('quick and deep verify pass for an intact asset and record the check time', async () => {
  const { id } = await readyAsset();
  const quick = await verifyAsset(id, { adapter, mode: 'quick' });
  assert.equal(quick.ok, true); assert.ok(quick.parts.every(p => p.bytesRead > 0));
  const deep = await verifyAsset(id, { adapter, mode: 'deep' });
  assert.equal(deep.ok, true); assert.equal(deep.stateAfter, 'ready');
  assert.ok((await repo.getAsset(id, { withParts: false })).lastValidatedAt);
});

test('a deleted Telegram message is detected, removed from playback, and recoverable once back', async () => {
  const { id, imdbId } = await readyAsset();
  const parts = await repo.listParts(id);
  let hidden = parts[1].telegramMessageId;
  const flaky = { ...adapter,
    lookupMessage: async ref => { if (Number(ref.messageId) === hidden) throw Object.assign(new Error('gone'), { code: 'UPLOADED_MESSAGE_NOT_ACCESSIBLE' }); return adapter.lookupMessage(ref); },
    readRange: async (ref, ...rest) => { if (Number(ref.messageId) === hidden) throw Object.assign(new Error('gone'), { code: 'UPLOADED_MESSAGE_NOT_ACCESSIBLE' }); return adapter.readRange(ref, ...rest); } };
  const report = await verifyAsset(id, { adapter: flaky, mode: 'lookup' });
  assert.equal(report.ok, false); assert.equal(report.stateAfter, 'unavailable');
  assert.deepEqual(report.parts.filter(p => !p.ok).map(p => [p.part, p.code, p.confirmed]), [[2, 'UPLOADED_MESSAGE_NOT_ACCESSIBLE', true]]);
  assert.equal(await repo.findReadyAsset({ imdbId }), null);
  // Still missing: restore refuses and changes nothing.
  assert.equal((await restoreAsset(id, { adapter: flaky })).restored, false);
  // Message reachable again (e.g. a temporary Telegram problem was misjudged): restore.
  hidden = null;
  const restored = await restoreAsset(id, { adapter: flaky, mode: 'deep' });
  assert.equal(restored.restored, true);
  assert.equal((await repo.findReadyAsset({ imdbId })).id, id);
});

test('network trouble during a check is reported but never takes a video out of playback', async () => {
  const { id } = await readyAsset();
  const down = { ...adapter, lookupMessage: async () => { throw Object.assign(new Error('offline'), { code: 'ECONNRESET' }); } };
  const report = await verifyAsset(id, { adapter: down, mode: 'lookup' });
  assert.equal(report.ok, false); assert.equal(report.stateAfter, 'ready');
  assert.ok(report.parts.every(p => p.confirmed === false));
});

test('changed bytes in Telegram are caught by quick verify', async () => {
  const { id } = await readyAsset();
  const lying = { ...adapter, readRange: async (...a) => { const b = await adapter.readRange(...a); b[0] ^= 1; return b; } };
  const report = await verifyAsset(id, { adapter: lying, mode: 'quick' });
  assert.equal(report.stateAfter, 'unavailable');
  assert.ok(report.parts.some(p => p.code === 'BLOCK_MISMATCH'));
});

test('background revalidation checks a bounded number of least-recently-checked videos', async () => {
  await db.query("UPDATE video_assets SET last_validated_at = now() WHERE state = 'ready'");
  const a = await readyAsset(), b = await readyAsset(), c = await readyAsset();
  const result = await revalidateDue({ adapter, limit: 2, mode: 'lookup' });
  assert.equal(result.checked, 2); assert.equal(result.problems.length, 0);
  const checked = (await Promise.all([a, b, c].map(x => repo.getAsset(x.id, { withParts: false })))).filter(x => x.lastValidatedAt).length;
  assert.equal(checked, 2);
});

test('failed imports can be requeued with fresh attempts, and lists/counts reflect state', async () => {
  const { asset, job } = await repo.createImport({ identity: { imdbId: 'tt9599999', contentType: 'movie' }, variant: { quality: '720p', audioLanguages: [] }, idempotencyKey: 'admin-retry-' + randomUUID(), maxAttempts: 1 });
  await db.query("UPDATE video_import_jobs SET next_run_at = now() + interval '1 day' WHERE status = 'queued' AND id <> $1", [job.id]);
  await repo.claimJob('admin-test');
  await repo.failJob(job.id, 'admin-test', { errorCategory: 'TELEGRAM_WAIT' });
  await repo.transitionAsset(asset.id, 'pending', 'failed', { failureReason: 'TELEGRAM_WAIT' });
  const requeued = await repo.retryJob(asset.id);
  assert.equal(requeued.status, 'queued'); assert.equal(requeued.attempts, 0);
  const list = await repo.listAssetsWithJobs({ state: 'failed', q: 'tt9599999' });
  assert.equal(list.length, 1); assert.equal(list[0].job.status, 'queued');
  const counts = await repo.storageCounts();
  assert.ok(counts.assets.ready >= 1 && counts.readyBytes > 0);
});

// ---------- admin API ----------

async function serve(deps) {
  const app = express(); app.use('/api/admin/storage', createAdminStorageRouter(deps));
  const server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}/api/admin/storage` };
}
const deps = () => ({ repo, maintenance: require('../src/services/storageMaintenance'), metrics,
  config: () => require('../src/config/videoStorage').videoStorageConfig({}), adapter: () => adapter, streamer: () => null, botApiReachable: async () => false });

test('admin API: summary, list, details with Telegram links, and protected actions', async () => {
  const { id } = await readyAsset();
  const { server, base } = await serve(deps());
  const call = (p, o) => fetch(base + p, o).then(async r => ({ status: r.status, body: await r.json() }));
  const act = (p, body, header = true) => call(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(header ? { 'X-CutCrew-Admin': '1' } : {}) }, body: JSON.stringify(body || {}) });
  try {
    const summary = await call('/summary');
    assert.equal(summary.status, 200); assert.equal(summary.body.switch.enabled, false);
    assert.equal(summary.body.telegram.localBotApiReachable, false);
    assert.ok(summary.body.counts.assets.ready >= 1);
    assert.equal(/TELEGRAM_BOT_TOKEN|api_hash|bot\d+:/i.test(JSON.stringify(summary.body)), false, 'no secrets in summary');
    const list = await call('/assets?state=ready');
    assert.ok(list.body.data.some(a => a.id === id));
    const detail = await call('/assets/' + id);
    assert.equal(detail.body.parts.length, 2); assert.match(detail.body.parts[0].messageLink, /^https:\/\/t\.me\/c\/\d+\/\d+$/);
    assert.equal('sha256' in detail.body.asset, false);
    assert.equal((await act(`/assets/${id}/verify`, { mode: 'quick' }, false)).status, 403, 'action header required');
    assert.equal((await act('/assets/not-an-id/verify')).status, 400);
    assert.equal((await act(`/assets/${randomUUID()}/verify`)).status, 404);
    const verified = await act(`/assets/${id}/verify`, { mode: 'deep' });
    assert.equal(verified.status, 200); assert.equal(verified.body.result.ok, true);
    assert.equal((await act(`/assets/${id}/default`)).body.result.isDefault, true);
    assert.equal((await act(`/assets/${id}/unavailable`)).body.result.state, 'unavailable');
    assert.equal((await act(`/assets/${id}/unavailable`)).status, 409);
    const restored = await act(`/assets/${id}/restore`, { mode: 'quick' });
    assert.equal(restored.body.result.restored, true);
    assert.equal((await act(`/assets/${id}/retry`)).status, 409, 'no failed job to retry');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

// ---------- monitoring ----------

test('monitoring summarises first byte, delivery speed, errors and player stalls', () => {
  metrics.reset();
  const id = randomUUID();
  [100, 200, 300, 2000].forEach((ms, i) => metrics.recordRequest({ assetId: id, firstByteMs: ms, bytes: 8 * MiB, ms: 1000 + i, outcome: 'ok' }));
  metrics.recordRequest({ assetId: id, firstByteMs: null, bytes: 0, ms: 10, outcome: 'error', code: 'STORED_PART_UNAVAILABLE' });
  metrics.recordRequest({ assetId: id, firstByteMs: 50, bytes: 1000, ms: 20, outcome: 'aborted' });
  metrics.recordPlayback({ assetId: id, event: 'sample', startupMs: 1800, stalls: 2, stalledSeconds: 3, playedSeconds: 1800 });
  const s = metrics.summary();
  assert.equal(s.requests.total, 6); assert.equal(s.requests.aborted, 1); assert.deepEqual(s.requests.errors, { STORED_PART_UNAVAILABLE: 1 });
  assert.equal(s.firstByteMs.p50, 200); assert.equal(s.firstByteMs.p95, 300);
  assert.ok(s.deliveryMbps.p50 > 60 && s.deliveryMbps.p50 < 70);
  assert.equal(s.player.stalls, 2); assert.equal(s.player.stallsPerHour, 4); assert.equal(s.player.startupMs.p50, 1800);
});

test('the player can report playback numbers for stored sources with its stored ticket', async () => {
  metrics.reset();
  const app = require('../src/app');
  const server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/playback/metrics`;
  const sample = { sessionId: randomUUID(), titleId: 'tt1375666', event: 'sample', playedSeconds: 60, bufferAhead: 20, stalls: 1, stalledSeconds: 2, startupMs: 1500, droppedFrames: 0, totalFrames: 1500 };
  try {
    const ok = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...sample, storedTicket: tickets.sign(randomUUID()) }) });
    assert.equal(ok.status, 202);
    assert.equal(metrics.summary().player.stalls, 1);
    const bad = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...sample, storedTicket: 'forged.ticket' }) });
    assert.equal(bad.status, 403);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
