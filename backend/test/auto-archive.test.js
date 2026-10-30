// Auto-save to Telegram: duplicate checks, queue rules and the full
// download -> check -> import path (real FFmpeg, in-memory Telegram adapter).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const db = require('../src/config/db');
const repo = require('../src/services/videoStorageRepository');
const archiveRepo = require('../src/services/autoArchiveRepository');
const auto = require('../src/services/autoArchive');
const prep = require('../src/services/videoPrepare');
const { createMemoryAdapter } = require('../src/services/videoStorageAdapter');
const { runJob } = require('../src/services/videoImportWorker');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const hasFfmpeg = spawnSync(FFMPEG, ['-version'], { windowsHide: true }).status === 0;
const CHAT = '-1001234567890';
const WORKER = 'test-auto-worker';
let tmp, fixture, counter = 0;
const nextId = () => `tt70000${String(++counter).padStart(3, '0')}`;

before(async () => {
  await require('./connect-test-db.cjs')();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcrew-auto-'));
  if (!hasFfmpeg) return;
  fixture = path.join(tmp, 'source.mp4');
  const result = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1920x800:rate=25:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-metadata:s:a:0', 'language=hin', fixture], { windowsHide: true });
  if (result.status !== 0) throw new Error('fixture generation failed');
});
after(async () => {
  await db.close();
  await fs.rm(tmp, { recursive: true, force: true });
});
// Each test only claims its own request: everything older is pushed into the future.
beforeEach(async () => {
  await db.query("UPDATE auto_archive_requests SET next_run_at = now() + interval '1 day', status = 'queued' WHERE status IN ('queued','running')");
  await db.query("UPDATE auto_archive_requests SET download_started_at = NULL");
});

const settings = (extra = {}) => ({
  workDir: path.join(tmp, 'auto'), importWorkDir: path.join(tmp, 'import'), maxHeight: 1080, maxBytes: 8e9, maxAttempts: 3, leaseMs: 60000,
  storage: { importMaxAttempts: 3, jobLeaseMs: 60000, fetchConcurrency: 2, channelId: CHAT, partSize: 256 * 1024, uploadConcurrency: 1 },
  ...extra,
});
const info = (extra = {}) => ({ formatName: 'mov,mp4', durationSeconds: 100, size: 50e6, bitRate: 0, subtitles: 0,
  video: [{ codec: 'h264', pixelFormat: 'yuv420p', width: 1920, height: 1080 }], audio: [{ codec: 'aac', language: 'hi' }], ...extra });

// Fake tools: nothing touches the network or Telegram unless a test says so.
function fakeDeps(overrides = {}) {
  const calls = { download: 0, probe: 0, runJob: 0 };
  const deps = {
    calls,
    async *sourcesFor() { yield [{ link: 'https://cdn.example/movie.mp4', type: 'mp4', quality: '1080p', fromViewer: true, headers: {} }]; },
    proxyInput: candidate => candidate.link,
    probeSource: async () => { calls.probe++; return info(); },
    freeSpace: async () => 1e12,
    download: async (_input, output) => { calls.download++; await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, 'x'); return {}; },
    probeFile: async () => info(),
    titleInfo: async () => ({ title: 'Test film', releaseYear: 2024 }),
    adapter: () => createMemoryAdapter({ chatId: CHAT }),
    runJob: async job => { calls.runJob++; return { status: 'succeeded', job, asset: { id: job.assetId } }; },
    ...overrides,
  };
  return deps;
}
const ctxFor = (deps, extra = {}) => ({ settings: settings(extra.settings), deps, workerId: WORKER, port: 0, signal: new AbortController().signal,
  abort: () => {}, state: { progress: {} }, log: () => {} });

async function claimOne(identity, sourceToken = null) {
  await archiveRepo.request({ ...identity, sourceToken });
  const { request } = await archiveRepo.claim(WORKER, { leaseMs: 60000, dailyLimit: 100 });
  assert.ok(request, 'request should be claimable');
  assert.equal(request.imdbId, identity.imdbId);
  return request;
}
const rowOf = async id => archiveRepo.mapRequest((await db.query('SELECT * FROM auto_archive_requests WHERE id = $1', [id])).rows[0]);

// ---------- pure helpers ----------

test('quality labels come from the real frame size; wide films stay 1080p', () => {
  assert.equal(auto.qualityLabel(1920, 800), '1080p');
  assert.equal(auto.qualityLabel(1280, 720), '720p');
  assert.equal(auto.qualityLabel(3840, 2160), '2160p');
  assert.equal(auto.qualityLabel(854, 480), '480p');
  assert.equal(auto.labelRank('4K HDR'), 2160);
  assert.equal(auto.labelRank('Server 2 - 720p'), 720);
});

