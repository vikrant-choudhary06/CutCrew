// Telegram video storage — Phase 1 (schema, repository, config, adapter contract).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const db = require('../src/config/db');
const repo = require('../src/services/videoStorageRepository');
const adapterLib = require('../src/services/videoStorageAdapter');
const { videoStorageConfig, describe: describeConfig, redact } = require('../src/config/videoStorage');

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const CHAT = '-1001234567890';
const telegramEnv = {
  TELEGRAM_BOT_TOKEN: '123456789:' + 'x'.repeat(35), TELEGRAM_API_ID: '12345',
  TELEGRAM_API_HASH: 'a'.repeat(32), TELEGRAM_STORAGE_CHANNEL_ID: CHAT,
};
let tmp;
before(async () => {
  await require('./connect-test-db.cjs')();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcrew-video-'));
});
after(async () => {
  await db.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

let keyCounter = 0;
const sharedAdapter = adapterLib.createMemoryAdapter({ chatId: CHAT }); // one fake chat, like the real one
const key = () => `test-import-${++keyCounter}-${randomUUID()}`;
const movie = (imdbId = 'tt1234567') => ({ imdbId, contentType: 'movie' });
const variant = (extra = {}) => ({ quality: '1080p', audioLanguages: ['hi', 'en'], ...extra });

// Drives an asset to Ready through the real adapter contract: split, upload,
// read back, verify checksums, publish.
async function storeVideo({ identity = movie(), v = variant(), bytes = randomBytes(2500), partSize = 1000, adapter, makeDefault = false } = {}) {
  adapter ||= sharedAdapter;
  const { asset } = await repo.createImport({ identity, variant: v, idempotencyKey: key(), title: 'XYZ', releaseYear: 2026 });
  await repo.transitionAsset(asset.id, 'pending', 'validating');
  await repo.transitionAsset(asset.id, 'validating', 'preparing');
  const plan = repo.planParts(bytes.length, partSize);
  const slices = plan.map(p => bytes.subarray(p.offset, p.offset + p.size));
  const prepared = await repo.recordPreparedFile(asset.id, {
    totalSize: bytes.length, sha256: sha(bytes), partSize,
    parts: slices.map(slice => ({ sha256: sha(slice), size: slice.length })),
    media: { fileName: 'xyz.mp4', container: 'mp4', videoCodec: 'h264', durationSeconds: 60, faststart: true, transcoded: false },
  });
  await repo.transitionAsset(asset.id, 'preparing', 'uploading');
  for (const [index, part] of prepared.parts.entries()) {
    const file = path.join(tmp, `${asset.id}-${part.partNumber}.bin`);
    await fs.writeFile(file, slices[index]);
    const ref = await adapter.uploadPart({ filePath: file, caption: adapterLib.buildCaption(prepared, part.partNumber), expectedSize: part.size });
    await repo.recordPartUpload(asset.id, part.partNumber, ref);
  }
  await repo.transitionAsset(asset.id, 'uploading', 'verifying');
  const whole = createHash('sha256');
  for (const part of await repo.listParts(asset.id)) {
    const back = await adapter.readRange({ chatId: part.telegramChatId, messageId: part.telegramMessageId, documentId: part.mtprotoDocumentId, size: part.size }, 0, part.size);
    whole.update(back);
    await repo.markPartVerified(asset.id, part.partNumber, { sha256: sha(back) });
  }
  assert.equal(whole.digest('hex'), sha(bytes), 'reconstruction matches the prepared file');
  const published = await repo.publishReady(asset.id, { makeDefault });
  return { ...published, bytes, adapter };
}

// ---------- schema ----------

test('migrations are repeatable and create the storage tables', async () => {
  await db.migrate();
  await db.migrate();
  const tables = (await db.query(
    "SELECT table_name FROM information_schema.tables WHERE table_name IN ('video_assets','video_parts','video_import_jobs') ORDER BY 1")).rows.map(r => r.table_name);
  assert.deepEqual(tables, ['video_assets', 'video_import_jobs', 'video_parts']);
  const version = (await db.query('SELECT version FROM schema_migrations WHERE version = 5')).rows;
  assert.equal(version.length, 1);
});

test('exact split plan matches the documented 6,000,000,000 byte example', () => {
  const plan = repo.planParts(6000000000, 1500000000);
  assert.deepEqual(plan.map(p => [p.partNumber, p.offset, p.end, p.size]), [
    [1, 0, 1499999999, 1500000000], [2, 1500000000, 2999999999, 1500000000],
    [3, 3000000000, 4499999999, 1500000000], [4, 4500000000, 5999999999, 1500000000]]);
  assert.deepEqual(repo.planParts(10, 1500000000).map(p => p.size), [10]);
  assert.deepEqual(repo.planParts(6000000001, 1500000000).at(-1), { partNumber: 5, offset: 6000000000, size: 1, end: 6000000000 });
  assert.throws(() => repo.planParts(0, 10), /INVALID_SIZE/);
  assert.throws(() => repo.planParts(10, 1.5), /INVALID_SIZE/);
});

test('identity and variant validation rejects ambiguous movie/episode records', async () => {
  assert.throws(() => repo.normalizeIdentity({ imdbId: 'tt1234567', contentType: 'movie', season: 1, episode: 1 }), /INVALID_IDENTITY/);
  assert.throws(() => repo.normalizeIdentity({ imdbId: 'tt1234567', contentType: 'episode', season: 1 }), /INVALID_IDENTITY/);
  assert.throws(() => repo.normalizeIdentity({ imdbId: 'XYZ' }), /INVALID_IMDB_ID/);
  assert.deepEqual(repo.normalizeVariant({ quality: '1080P', audioLanguages: ['EN', 'hi', 'en'] }),
    { quality: '1080p', edition: 'original', audioLanguages: ['en', 'hi'] });
  assert.throws(() => repo.normalizeVariant({ quality: '1080p', audioLanguages: ['Hindi'] }), /INVALID_VARIANT/);
  // The schema enforces the same rule even if the repository is bypassed.
  await assert.rejects(db.query(
    "INSERT INTO video_assets (id, imdb_id, content_type, season, episode, quality) VALUES ($1,'tt1234567','movie',1,1,'1080p')", [randomUUID()]),
  { code: '23514' });
  await assert.rejects(db.query(
    "INSERT INTO video_assets (id, imdb_id, content_type, quality, state) VALUES ($1,'tt1234567','movie','1080p','ready')", [randomUUID()]),
  { code: '23514' });
});

test('imports are idempotent and duplicate in-progress variants are rejected', async () => {
  const idem = key();
  const first = await repo.createImport({ identity: movie('tt7000001'), variant: variant(), idempotencyKey: idem });
  const again = await repo.createImport({ identity: movie('tt7000001'), variant: variant(), idempotencyKey: idem });
  assert.equal(first.created, true); assert.equal(again.created, false);
  assert.equal(again.asset.id, first.asset.id); assert.equal(again.job.id, first.job.id);
  await assert.rejects(repo.createImport({ identity: movie('tt7000002'), variant: variant(), idempotencyKey: idem }), /IDEMPOTENCY_KEY_REUSED/);
  await assert.rejects(repo.createImport({ identity: movie('tt7000001'), variant: variant(), idempotencyKey: key() }), { code: '23505' });
  // A different language set is a different variant.
  await repo.createImport({ identity: movie('tt7000001'), variant: variant({ audioLanguages: ['en'] }), idempotencyKey: key() });
  assert.equal(first.asset.id.length, 36);
  // Concurrent submissions with one key create exactly one import.
  const raceKey = key();
  const results = await Promise.all([1, 2, 3].map(() => repo.createImport({ identity: movie('tt7000003'), variant: variant(), idempotencyKey: raceKey })));
  assert.equal(new Set(results.map(r => r.asset.id)).size, 1);
  assert.equal(results.filter(r => r.created).length, 1);
});

test('invalid transitions, offsets and layout changes are rejected by the database', async () => {
  const { asset } = await repo.createImport({ identity: movie('tt7000010'), variant: variant(), idempotencyKey: key() });
  await assert.rejects(repo.transitionAsset(asset.id, 'pending', 'ready'), { code: '23514' });
  await assert.rejects(repo.transitionAsset(asset.id, 'validating', 'preparing'), /STATE_CONFLICT/);
  await repo.transitionAsset(asset.id, 'pending', 'validating');
  await repo.transitionAsset(asset.id, 'validating', 'preparing');
  await assert.rejects(repo.recordPreparedFile(asset.id, { totalSize: 2500, sha256: 'a'.repeat(64), partSize: 1000, parts: [{ sha256: 'b'.repeat(64) }] }), /PART_PLAN_MISMATCH/);
  await assert.rejects(repo.recordPreparedFile(asset.id, { totalSize: 2500, sha256: 'a'.repeat(64), partSize: 1000,
    parts: [{ sha256: 'b'.repeat(64) }, { sha256: 'b'.repeat(64), size: 999 }, { sha256: 'b'.repeat(64) }] }), /PART_PLAN_MISMATCH/);
  await repo.recordPreparedFile(asset.id, { totalSize: 2500, sha256: 'a'.repeat(64), partSize: 1000, parts: Array(3).fill({ sha256: 'b'.repeat(64) }) });
  const parts = await repo.listParts(asset.id);
  assert.deepEqual(parts.map(p => [p.offset, p.size]), [[0, 1000], [1000, 1000], [2000, 500]]);
  // Offsets, sizes and extra parts that break the exact layout.
  await assert.rejects(db.query('DELETE FROM video_parts WHERE asset_id = $1 AND part_number = 3', [asset.id]).then(() =>
    db.query("INSERT INTO video_parts (asset_id, part_number, byte_offset, size, sha256) VALUES ($1, 3, 2001, 499, $2)", [asset.id, 'c'.repeat(64)])), { code: '23514' });
  await db.query("INSERT INTO video_parts (asset_id, part_number, byte_offset, size, sha256) VALUES ($1, 3, 2000, 500, $2)", [asset.id, 'c'.repeat(64)]);
  await assert.rejects(db.query("INSERT INTO video_parts (asset_id, part_number, byte_offset, size, sha256) VALUES ($1, 4, 3000, 1, $2)", [asset.id, 'c'.repeat(64)]), { code: '23514' });
  await assert.rejects(db.query("UPDATE video_parts SET size = 1 WHERE asset_id = $1 AND part_number = 1", [asset.id]), { code: '23514' });
  await assert.rejects(db.query('UPDATE video_assets SET total_size = 3000, part_count = 3 WHERE id = $1', [asset.id]), { code: '23514' });
  await assert.rejects(db.query("UPDATE video_assets SET quality = '720p' WHERE id = $1", [asset.id]), { code: '23514' });
});

test('Ready is refused until every part is uploaded and verified', async () => {
  const bytes = randomBytes(1500), adapter = sharedAdapter;
  const { asset } = await repo.createImport({ identity: movie('tt7000020'), variant: variant(), idempotencyKey: key() });
  await repo.transitionAsset(asset.id, 'pending', 'validating');
  await repo.transitionAsset(asset.id, 'validating', 'preparing');
  await repo.recordPreparedFile(asset.id, { totalSize: 1500, sha256: sha(bytes), partSize: 1000,
    parts: [{ sha256: sha(bytes.subarray(0, 1000)) }, { sha256: sha(bytes.subarray(1000)) }] });
  await repo.transitionAsset(asset.id, 'preparing', 'uploading');
  await assert.rejects(repo.transitionAsset(asset.id, 'uploading', 'ready'), { code: '23514' });
  const file = path.join(tmp, 'p1.bin'); await fs.writeFile(file, bytes.subarray(0, 1000));
  await repo.recordPartUpload(asset.id, 1, await adapter.uploadPart({ filePath: file, caption: 'x' }));
  await repo.transitionAsset(asset.id, 'uploading', 'verifying');
  await assert.rejects(repo.markPartVerified(asset.id, 1, { sha256: 'f'.repeat(64) }), /CHECKSUM_MISMATCH/);
  await repo.markPartVerified(asset.id, 1, { sha256: sha(bytes.subarray(0, 1000)) });
  await assert.rejects(repo.publishReady(asset.id), { code: '23514' }); // part 2 never uploaded
  await assert.rejects(db.query("UPDATE video_assets SET state = 'ready', ready_at = now() WHERE id = $1", [asset.id]), { code: '23514' });
  assert.equal((await repo.findReadyVersions({ imdbId: 'tt7000020' })).length, 0, 'partial uploads are never selectable');
  // One Telegram message can never back two parts.
  const first = (await repo.listParts(asset.id))[0];
  await repo.transitionAsset(asset.id, 'verifying', 'uploading');
  await assert.rejects(repo.recordPartUpload(asset.id, 2, { chatId: CHAT, messageId: first.telegramMessageId }), { code: '23505' });
});

test('a complete movie import publishes Ready and is found by IMDb ID', async () => {
  const { asset, bytes, adapter } = await storeVideo({ identity: movie('tt7000030'), makeDefault: true });
  assert.equal(asset.state, 'ready'); assert.equal(asset.isDefault, true); assert.ok(asset.readyAt);
  const found = await repo.findReadyAsset({ imdbId: 'tt7000030' });
  assert.equal(found.id, asset.id);
  assert.equal(found.parts.length, 3);
  assert.equal(found.parts.reduce((sum, p) => sum + p.size, 0), bytes.length);
  assert.match(found.parts[0].messageLink, /^https:\/\/t\.me\/c\/1234567890\/\d+$/);
  assert.equal(found.parts[0].telegramChatId, CHAT);
  // Captions follow the documented template.
  const caption = adapter.messages.get(found.parts[1].telegramMessageId).caption;
  assert.match(caption, /^Schema: cutcrew-video-v1\nType: Movie\nIMDb ID: tt7000030\nTitle: XYZ\nRelease year: 2026\nQuality: 1080p\nAudio: English, Hindi\nPart: 02\/03\nUpload ID: /);
  // Episodes of the same IMDb ID do not match movie lookups and vice versa.
  assert.equal(await repo.findReadyAsset({ imdbId: 'tt7000030', season: 1, episode: 1 }), null);
});

test('stored parts are immutable and cannot be deleted while the asset is ready', async () => {
  const { asset } = await storeVideo({ identity: movie('tt7000040') });
  await assert.rejects(db.query('UPDATE video_parts SET telegram_message_id = 999999 WHERE asset_id = $1 AND part_number = 1', [asset.id]), { code: '23514' });
  await assert.rejects(db.query("UPDATE video_parts SET state = 'pending' WHERE asset_id = $1", [asset.id]), { code: '23514' });
  await assert.rejects(db.query('DELETE FROM video_parts WHERE asset_id = $1 AND part_number = 2', [asset.id]), { code: '23514' });
  await repo.refreshPartReference(asset.id, 1, { botFileId: 'refreshed-id' });
  assert.equal((await repo.listParts(asset.id))[0].botFileId, 'refreshed-id');
});

test('episodes are matched by series ID, season and episode', async () => {
  await storeVideo({ identity: { imdbId: 'tt7000050', contentType: 'episode', season: 2, episode: 5 } });
  await storeVideo({ identity: { imdbId: 'tt7000050', contentType: 'episode', season: 2, episode: 6 } });
  const found = await repo.findReadyAsset({ imdbId: 'tt7000050', season: 2, episode: 5 });
  assert.equal(found.season, 2); assert.equal(found.episode, 5);
  assert.equal(await repo.findReadyAsset({ imdbId: 'tt7000050' }), null);
  assert.equal(await repo.findReadyAsset({ imdbId: 'tt7000050', season: 1, episode: 5 }), null);
  const caption = adapterLib.buildCaption({ ...found, partCount: 3, title: 'XYZ Series', releaseYear: 2024 }, 1);
  assert.match(caption, /Type: Series\nIMDb ID: tt7000050\nTitle: XYZ Series\nSeries release year: 2024\nSeason: 02\nEpisode: 05\n/);
});

test('version selection prefers requested quality/language, then default, then higher quality', async () => {
  await storeVideo({ identity: movie('tt7000060'), v: variant({ quality: '720p', audioLanguages: ['hi'] }) });
  await storeVideo({ identity: movie('tt7000060'), v: variant({ quality: '1080p', audioLanguages: ['en'] }) });
  const def = (await storeVideo({ identity: movie('tt7000060'), v: variant({ quality: '480p', audioLanguages: ['ta'] }), makeDefault: true })).asset;
  assert.equal((await repo.findReadyAsset({ imdbId: 'tt7000060' })).id, def.id);
  assert.equal((await repo.findReadyAsset({ imdbId: 'tt7000060', quality: '720p' })).quality, '720p');
  assert.deepEqual((await repo.findReadyAsset({ imdbId: 'tt7000060', audioLanguage: 'en' })).audioLanguages, ['en']);
  await repo.setDefault((await repo.findReadyAsset({ imdbId: 'tt7000060', quality: '1080p' })).id);
  assert.equal((await repo.findReadyAsset({ imdbId: 'tt7000060' })).quality, '1080p', 'only one default per title');
});

test('a verified replacement supersedes the old version atomically and keeps the default', async () => {
  const old = (await storeVideo({ identity: movie('tt7000070'), makeDefault: true })).asset;
  // While the replacement uploads, the old version keeps serving.
  const { asset: replacement, supersededId } = await storeVideo({ identity: movie('tt7000070') });
  assert.equal(supersededId, old.id);
  assert.equal((await repo.getAsset(old.id, { withParts: false })).state, 'superseded');
  const current = await repo.findReadyAsset({ imdbId: 'tt7000070' });
  assert.equal(current.id, replacement.id); assert.equal(current.isDefault, true);
  assert.equal((await repo.findReadyVersions({ imdbId: 'tt7000070' })).length, 1);
});

test('a confirmed missing part removes the asset from playback', async () => {
  const { asset } = await storeVideo({ identity: movie('tt7000080') });
  await repo.markPartMissing(asset.id, 2);
  assert.equal((await repo.getAsset(asset.id)).state, 'unavailable');
  assert.equal(await repo.findReadyAsset({ imdbId: 'tt7000080' }), null);
});

// ---------- jobs ----------

test('import jobs use leases, heartbeats, bounded retries and lease recovery', async () => {
  // Only this test's job should be due: push all others into the future.
  await db.query("UPDATE video_import_jobs SET next_run_at = now() + interval '1 day' WHERE status = 'queued'");
  const { asset, job } = await repo.createImport({ identity: movie('tt7000090'), variant: variant(), idempotencyKey: key(), maxAttempts: 2 });
  const claimed = await repo.claimJob('worker-a', { leaseMs: 60000 });
  assert.equal(claimed.id, job.id); assert.equal(claimed.attempts, 1); assert.equal(claimed.status, 'running');
  assert.equal(await repo.claimJob('worker-b'), null, 'a leased job is not claimed twice');
  await assert.rejects(repo.heartbeatJob(job.id, 'worker-b'), /LEASE_LOST/);
  await repo.advanceJob(job.id, 'worker-a', { stage: 'prepare', progress: { partsUploaded: 0 }, artifacts: { preparedFile: 'x.mp4' } });
  const retried = await repo.failJob(job.id, 'worker-a', { errorCategory: 'telegram wait', baseDelayMs: 0 });
  assert.equal(retried.status, 'queued'); assert.equal(retried.errorCategory, 'TELEGRAM_WAIT');
  assert.equal(retried.stage, 'prepare'); assert.deepEqual(retried.artifacts, { preparedFile: 'x.mp4' });
  // An expired lease (worker crash) is reclaimed by another worker.
  await repo.claimJob('worker-a');
  await db.query("UPDATE video_import_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [job.id]);
  const recovered = await repo.claimJob('worker-b');
  assert.equal(recovered.id, job.id); assert.equal(recovered.leaseOwner, 'worker-b'); assert.equal(recovered.attempts, 3);
  await assert.rejects(repo.completeJob(job.id, 'worker-a'), /LEASE_LOST/);
  const failed = await repo.failJob(job.id, 'worker-b', { errorCategory: 'BOT_API_REJECTED' });
  assert.equal(failed.status, 'failed', 'attempts are bounded');
  // A second active job for the same asset is rejected.
  await db.query("INSERT INTO video_import_jobs (id, asset_id, idempotency_key) VALUES ($1,$2,$3)", [randomUUID(), asset.id, key()]);
  await assert.rejects(db.query("INSERT INTO video_import_jobs (id, asset_id, idempotency_key) VALUES ($1,$2,$3)", [randomUUID(), asset.id, key()]), { code: '23505' });
});

// ---------- configuration ----------

test('storage is disabled by default and a misconfigured switch never enables it', () => {
  assert.equal(videoStorageConfig({}).enabled, false);
  assert.equal(videoStorageConfig({}).partSize, 1500000000);
  const noCreds = videoStorageConfig({ TELEGRAM_STORAGE_ENABLED: 'true' });
  assert.equal(noCreds.enabled, false); assert.ok(noCreds.missing.includes('TELEGRAM_BOT_TOKEN'));
  assert.equal(videoStorageConfig({ ...telegramEnv, TELEGRAM_STORAGE_ENABLED: 'true' }).enabled, true);
  assert.equal(videoStorageConfig({ ...telegramEnv, TELEGRAM_STORAGE_ENABLED: 'yes' }).enabled, false);
  for (const bad of ['1.5GB', '0', '99999999999', '-1']) {
    assert.ok(videoStorageConfig({ ...telegramEnv, TELEGRAM_STORAGE_ENABLED: 'true', VIDEO_PART_SIZE_BYTES: bad }).errors.includes('VIDEO_PART_SIZE_BYTES'));
  }
  const summary = JSON.stringify(describeConfig(videoStorageConfig({ ...telegramEnv, TELEGRAM_STORAGE_ENABLED: 'true' })));
  for (const secret of [telegramEnv.TELEGRAM_BOT_TOKEN, telegramEnv.TELEGRAM_API_HASH, CHAT]) assert.equal(summary.includes(secret), false);
  assert.equal(redact(`GET /bot${telegramEnv.TELEGRAM_BOT_TOKEN}/getMe hash=${telegramEnv.TELEGRAM_API_HASH}`, telegramEnv).includes('xxxxxxxx'), false);
});

test('existing provider playback does not load the storage integration', async () => {
  const sources = ['src/app.js', 'src/routes/index.js', 'src/routes/playMovie.js', 'server.js'];
  for (const file of sources) {
    const text = await fs.readFile(path.join(__dirname, '..', file), 'utf8');
    assert.equal(/videoStorage/.test(text), false, `${file} must not wire Telegram storage in Phase 1`);
  }
});

// ---------- adapter contract ----------

test('adapter contract is enforced and captions are bounded', async () => {
  assert.throws(() => adapterLib.assertStorageAdapter({ uploadPart() {} }), /STORAGE_ADAPTER_INVALID/);
  const asset = { id: randomUUID(), contentType: 'movie', imdbId: 'tt1234567', title: 'T'.repeat(5000), quality: '1080p', audioLanguages: [], partCount: 120 };
  const caption = adapterLib.buildCaption(asset, 7);
  assert.ok(caption.length <= adapterLib.CAPTION_LIMIT); assert.match(caption, /Part: 007\/120/);
  assert.throws(() => adapterLib.buildCaption(asset, 121), /INVALID_PART_NUMBER/);
  const memory = adapterLib.createMemoryAdapter({ chatId: CHAT });
  const file = path.join(tmp, 'contract.bin'); const bytes = randomBytes(5000); await fs.writeFile(file, bytes);
  const ref = await memory.uploadPart({ filePath: file, caption: 'c', expectedSize: 5000 });
  assert.deepEqual(await memory.readRange(ref, 4990, 10), bytes.subarray(4990));
  await assert.rejects(memory.readRange(ref, 4995, 10), /INVALID_RANGE/);
  await assert.rejects(memory.readRange(ref, 0, 10, { signal: AbortSignal.abort() }), /READ_CANCELLED/);
  await assert.rejects(memory.lookupMessage({ ...ref, chatId: '-1009999999999' }), /STORAGE_CHAT_MISMATCH/);
  memory.deleteMessage(ref.messageId);
  await assert.rejects(memory.lookupMessage(ref), /UPLOADED_MESSAGE_NOT_ACCESSIBLE/);
});

test('Telegram adapter maps Bot API uploads and MTProto reads without leaking credentials', async () => {
  const { configuration } = require('../src/services/telegramStorage');
  const config = configuration(telegramEnv);
  const bytes = randomBytes(3000), file = path.join(tmp, 'tg.bin'); await fs.writeFile(file, bytes);
  const calls = [];
  const botCall = async (_config, method, fields, document) => {
    calls.push({ method, fields, document });
    return { message_id: 77, chat: { id: Number(CHAT) }, document: { file_id: 'BQAC-file', file_unique_id: 'AgAD', file_size: 3000 } };
  };
  const doc = { id: { toString: () => '5550001' }, size: { toString: () => '3000' } };
  let connects = 0, refreshes = 0;
  const connect = async () => {
    connects++;
    return {
      message: async (id, expected) => {
        if (expected && expected.id !== '5550001') throw new Error('REFERENCED_FILE_CHANGED');
        return { id, document: doc };
      },
      reader: () => ({ read: async (offset, length) => bytes.subarray(offset, offset + length), refresh: async () => { refreshes++; } }),
      close: async () => {},
    };
  };
  const adapter = adapterLib.createTelegramAdapter(config, { botCall, connect });
  const ref = await adapter.uploadPart({ filePath: file, caption: 'Schema: cutcrew-video-v1', expectedSize: 3000 });
  assert.deepEqual(ref, { chatId: CHAT, messageId: 77, botFileId: 'BQAC-file', botFileUniqueId: 'AgAD', documentId: null, size: 3000 });
  assert.equal(calls[0].method, 'sendDocument'); assert.equal(calls[0].fields.chat_id, CHAT); assert.equal(calls[0].document, file);
  assert.equal(JSON.stringify(calls[0].fields).includes(telegramEnv.TELEGRAM_BOT_TOKEN), false);
  const looked = await adapter.lookupMessage({ chatId: CHAT, messageId: 77 });
  assert.deepEqual(looked, { chatId: CHAT, messageId: 77, documentId: '5550001', size: 3000 });
  assert.deepEqual(await adapter.readRange({ ...looked }, 100, 50), bytes.subarray(100, 150));
  await adapter.refreshReference(looked); assert.equal(refreshes, 1);
  assert.equal(connects, 1, 'one MTProto session is reused');
  await assert.rejects(adapter.readRange({ ...looked, chatId: '-1009999999999' }, 0, 1), /STORAGE_CHAT_MISMATCH/);
  await assert.rejects(adapter.readRange(looked, 0, adapterLib.MAX_READ_BYTES + 1), /INVALID_RANGE/);
  const wrongChat = adapterLib.createTelegramAdapter(config, { botCall: async () => ({ message_id: 1, chat: { id: -1009999999999 }, document: { file_id: 'x', file_size: 3000 } }), connect });
  await assert.rejects(wrongChat.uploadPart({ filePath: file, caption: 'c' }), /STORAGE_CHAT_MISMATCH/);
  assert.throws(() => adapterLib.createTelegramAdapter(configuration({})), /CONFIGURATION_INCOMPLETE/);
  await adapter.close();
});
