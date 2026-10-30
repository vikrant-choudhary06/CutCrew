// Telegram storage Phase 3: exact range retrieval, bounded cache, HTTP gateway.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { Writable } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const db = require('../src/config/db');
const repo = require('../src/services/videoStorageRepository');
const { createMemoryAdapter } = require('../src/services/videoStorageAdapter');
const { BlockCache } = require('../src/services/streamCache');
const { StoredStreamer, PriorityLimiter, planRange, parseRange, CHUNK } = require('../src/services/storedStream');
const tickets = require('../src/services/storedMediaTicket');
const { createStoredMediaRouter } = require('../src/routes/storedMedia');

const CHAT = '-1001234567890';
const MiB = 1024 * 1024;
const sha = b => createHash('sha256').update(b).digest('hex');
let tmp, adapter, data, asset;

// Builds an in-memory stored asset: data split into parts, each part uploaded
// to the memory adapter, with block hashes at `blockSize`.
async function makeAsset(bytes, partSize, blockSize, store = adapter) {
  const parts = [];
  for (let offset = 0, n = 1; offset < bytes.length; offset += partSize, n++) {
    const slice = bytes.subarray(offset, Math.min(offset + partSize, bytes.length));
    const file = path.join(tmp, `${randomUUID()}.bin`);
    await fs.writeFile(file, slice);
    const ref = await store.uploadPart({ filePath: file, caption: 'test' });
    const blocks = [];
    for (let b = 0; b < slice.length; b += blockSize) blocks.push(sha(slice.subarray(b, b + blockSize)));
    parts.push({ assetId: null, partNumber: n, offset, size: slice.length, sha256: sha(slice), state: 'verified',
      integrityManifest: { algorithm: 'sha256', blockSize, blocks },
      telegramChatId: ref.chatId, telegramMessageId: ref.messageId, mtprotoDocumentId: ref.documentId });
  }
  const id = randomUUID();
  parts.forEach(p => { p.assetId = id; });
  return { id, state: 'ready', totalSize: bytes.length, sha256: sha(bytes), parts };
}
function sink({ highWaterMark = 64 * 1024, delayMs = 0 } = {}) {
  const chunks = [];
  const out = new Writable({ highWaterMark, write(chunk, _e, cb) { chunks.push(Buffer.from(chunk)); delayMs ? setTimeout(cb, delayMs) : cb(); } });
  out.bytes = () => Buffer.concat(chunks);
  return out;
}
const newCache = (name, maxBytes = 512 * MiB) => new BlockCache({ dir: path.join(tmp, name), maxBytes });
async function read(streamer, a, start, end, opts) {
  const out = sink(opts);
  await streamer.streamRange(a, start, end, out, new AbortController().signal);
  return out.bytes();
}

before(async () => {
  await require('./connect-test-db.cjs')();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcrew-stream-'));
  adapter = createMemoryAdapter({ chatId: CHAT });
  data = randomBytes(5 * MiB + 12345);
  // Parts of 2 MiB, blocks of 1.5 MiB: blocks straddle 1 MiB boundaries on purpose.
  asset = await makeAsset(data, 2 * MiB, 1.5 * MiB);
});
after(async () => { await db.close(); await fs.rm(tmp, { recursive: true, force: true }); });

// ---------- range rules ----------