test('the viewer\'s stream is tried first, then the best sources within the cap', () => {
  const order = auto.orderCandidates([
    { link: 'a', quality: '480p' }, { link: 'b', quality: '2160p' }, { link: 'c', quality: '' },
    { link: 'd', quality: '1080p' }, { link: 'v', quality: '', fromViewer: true }, { link: 'd', quality: '1080p' },
  ], 1080).map(c => c.link);
  assert.deepEqual(order, ['v', 'd', 'a', 'c', 'b']);
});

test('languages and size estimates', () => {
  assert.deepEqual(auto.languagesOf({ audio: [{ language: 'hi' }, { language: 'en' }, { language: null }, { language: 'hi' }] }), ['en', 'hi']);
  assert.equal(auto.estimateBytes({ size: 123 }), 123);
  assert.equal(auto.estimateBytes({ size: 0, bitRate: 8e6, durationSeconds: 10 }), 1e7);
  assert.ok(auto.estimateBytes({ size: 0, bitRate: 0, durationSeconds: 7200 }) > 3e9);
});

// ---------- the duplicate check ----------

test('a title is queued once, however many times it is watched', async () => {
  const imdbId = nextId();
  const first = await archiveRepo.request({ imdbId, sourceToken: 'one' });
  const second = await archiveRepo.request({ imdbId, sourceToken: 'two' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  const rows = (await db.query('SELECT * FROM auto_archive_requests WHERE imdb_id = $1', [imdbId])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_token, 'two', 'a newer viewer token replaces the old one while queued');
  // Episodes of one show are separate titles.
  const show = nextId();
  await archiveRepo.request({ imdbId: show, season: 1, episode: 1 });
  await archiveRepo.request({ imdbId: show, season: 1, episode: 2 });
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM auto_archive_requests WHERE imdb_id = $1', [show])).rows[0].n), 2);
});

test('nothing is queued when the title is already stored or uploading (any quality)', async () => {
  const imdbId = nextId();
  await repo.createImport({ identity: { imdbId, contentType: 'movie' }, variant: { quality: '720p' }, idempotencyKey: 'manual-' + imdbId });
  const result = await archiveRepo.request({ imdbId });
  assert.deepEqual(result, { queued: false, reason: 'ALREADY_STORED' });
  assert.equal((await db.query('SELECT 1 FROM auto_archive_requests WHERE imdb_id = $1', [imdbId])).rows.length, 0);
});

test('a saved title whose copy later disappeared is queued again; skipped titles are not', async () => {
  const lost = nextId(), skipped = nextId();
  await archiveRepo.request({ imdbId: lost });
  await archiveRepo.request({ imdbId: skipped });
  await db.query("UPDATE auto_archive_requests SET status = 'done', attempts = 2 WHERE imdb_id = $1", [lost]);
  await db.query("UPDATE auto_archive_requests SET status = 'skipped', reason = 'ABOVE_MAX_QUALITY' WHERE imdb_id = $1", [skipped]);
  const again = await archiveRepo.request({ imdbId: lost });
  assert.equal(again.queued, true);
  assert.equal(again.request.attempts, 0);
  const still = await archiveRepo.request({ imdbId: skipped });
  assert.equal(still.queued, false);
  assert.equal(still.request.reason, 'ABOVE_MAX_QUALITY');
});

test('the daily limit stops new downloads but lets started uploads resume', async () => {
  const a = await claimOne({ imdbId: nextId() });
  await archiveRepo.markDownloadStarted(a.id, WORKER);
  await archiveRepo.reschedule(a.id, WORKER, { delayMs: 0 });
  await archiveRepo.request({ imdbId: nextId() });
  const limited = await archiveRepo.claim(WORKER, { dailyLimit: 1 });
  assert.equal(limited.limited, true);
  assert.equal(limited.request, null, 'no new download once the limit is reached');
  const assetRow = await repo.createImport({ identity: { imdbId: a.imdbId, contentType: 'movie' }, variant: { quality: '1080p' }, idempotencyKey: 'resume-' + a.id });
  await db.query('UPDATE auto_archive_requests SET asset_id = $2 WHERE id = $1', [a.id, assetRow.asset.id]);
  const resumed = await archiveRepo.claim(WORKER, { dailyLimit: 1 });
  assert.equal(resumed.request?.id, a.id, 'an upload that already downloaded can still finish');
});

test('a worker that stopped renewing its lease loses the request to the next one', async () => {
  const req = await claimOne({ imdbId: nextId() });
  await db.query("UPDATE auto_archive_requests SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [req.id]);
  const other = await archiveRepo.claim('other-worker', { dailyLimit: 100 });
  assert.equal(other.request.id, req.id);
  await assert.rejects(archiveRepo.finish(req.id, WORKER, 'done'), { code: 'AUTO_ARCHIVE_LEASE_LOST' });
});

// ---------- one request, start to finish (fake tools) ----------

test('success: download once, create the import with real quality and language, finish as done', async () => {
  const req = await claimOne({ imdbId: nextId() });
  const deps = fakeDeps();
  assert.equal(await auto.processRequest(req, ctxFor(deps)), 'done');
  const row = await rowOf(req.id);
  assert.equal(row.status, 'done');
  assert.ok(row.downloadStartedAt);
  assert.equal(row.sourceToken, null, 'the viewer token is dropped when done');
  const asset = await repo.getAsset(row.assetId, { withParts: false });
  assert.equal(asset.quality, '1080p');
  assert.deepEqual(asset.audioLanguages, ['hi']);
  assert.equal(asset.title, 'Test film');
  const job = await repo.getActiveJobForAsset(asset.id);
  assert.equal(job.status, 'running', 'the worker claimed exactly its own import job');
  assert.equal(job.artifacts.decodeMode, 'sample');
  assert.equal(deps.calls.download, 1);
  await assert.rejects(fs.stat(path.join(settings().workDir, req.id)), { code: 'ENOENT' }, 'download folder removed');
});

test('already stored by the time the worker runs: no download at all', async () => {
  const req = await claimOne({ imdbId: nextId() });
  await repo.createImport({ identity: { imdbId: req.imdbId, contentType: 'movie' }, variant: { quality: '480p' }, idempotencyKey: 'race-' + req.id });
  const deps = fakeDeps();
  assert.equal(await auto.processRequest(req, ctxFor(deps)), 'done');
  assert.equal(deps.calls.download, 0);
  assert.equal(deps.calls.probe, 0);
  assert.equal((await rowOf(req.id)).reason, 'ALREADY_STORED');
});

test('HEVC and 4K sources are skipped before downloading', async () => {
  const hevc = await claimOne({ imdbId: nextId() });
  const deps = fakeDeps({ probeSource: async () => info({ video: [{ codec: 'hevc', pixelFormat: 'yuv420p10le', width: 1920, height: 1080 }] }) });
  assert.equal(await auto.processRequest(hevc, ctxFor(deps)), 'skipped');
  assert.equal((await rowOf(hevc.id)).reason, 'VIDEO_NOT_BROWSER_COMPATIBLE');
  const uhd = await claimOne({ imdbId: nextId() });
  const deps4k = fakeDeps({ probeSource: async () => info({ video: [{ codec: 'h264', pixelFormat: 'yuv420p', width: 3840, height: 2160 }] }) });
  assert.equal(await auto.processRequest(uhd, ctxFor(deps4k)), 'skipped');
  assert.equal((await rowOf(uhd.id)).reason, 'ABOVE_MAX_QUALITY');
  assert.equal(deps.calls.download + deps4k.calls.download, 0);
});

test('a better source is used when the viewer\'s one is 4K', async () => {
  const req = await claimOne({ imdbId: nextId() });
  const deps = fakeDeps({
    async *sourcesFor() { yield [{ link: 'uhd', fromViewer: true }]; yield [{ link: 'hd', quality: '1080p' }]; },
    probeSource: async input => info(input === 'uhd' ? { video: [{ codec: 'h264', pixelFormat: 'yuv420p', width: 3840, height: 2160 }] } : {}),
    download: async (input, output) => { assert.equal(input, 'hd'); await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, 'x'); },
  });
  assert.equal(await auto.processRequest(req, ctxFor(deps)), 'done');
});

test('a cut-short download is retried later, not stored', async () => {
  const req = await claimOne({ imdbId: nextId() });
  const deps = fakeDeps({ probeFile: async () => info({ durationSeconds: 40 }) });
  assert.equal(await auto.processRequest(req, ctxFor(deps)), 'requeued');
  const row = await rowOf(req.id);
  assert.equal(row.status, 'queued');
  assert.equal(row.reason, 'DOWNLOAD_INCOMPLETE');
  assert.ok(new Date(row.nextRunAt) > new Date(Date.now() + 20 * 60000), 'waits before trying again');
  assert.equal(row.assetId, null);
  assert.equal(deps.calls.runJob, 0);
});

test('not enough disk: wait and retry; too many tries: failed for good', async () => {
  const req = await claimOne({ imdbId: nextId() });
  assert.equal(await auto.processRequest(req, ctxFor(fakeDeps({ freeSpace: async () => 1e6 }))), 'requeued');
  assert.equal((await rowOf(req.id)).reason, 'INSUFFICIENT_DISK_SPACE');
  await db.query("UPDATE auto_archive_requests SET next_run_at = now(), attempts = 2 WHERE id = $1", [req.id]);
  const again = (await archiveRepo.claim(WORKER, { dailyLimit: 100 })).request;
  assert.equal(again.attempts, 3);
  assert.equal(await auto.processRequest(again, ctxFor(fakeDeps({ freeSpace: async () => 1e6 }))), 'failed');
  assert.equal((await rowOf(req.id)).status, 'failed');
});

test('no source anywhere: tried again hours later', async () => {
  const req = await claimOne({ imdbId: nextId() });
  const deps = fakeDeps({ async *sourcesFor() { /* nothing */ } });
  assert.equal(await auto.processRequest(req, ctxFor(deps)), 'requeued');
  const row = await rowOf(req.id);
  assert.equal(row.reason, 'NO_SOURCE_FOUND');
  assert.ok(new Date(row.nextRunAt) > new Date(Date.now() + 5 * 3600000));
});

test('an upload interrupted by a restart resumes without downloading again', async () => {
  const req = await claimOne({ imdbId: nextId() });
  let first = true;
  const deps = fakeDeps({ runJob: async job => {
    if (first) { first = false; return { status: 'retry-scheduled', code: 'TELEGRAM_FLOOD_WAIT', job: { ...job, nextRunAt: new Date(Date.now() + 120000) } }; }
    return { status: 'succeeded', job, asset: { id: job.assetId } };
  } });
  assert.equal(await auto.processRequest(req, ctxFor(deps)), 'requeued');
  const waiting = await rowOf(req.id);
  assert.equal(waiting.status, 'queued');
  assert.ok(waiting.assetId);
  // The import job is put back in its queue (as the real worker would do).
  await db.query("UPDATE video_import_jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL WHERE asset_id = $1", [waiting.assetId]);
  await db.query('UPDATE auto_archive_requests SET next_run_at = now() WHERE id = $1', [req.id]);
  const resumed = (await archiveRepo.claim(WORKER, { dailyLimit: 100 })).request;
  assert.equal(await auto.processRequest(resumed, ctxFor(deps)), 'done');
  assert.equal(deps.calls.download, 1, 'downloaded only once');
});

// ---------- watched-time trigger ----------

test('only titles watched long enough are queued, and only once per viewer burst', async () => {
  const worker = auto._worker;
  const saved = { settings: worker.settings, running: worker.running };
  worker.settings = { enabled: true, minWatchSeconds: 300 };
  worker.running = true; // keep the background loop out of this test
  try {
    const imdbId = nextId();
    assert.equal(auto.noteWatched({ imdbId, playedSeconds: 120 }), false);
    assert.equal(auto.noteWatched({ imdbId, playedSeconds: 301, sourceToken: 't' }), true);
    assert.equal(auto.noteWatched({ imdbId, playedSeconds: 320, sourceToken: 't' }), false, 'later samples are ignored');
    for (let i = 0; i < 50 && !(await db.query('SELECT 1 FROM auto_archive_requests WHERE imdb_id = $1', [imdbId])).rows.length; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal((await db.query('SELECT 1 FROM auto_archive_requests WHERE imdb_id = $1', [imdbId])).rows.length, 1);
    worker.settings = { enabled: false, minWatchSeconds: 300 };
    assert.equal(auto.noteWatched({ imdbId: nextId(), playedSeconds: 9999 }), false, 'off means off');
  } finally { worker.settings = saved.settings; worker.running = saved.running; }
});

// ---------- the real thing: FFmpeg download + full import to Ready ----------

test('end to end: a watched source is downloaded, checked, uploaded and published Ready', { skip: !hasFfmpeg }, async () => {
  const req = await claimOne({ imdbId: nextId() });
  const memory = createMemoryAdapter({ chatId: CHAT });
  const deps = fakeDeps({
    async *sourcesFor() { yield [{ link: 'local', type: 'mp4', fromViewer: true }]; },
    proxyInput: () => fixture, // a local file stands in for the media proxy URL
    probeSource: auto.probeSource,
    download: auto.download,
    probeFile: (file, options) => prep.probe(file, options),
    adapter: () => memory,
    runJob,
  });
  assert.equal(await auto.processRequest(req, ctxFor(deps)), 'done');
  const row = await rowOf(req.id);
  const asset = await repo.getAsset(row.assetId);
  assert.equal(asset.state, 'ready');
  assert.equal(asset.quality, '1080p', '1920x800 is labelled 1080p');
  assert.deepEqual(asset.audioLanguages, ['hi']);
  assert.equal(asset.isDefault, true);
  assert.ok(asset.partCount >= 1 && asset.parts.every(p => p.state === 'verified'));
  assert.equal((await repo.findReadyVersions({ imdbId: req.imdbId }))[0].id, asset.id, 'playback now finds the stored copy');
  // The next viewer of this title triggers nothing new.
  assert.deepEqual(await archiveRepo.request({ imdbId: req.imdbId }), { queued: false, reason: 'ALREADY_STORED' });
});
