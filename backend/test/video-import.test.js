// Telegram storage Phase 2: validation, preparation and resumable import.
// Uses real FFmpeg-generated videos and the in-memory storage adapter.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const db = require('../src/config/db');
const repo = require('../src/services/videoStorageRepository');
const prep = require('../src/services/videoPrepare');
const { splitFile, blockSizeFor } = require('../src/services/videoSplit');
const { createMemoryAdapter, buildCaption } = require('../src/services/videoStorageAdapter');
const { runWorker } = require('../src/services/videoImportWorker');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const hasFfmpeg = spawnSync(FFMPEG, ['-version'], { windowsHide: true }).status === 0;
const CHAT = '-1001234567890';
const PART = 64 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let tmp, fx = {}, adapter, counter = 0;

function ffmpeg(args) {
  const result = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...args], { windowsHide: true });
  if (result.status !== 0) throw new Error('fixture generation failed: ' + result.stderr);
}
const av = (seconds = 6) => ['-f', 'lavfi', '-i', `testsrc=size=320x240:rate=25:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`];

before(async () => {
  await require('./connect-test-db.cjs')();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcrew-import-'));
  adapter = createMemoryAdapter({ chatId: CHAT });
  if (!hasFfmpeg) return;
  const h264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-metadata:s:a:0', 'language=hin'];
  fx.nonFaststart = path.join(tmp, 'plain.mp4'); ffmpeg([...av(), ...h264, fx.nonFaststart]);
  fx.faststart = path.join(tmp, 'fast.mp4'); ffmpeg([...av(), ...h264, '-movflags', '+faststart', fx.faststart]);
  fx.mkv = path.join(tmp, 'movie.mkv'); ffmpeg([...av(), ...h264, fx.mkv]);
  fx.mpeg4 = path.join(tmp, 'old.mkv'); ffmpeg([...av(3), '-c:v', 'mpeg4', '-c:a', 'aac', fx.mpeg4]);
  fx.audioOnly = path.join(tmp, 'audio.m4a'); ffmpeg(['-f', 'lavfi', '-i', 'sine=duration=3', '-c:a', 'aac', fx.audioOnly]);
  // Corrupt the middle of the encoded video data.
  fx.corrupt = path.join(tmp, 'corrupt.mp4');
  const bytes = await fs.readFile(fx.faststart);
  for (let i = Math.floor(bytes.length * 0.4); i < Math.floor(bytes.length * 0.6); i++) bytes[i] = 0;
  await fs.writeFile(fx.corrupt, bytes);
});
after(async () => {
  await db.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

// Each test only sees its own job: others are pushed into the future.
async function isolate() {
  await db.query("UPDATE video_import_jobs SET next_run_at = now() + interval '1 day' WHERE status = 'queued'");
}
async function newImport(source, { imdbId, audio = ['hi'], artifacts = {}, identity } = {}) {
  await isolate();
  return repo.createImport({
    identity: identity || { imdbId: imdbId || `tt80000${String(++counter).padStart(2, '0')}`, contentType: 'movie' },
    variant: { quality: '1080p', audioLanguages: audio }, idempotencyKey: `test-import-${counter}-${Date.now()}`,
    title: 'Test Movie', releaseYear: 2026,
    artifacts: { sourcePath: source, decodeMode: 'full', ...artifacts },
  });
}
const ctx = (extra = {}) => ({
  workerId: 'test-worker', adapter, chatId: CHAT, partSize: PART, uploadConcurrency: 2, leaseMs: 60000,
  workRoot: path.join(tmp, 'work'), retryBaseDelayMs: 0, ...extra,
});
const runOnce = (extra) => runWorker(ctx(extra), { maxJobs: 1 });
async function readStored(assetId, via = adapter) {
  const parts = await repo.listParts(assetId);
  return Buffer.concat(await Promise.all(parts.map(p => via.readRange({ chatId: p.telegramChatId, messageId: p.telegramMessageId }, 0, p.size))));
}
const skip = { skip: !hasFfmpeg && 'FFmpeg not installed' };

// ---------- inspection and preparation ----------

test('probe and layout checks detect faststart, containers and unsupported sources', skip, async () => {
  assert.equal((await prep.mp4Layout(fx.nonFaststart)).faststart, false);
  assert.equal((await prep.mp4Layout(fx.faststart)).faststart, true);
  const info = await prep.probe(fx.faststart);
  assert.equal(info.video[0].codec, 'h264'); assert.equal(info.audio[0].language, 'hi'); assert.ok(info.durationSeconds > 5);
  assert.deepEqual(prep.planPreparation(info), { transcodeVideo: false, transcodeAudio: false, needsRemux: false });
  assert.equal(prep.planPreparation(await prep.probe(fx.mkv)).needsRemux, true);
  assert.throws(() => prep.planPreparation({ ...info, video: [] }), /NO_VIDEO_STREAM/);
  assert.throws(() => prep.planPreparation({ ...info, video: [{ codec: 'mpeg4', pixelFormat: 'yuv420p' }] }), /VIDEO_NOT_BROWSER_COMPATIBLE/);
  await assert.rejects(async () => prep.planPreparation(await prep.probe(fx.audioOnly)), /NO_VIDEO_STREAM/);
  await assert.rejects(prep.probe(path.join(tmp, 'missing.mp4')), /SOURCE_NOT_FOUND/);
  assert.throws(() => prep.checkLanguages(info, ['en']), /AUDIO_LANGUAGE_MISMATCH/);
  assert.deepEqual(prep.checkLanguages(info, ['hi']).tagged, ['hi']);
});

test('decode checks reject a corrupted video that metadata alone accepts', skip, async () => {
  const info = await prep.probe(fx.corrupt);
  assert.ok(info.video.length, 'metadata still looks valid');
  await assert.rejects(prep.decodeCheck(fx.corrupt, info, { mode: 'full' }), /DECODE_FAILED/);
  await prep.decodeCheck(fx.faststart, await prep.probe(fx.faststart), { mode: 'full' });
  await prep.decodeCheck(fx.faststart, await prep.probe(fx.faststart), { mode: 'sample' });
});

test('preparation remuxes to faststart MP4 without re-encoding, and transcodes only when allowed', skip, async () => {
  const remuxed = await prep.prepare(fx.nonFaststart, path.join(tmp, 'prep1'), { declaredLanguages: ['hi'] });
  assert.equal(remuxed.remuxed, true); assert.equal(remuxed.transcoded, false);
  assert.equal((await prep.mp4Layout(remuxed.file)).faststart, true);
  assert.equal(remuxed.media.videoCodec, 'h264'); assert.equal(remuxed.media.faststart, true);
  const untouched = await prep.prepare(fx.faststart, path.join(tmp, 'prep2'), { decodeMode: 'sample' });
  assert.equal(untouched.copiedSource, true); assert.equal(untouched.file, fx.faststart);
  await assert.rejects(prep.prepare(fx.mpeg4, path.join(tmp, 'prep3')), /VIDEO_NOT_BROWSER_COMPATIBLE/);
  const transcoded = await prep.prepare(fx.mpeg4, path.join(tmp, 'prep4'), { allowTranscode: true, decodeMode: 'sample' });
  assert.equal(transcoded.transcoded, true); assert.equal(transcoded.media.videoCodec, 'h264');
  assert.equal(transcoded.media.pixelFormat, 'yuv420p');
});

test('exact binary split reproduces the file byte for byte with part and block checksums', async () => {
  const file = path.join(tmp, 'blob.bin'), bytes = Buffer.alloc(200000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 255;
  await fs.writeFile(file, bytes);
  const split = await splitFile(file, 65536, path.join(tmp, 'split'));
  assert.equal(split.sha256, sha(bytes)); assert.equal(split.totalSize, bytes.length);
  assert.deepEqual(split.parts.map(p => p.size), [65536, 65536, 65536, 3392]);
  const joined = Buffer.concat(await Promise.all(split.parts.map(p => fs.readFile(p.path))));
  assert.ok(joined.equals(bytes));
  split.parts.forEach(p => assert.equal(p.sha256, sha(bytes.subarray(p.offset, p.offset + p.size))));
  assert.equal(split.parts[0].integrityManifest.blocks.length, 1);
  assert.equal(blockSizeFor(1500000000) % (512 * 1024), 0, 'blocks align with Telegram reads');
  assert.ok(1500000000 / blockSizeFor(1500000000) <= 256);
  assert.equal((await fs.readdir(path.join(tmp, 'split'))).some(f => f.endsWith('.tmp')), false);
});

// ---------- worker ----------

test('a full import validates, prepares, uploads, verifies and publishes Ready', skip, async () => {
  const { asset, job } = await newImport(fx.nonFaststart, { artifacts: { makeDefault: true } });
  const events = [];
  const [result] = await runOnce({ log: e => events.push(e) });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  const stored = await repo.getAsset(asset.id);
  assert.equal(stored.state, 'ready'); assert.equal(stored.isDefault, true);
  assert.equal(stored.faststart, true); assert.equal(stored.transcoded, false); assert.equal(stored.videoCodec, 'h264');
  assert.ok(stored.partCount > 1, 'multi-part'); assert.ok(stored.parts.every(p => p.state === 'verified'));
  // Telegram bytes reconstruct the exact prepared file.
  const bytes = await readStored(asset.id);
  assert.equal(sha(bytes), stored.sha256); assert.equal(bytes.length, stored.totalSize);
  assert.equal(adapter.messages.get(stored.parts[0].telegramMessageId).caption, buildCaption(stored, 1));
  assert.equal((await repo.getJob(job.id)).status, 'succeeded');
  assert.deepEqual(events.filter(e => e.event === 'stage').map(e => e.stage), ['validate', 'prepare', 'upload', 'verify', 'publish']);
  await assert.rejects(fs.stat(path.join(tmp, 'work', asset.id)), { code: 'ENOENT' }, 'work files are cleaned up');
  assert.equal((await repo.findReadyAsset({ imdbId: stored.imdbId })).id, asset.id);
});

test('invalid sources fail permanently with a safe reason and no retries', skip, async () => {
  for (const [source, code] of [[fx.mpeg4, 'VIDEO_NOT_BROWSER_COMPATIBLE'], [fx.corrupt, 'DECODE_FAILED'], [fx.audioOnly, 'NO_VIDEO_STREAM']]) {
    const { asset, job } = await newImport(source, { audio: source === fx.audioOnly ? [] : ['hi'] });
    const [result] = await runOnce();
    assert.equal(result.status, 'failed'); assert.equal(result.code, code);
    assert.equal((await repo.getAsset(asset.id)).failureReason, code);
    const stored = await repo.getJob(job.id);
    assert.equal(stored.status, 'failed'); assert.equal(stored.attempts, 1);
  }
  const { asset } = await newImport(fx.faststart, { audio: ['en'] });
  assert.equal((await runOnce())[0].code, 'AUDIO_LANGUAGE_MISMATCH');
  assert.equal((await repo.getAsset(asset.id)).state, 'failed');
});

test('an upload Telegram accepted before a crash is adopted on resume, not duplicated', skip, async () => {
  const { asset } = await newImport(fx.faststart);
  let uploads = 0;
  // Part 2's upload reaches Telegram, then the worker "crashes" before saving it.
  const flaky = { ...adapter, uploadPart: async args => { const ref = await adapter.uploadPart(args); if (++uploads === 2) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); return ref; } };
  const before = adapter.messages.size;
  const [first] = await runOnce({ adapter: flaky, uploadConcurrency: 1 });
  assert.equal(first.status, 'retry-scheduled');
  const failed = await repo.getAsset(asset.id);
  assert.equal(failed.state, 'failed'); assert.equal(failed.failureReason, 'TELEGRAM_OPERATION_FAILED');
  const [second] = await runOnce();
  assert.equal(second.status, 'succeeded', JSON.stringify(second));
  const stored = await repo.getAsset(asset.id);
  assert.equal(adapter.messages.size - before, stored.partCount, 'no duplicate message was uploaded');
  assert.equal(sha(await readStored(asset.id)), stored.sha256);
});

test('without a probe the part is re-uploaded and the possible stray copy is recorded', skip, async () => {
  const { asset, job } = await newImport(fx.faststart);
  let uploads = 0;
  const noProbe = { ...adapter, probeUploads: undefined };
  const flaky = { ...noProbe, uploadPart: async args => { const ref = await adapter.uploadPart(args); if (++uploads === 1) throw new Error('crash'); return ref; } };
  assert.equal((await runOnce({ adapter: flaky, uploadConcurrency: 1 }))[0].status, 'retry-scheduled');
  assert.equal((await runOnce({ adapter: noProbe }))[0].status, 'succeeded');
  const orphans = (await repo.getJob(job.id)).progress.possibleOrphans;
  assert.equal(orphans.length, 1); assert.equal(orphans[0].partNumber, 1);
  assert.equal(sha(await readStored(asset.id)), (await repo.getAsset(asset.id)).sha256);
});

test('a part whose read-back bytes are wrong is re-uploaded before Ready', skip, async () => {
  const { asset, job } = await newImport(fx.faststart);
  let corrupted = false;
  const lying = { ...adapter, readRange: async (ref, offset, length, opts) => {
    const bytes = await adapter.readRange(ref, offset, length, opts);
    if (!corrupted) { corrupted = true; bytes[0] ^= 0xff; }
    return bytes;
  } };
  const [result] = await runOnce({ adapter: lying });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  const progress = (await repo.getJob(job.id)).progress;
  assert.equal(progress.verifyRounds, 1);
  assert.equal(progress.possibleOrphans[0].reason, 'READBACK_MISMATCH');
  assert.equal(sha(await readStored(asset.id)), (await repo.getAsset(asset.id)).sha256);
});

test('a cancelled worker resumes later; missing part files are rebuilt from the prepared file', skip, async () => {
  const { asset } = await newImport(fx.nonFaststart, { artifacts: { keepArtifacts: true } });
  const stop = new AbortController();
  let uploads = 0;
  const slow = { ...adapter, uploadPart: async args => { const ref = await adapter.uploadPart(args); if (++uploads === 2) stop.abort(); return ref; } };
  const [first] = await runOnce({ adapter: slow, uploadConcurrency: 1, signal: stop.signal });
  assert.equal(first.status, 'retry-scheduled'); assert.equal(first.code, 'IMPORT_CANCELLED');
  assert.ok((await repo.listParts(asset.id)).some(p => p.state === 'pending'));
  assert.equal((await repo.findReadyVersions({ imdbId: (await repo.getAsset(asset.id)).imdbId })).length, 0, 'not playable yet');
  // Simulate lost temporary files between runs.
  await fs.rm(path.join(tmp, 'work', asset.id, 'parts'), { recursive: true, force: true });
  const [second] = await runOnce();
  assert.equal(second.status, 'succeeded', JSON.stringify(second));
  assert.equal(sha(await readStored(asset.id)), (await repo.getAsset(asset.id)).sha256);
});

test('a worker that loses its lease stops without touching the asset', skip, async () => {
  const { asset, job } = await newImport(fx.faststart);
  const stealing = { ...adapter, uploadPart: async args => {
    await db.query("UPDATE video_import_jobs SET lease_owner = 'other-worker' WHERE id = $1", [job.id]);
    return adapter.uploadPart(args);
  } };
  const [result] = await runOnce({ adapter: stealing });
  assert.equal(result.status, 'lease-lost');
  const stored = await repo.getAsset(asset.id);
  assert.equal(stored.state, 'uploading', 'the new owner decides what happens next');
  assert.equal((await repo.getJob(job.id)).leaseOwner, 'other-worker');
});

test('a series episode import is stored and found by season and episode', skip, async () => {
  const { asset } = await newImport(fx.faststart, { identity: { imdbId: 'tt8100001', contentType: 'episode', season: 2, episode: 5 } });
  assert.equal((await runOnce())[0].status, 'succeeded');
  const found = await repo.findReadyAsset({ imdbId: 'tt8100001', season: 2, episode: 5 });
  assert.equal(found.id, asset.id);
  assert.match(adapter.messages.get(found.parts[0].telegramMessageId).caption, /Type: Series\nIMDb ID: tt8100001\nTitle: Test Movie\nSeries release year: 2026\nSeason: 02\nEpisode: 05/);
});