test('HTTP range parsing covers single, open-ended, suffix, invalid and multi-range requests', () => {
  const size = 1000;
  assert.deepEqual(parseRange(undefined, size), { type: 'full' });
  assert.deepEqual(parseRange('bytes=0-', size), { type: 'partial', start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=10-19', size), { type: 'partial', start: 10, end: 19 });
  assert.deepEqual(parseRange('bytes=990-5000', size), { type: 'partial', start: 990, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', size), { type: 'partial', start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-5000', size), { type: 'partial', start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=999-999', size), { type: 'partial', start: 999, end: 999 });
  assert.equal(parseRange('bytes=1000-', size).type, 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', size).type, 'unsatisfiable');
  for (const ignored of ['bytes=0-10,20-30', 'items=0-10', 'bytes=20-10', 'bytes=-', 'garbage']) assert.equal(parseRange(ignored, size).type, 'full', ignored);
});

test('original offsets map to the right part, block and local slice across part boundaries', () => {
  const plan = planRange(asset, 2 * MiB - 10, 2 * MiB + 9);
  assert.deepEqual(plan.map(p => [p.part.partNumber, p.block, p.sliceFrom, p.sliceTo]),
    [[1, 1, 0.5 * MiB - 10, 0.5 * MiB - 1], [2, 0, 0, 9]]);
  assert.equal(planRange(asset, 0, data.length - 1).reduce((n, p) => n + p.sliceTo - p.sliceFrom + 1, 0), data.length);
});

// ---------- streaming ----------

test('exact bytes for start, middle, end, suffix, open-ended, single-byte and cross-part ranges', async () => {
  const streamer = new StoredStreamer({ adapter, cache: newCache('exact') });
  const size = data.length;
  for (const [start, end] of [[0, 99], [0, size - 1], [3 * MiB + 7, 3 * MiB + 70000], [size - 100, size - 1],
    [size - 1, size - 1], [2 * MiB - 1, 2 * MiB], [1.5 * MiB - 3, 4.5 * MiB + 3], [1234567, size - 1]]) {
    assert.ok((await read(streamer, asset, start, end)).equals(data.subarray(start, end + 1)), `${start}-${end}`);
  }
});

test('every Telegram request stays inside one 1 MiB boundary and at most 1 MiB long', async () => {
  const seen = [];
  const checked = { ...adapter, readRange: (ref, offset, length, opts) => {
    seen.push([offset, length]);
    assert.ok(length <= CHUNK && Math.floor(offset / CHUNK) === Math.floor((offset + length - 1) / CHUNK), `${offset}+${length}`);
    return adapter.readRange(ref, offset, length, opts);
  } };
  const streamer = new StoredStreamer({ adapter: checked, cache: newCache('align') });
  assert.ok((await read(streamer, asset, 0, data.length - 1)).equals(data));
  assert.ok(seen.length >= 6);
});

test('concurrent viewers share downloads and a second viewer is served from cache', async () => {
  const streamer = new StoredStreamer({ adapter, cache: newCache('share') });
  const blocks = planRange(asset, 0, data.length - 1).length;
  const outputs = await Promise.all(Array.from({ length: 8 }, () => read(streamer, asset, 0, data.length - 1)));
  outputs.forEach(o => assert.ok(o.equals(data)));
  assert.equal(streamer.stats.blocksFetched, blocks, 'each block downloaded once');
  assert.ok((await read(streamer, asset, 100, 200000)).equals(data.subarray(100, 200001)));
  assert.equal(streamer.stats.blocksFetched, blocks, 'no new download for cached data');
  assert.ok(streamer.cache.usage().hits > 0);
});

test('slow clients get exact bytes with backpressure', async () => {
  const streamer = new StoredStreamer({ adapter, cache: newCache('slow') });
  const bytes = await read(streamer, asset, 1000, 3 * MiB, { highWaterMark: 1024, delayMs: 0 });
  assert.ok(bytes.equals(data.subarray(1000, 3 * MiB + 1)));
});

test('corrupted Telegram data is refetched once, and persistent corruption fails safely', async () => {
  let flips = 1;
  const flaky = { ...adapter, readRange: async (...args) => { const b = await adapter.readRange(...args); if (flips-- > 0) b[0] ^= 1; return b; } };
  const streamer = new StoredStreamer({ adapter: flaky, cache: newCache('corrupt') });
  assert.ok((await read(streamer, asset, 0, MiB)).equals(data.subarray(0, MiB + 1)));
  assert.equal(streamer.stats.integrityRefetches, 1);
  const broken = { ...adapter, readRange: async (...args) => { const b = await adapter.readRange(...args); b[0] ^= 1; return b; } };
  await assert.rejects(read(new StoredStreamer({ adapter: broken, cache: newCache('broken') }), asset, 0, 10), /BLOCK_INTEGRITY_FAILED/);
});

test('cache survives restarts, drops crash leftovers and detects tampered files', async () => {
  const cache = newCache('restart');
  const first = new StoredStreamer({ adapter, cache });
  await read(first, asset, 0, data.length - 1);
  const dir = path.join(tmp, 'restart', asset.id);
  await fs.writeFile(path.join(dir, `1-0.blk.${randomUUID()}.tmp`), 'partial write');
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.blk'));
  const tampered = path.join(dir, files[0]);
  const bytes = await fs.readFile(tampered); bytes[10] ^= 0xff; await fs.writeFile(tampered, bytes);

  const restarted = new StoredStreamer({ adapter, cache: newCache('restart') });
  assert.ok((await read(restarted, asset, 0, data.length - 1)).equals(data));
  assert.equal(restarted.stats.blocksFetched, 1, 'only the tampered block is downloaded again');
  assert.equal(restarted.cache.usage().corrupt, 1);
  assert.equal((await fs.readdir(dir)).some(f => f.endsWith('.tmp')), false);
});

test('the cache never exceeds its quota and evicts least-recently-used blocks', async () => {
  const cache = newCache('quota', 3 * MiB + 1);
  const streamer = new StoredStreamer({ adapter, cache });
  assert.ok((await read(streamer, asset, 0, data.length - 1)).equals(data));
  assert.ok(cache.usage().bytes <= 3 * MiB + 1);
  assert.ok(cache.usage().evictions > 0);
  let onDisk = 0;
  for (const f of await fs.readdir(path.join(tmp, 'quota', asset.id))) onDisk += (await fs.stat(path.join(tmp, 'quota', asset.id, f))).size;
  assert.equal(onDisk, cache.usage().bytes);
});

test('cancelling a stream stops it and abandons queued prefetch work', async () => {
  let reads = 0;
  const slow = { ...adapter, readRange: async (...args) => { reads++; await new Promise(r => setTimeout(r, 40)); return adapter.readRange(...args); } };
  const streamer = new StoredStreamer({ adapter: slow, cache: newCache('cancel'), fetchConcurrency: 1, prefetchBlocks: 3 });
  const controller = new AbortController();
  const out = sink();
  const running = streamer.streamRange(asset, 0, data.length - 1, out, controller.signal);
  setTimeout(() => controller.abort(), 60);
  await assert.rejects(running, err => err.name === 'AbortError' || err.code === 'STREAM_CANCELLED');
  await new Promise(r => setTimeout(r, 300));
  const total = planRange(asset, 0, data.length - 1).reduce((n, p) => n + Math.ceil(p.blockLength / CHUNK) + 1, 0);
  assert.ok(reads < total, `stopped early (${reads} reads)`);
  assert.ok(streamer.stats.prefetchCancelled > 0);
});

test('temporary Telegram failures are retried; a confirmed missing message marks the part', async () => {
  let failures = 2;
  const flaky = { ...adapter, readRange: async (...args) => { if (failures-- > 0) throw Object.assign(new Error('net'), { code: 'ECONNRESET' }); return adapter.readRange(...args); } };
  const streamer = new StoredStreamer({ adapter: flaky, cache: newCache('retry'), retryBaseMs: 1 });
  assert.ok((await read(streamer, asset, 0, 1000)).equals(data.subarray(0, 1001)));
  assert.equal(streamer.stats.chunkRetries, 2);

  const store = createMemoryAdapter({ chatId: CHAT });
  const lost = await makeAsset(randomBytes(3 * MiB), 2 * MiB, 1.5 * MiB, store);
  store.deleteMessage(lost.parts[1].telegramMessageId);
  const missing = [];
  const s2 = new StoredStreamer({ adapter: store, cache: newCache('missing'), retryBaseMs: 1, onPartMissing: async p => missing.push(p.partNumber) });
  await assert.rejects(read(s2, lost, 0, 3 * MiB - 1), /STORED_PART_UNAVAILABLE/);
  assert.deepEqual(missing, [2]);
  const tooLong = { ...adapter, readRange: async () => { throw Object.assign(new Error('wait'), { seconds: 600 }); } };
  await assert.rejects(read(new StoredStreamer({ adapter: tooLong, cache: newCache('wait') }), asset, 0, 10), /TELEGRAM_WAIT_TOO_LONG/);
});

test('requested chunks jump ahead of queued prefetch work', async () => {
  const limiter = new PriorityLimiter(1), order = [];
  const gate = limiter.run(() => new Promise(r => setTimeout(r, 20)), { high: true });
  const low = [1, 2, 3].map(n => limiter.run(async () => order.push('low' + n), { high: false }));
  const high = limiter.run(async () => order.push('high'), { high: true });
  await Promise.all([gate, ...low, high]);
  assert.equal(order[0], 'high');
});

// ---------- tickets and HTTP gateway ----------

test('playback tickets are bound to one asset, expire and resist tampering', () => {
  const id = randomUUID(), ticket = tickets.sign(id, { ttlMs: 1000 });
  assert.equal(tickets.verify(ticket), id);
  assert.equal(tickets.verify(ticket, { now: Date.now() + 2000 }), null);
  const [body, mac] = ticket.split('.');
  const other = Buffer.from(JSON.stringify({ a: randomUUID(), e: Date.now() + 1e6 })).toString('base64url');
  assert.equal(tickets.verify(`${other}.${mac}`), null);
  assert.equal(tickets.verify(`${body}.${mac.slice(0, -2)}xx`), null);
  for (const bad of [undefined, '', 'x', 'a.b.c', 'x'.repeat(600)]) assert.equal(tickets.verify(bad), null);
});

async function serve(deps) {
  const app = express();
  app.use('/api/stored-media', createStoredMediaRouter(deps));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}/api/stored-media/` };
}
const request = (url, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = http.request(url, { method, headers }, res => {
    const chunks = []; res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject); req.end();
});

test('the gateway serves 200/206/416/HEAD with correct headers and exact bytes', async () => {
  const streamer = new StoredStreamer({ adapter, cache: newCache('http') });
  const { server, base } = await serve({ config: () => ({ enabled: true }), streamer: () => streamer, asset: async id => (id === asset.id ? asset : null) });
  const url = base + tickets.sign(asset.id);
  const size = data.length;
  try {
    const head = await request(url, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.headers['content-length'], String(size));
    assert.equal(head.headers['accept-ranges'], 'bytes'); assert.equal(head.headers['content-type'], 'video/mp4'); assert.equal(head.body.length, 0);
    const full = await request(url);
    assert.equal(full.status, 200); assert.ok(full.body.equals(data));
    const part = await request(url, { headers: { Range: `bytes=${2 * MiB - 5}-${2 * MiB + 4}` } });
    assert.equal(part.status, 206); assert.equal(part.headers['content-range'], `bytes ${2 * MiB - 5}-${2 * MiB + 4}/${size}`);
    assert.ok(part.body.equals(data.subarray(2 * MiB - 5, 2 * MiB + 5)));
    const suffix = await request(url, { headers: { Range: 'bytes=-500' } });
    assert.equal(suffix.status, 206); assert.ok(suffix.body.equals(data.subarray(size - 500)));
    const open = await request(url, { headers: { Range: `bytes=${size - 1000}-` } });
    assert.equal(open.headers['content-length'], '1000'); assert.ok(open.body.equals(data.subarray(size - 1000)));
    const bad = await request(url, { headers: { Range: `bytes=${size}-` } });
    assert.equal(bad.status, 416); assert.equal(bad.headers['content-range'], `bytes */${size}`);
    const multi = await request(url, { headers: { Range: 'bytes=0-1,5-6' } });
    assert.equal(multi.status, 200); assert.equal(multi.body.length, size);
    assert.equal((await request(base + 'not-a-ticket')).status, 403);
    assert.equal((await request(base + tickets.sign(asset.id, { ttlMs: -1 }))).status, 403);
    assert.equal((await request(base + tickets.sign(randomUUID()))).status, 404);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test('the gateway returns 404 while the integration switch is off and handles viewers leaving', async () => {
  const off = await serve({ config: () => ({ enabled: false }), streamer: () => { throw new Error('must not connect'); }, asset: async () => asset });
  try { assert.equal((await request(off.base + tickets.sign(asset.id))).status, 404); }
  finally { off.server.closeAllConnections(); await new Promise(r => off.server.close(r)); }

  let aborted = false;
  const slowStreamer = { streamRange: async (_a, _s, _e, out, signal) => {
    out.write(Buffer.alloc(1000));
    await new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
  } };
  const on = await serve({ config: () => ({ enabled: true }), streamer: () => slowStreamer, asset: async () => asset });
  try {
    await new Promise((resolve, reject) => {
      const req = http.get(on.base + tickets.sign(asset.id), res => { res.once('data', () => { req.destroy(); setTimeout(resolve, 100); }); });
      req.on('error', () => {}); setTimeout(() => reject(new Error('timeout')), 3000);
    });
    assert.equal(aborted, true, 'server stopped work when the viewer left');
  } finally { on.server.closeAllConnections(); await new Promise(r => on.server.close(r)); }
});

test('end to end: an asset published in PostgreSQL streams exactly through the gateway', async () => {
  const bytes = randomBytes(3 * MiB + 777), partSize = 2 * MiB;
  const { asset: created } = await repo.createImport({ identity: { imdbId: 'tt9100001', contentType: 'movie' }, variant: { quality: '1080p', audioLanguages: ['en'] }, idempotencyKey: 'stream-e2e-' + randomUUID() });
  await repo.transitionAsset(created.id, 'pending', 'validating');
  await repo.transitionAsset(created.id, 'validating', 'preparing');
  const slices = repo.planParts(bytes.length, partSize).map(p => bytes.subarray(p.offset, p.offset + p.size));
  const blockSize = 1.5 * MiB;
  await repo.recordPreparedFile(created.id, { totalSize: bytes.length, sha256: sha(bytes), partSize,
    parts: slices.map(s => { const blocks = []; for (let b = 0; b < s.length; b += blockSize) blocks.push(sha(s.subarray(b, b + blockSize))); return { sha256: sha(s), integrityManifest: { algorithm: 'sha256', blockSize, blocks } }; }) });
  await repo.transitionAsset(created.id, 'preparing', 'uploading');
  for (const [i, s] of slices.entries()) {
    const file = path.join(tmp, `e2e-${i}.bin`); await fs.writeFile(file, s);
    await repo.recordPartUpload(created.id, i + 1, await adapter.uploadPart({ filePath: file, caption: 'x' }));
  }
  await repo.transitionAsset(created.id, 'uploading', 'verifying');
  for (const [i, s] of slices.entries()) await repo.markPartVerified(created.id, i + 1, { sha256: sha(s) });
  await repo.publishReady(created.id);

  const streamer = new StoredStreamer({ adapter, cache: newCache('e2e') });
  const { server, base } = await serve({ config: () => ({ enabled: true }), streamer: () => streamer, asset: id => repo.getAsset(id) });
  try {
    const res = await request(base + tickets.sign(created.id), { headers: { Range: `bytes=${partSize - 100}-` } });
    assert.equal(res.status, 206);
    assert.ok(res.body.equals(bytes.subarray(partSize - 100)));
    const whole = await request(base + tickets.sign(created.id));
    assert.equal(sha(whole.body), sha(bytes));
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
