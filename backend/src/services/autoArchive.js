// Auto-save to Telegram. When a viewer has watched a provider stream for a few
// minutes, the title is queued (autoArchiveRepository). One background worker
// per server then, one title at a time:
//   1. checks the storage index again (already saved or uploading -> done)
//   2. picks a source: the stream the viewer watched first, then other sources
//   3. checks it before downloading: browser-playable video, <= max quality, size
//   4. downloads it with FFmpeg (stream copy, no re-encode) through the media proxy
//   5. confirms the whole film arrived, then hands the file to the normal
//      import pipeline (prepare -> split -> upload -> verify -> Ready)
// Playback never waits for any of this, and nothing is downloaded twice.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const archiveRepo = require('./autoArchiveRepository');
const prep = require('./videoPrepare');
const { lengthFits, runtimeOf } = require('./lengthCheck');

class ArchiveError extends Error {
  constructor(code, { retryable = false } = {}) { super(code); this.code = code; this.retryable = retryable; }
}

// Codes that mean "this title can't be stored as it is": skipped, not failed.
const SKIP_CODES = new Set(['VIDEO_NOT_BROWSER_COMPATIBLE', 'ABOVE_MAX_QUALITY', 'TOO_LARGE', 'NO_VIDEO_STREAM',
  'MULTIPLE_VIDEO_STREAMS', 'DURATION_UNKNOWN', 'TITLE_NOT_FOUND', 'INVALID_TITLE']);

function integer(env, key, fallback, min, max) {
  const value = Number(env[key]);
  return env[key] !== undefined && env[key] !== '' && Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

function settings(env = process.env) {
  const { videoStorageConfig } = require('../config/videoStorage');
  const storage = videoStorageConfig(env);
  const requested = String(env.AUTO_ARCHIVE_ENABLED || '').trim().toLowerCase() === 'true';
  return {
    requested,
    // Only runs when Telegram storage itself is fully configured and on.
    enabled: requested && storage.enabled,
    storage,
    minWatchSeconds: integer(env, 'AUTO_ARCHIVE_MIN_WATCH_SECONDS', 300, 30, 7200),
    dailyLimit: integer(env, 'AUTO_ARCHIVE_DAILY_LIMIT', 10, 1, 500),
    maxHeight: integer(env, 'AUTO_ARCHIVE_MAX_HEIGHT', 1080, 360, 2160),
    maxBytes: integer(env, 'AUTO_ARCHIVE_MAX_BYTES', 8 * 1000 ** 3, 100 * 1000 ** 2, 2000 * 1000 ** 3),
    maxAttempts: integer(env, 'AUTO_ARCHIVE_MAX_ATTEMPTS', 3, 1, 10),
    leaseMs: integer(env, 'AUTO_ARCHIVE_LEASE_MS', 10 * 60000, 60000, 3600000),
    workDir: env.AUTO_ARCHIVE_WORK_DIR ? path.resolve(env.AUTO_ARCHIVE_WORK_DIR) : require('./telegramStorage').localWorkDir('auto-archive'),
    importWorkDir: env.VIDEO_WORK_DIR ? path.resolve(env.VIDEO_WORK_DIR) : require('./telegramStorage').localWorkDir('video-import'),
  };
}

// ---------- small pure helpers (tested directly) ----------

// Label from the real frame size. Wide films (1920x800) are still 1080p.
function qualityLabel(width, height) {
  const size = Math.max(Number(height) || 0, Math.round((Number(width) || 0) * 9 / 16));
  if (size >= 2000) return '2160p';
  if (size >= 1300) return '1440p';
  if (size >= 1000) return '1080p';
  if (size >= 700) return '720p';
  if (size >= 460) return '480p';
  return '360p';
}

function labelRank(label) {
  const value = String(label || '').toLowerCase();
  if (/\b(4k|2160p?|uhd)\b/.test(value)) return 2160;
  const match = /(\d{3,4})p/.exec(value);
  return match ? Number(match[1]) : 0;
}

// Viewer's stream first; then the best-labelled sources not above the cap;
// unlabelled ones next; sources labelled above the cap last.
function orderCandidates(list, maxHeight) {
  const seen = new Set();
  const unique = list.filter(item => item?.link && !seen.has(item.link) && seen.add(item.link));
  const group = item => item.fromViewer ? 0 : labelRank(item.quality) > maxHeight ? 3 : labelRank(item.quality) ? 1 : 2;
  return unique.map((item, index) => ({ item, index }))
    .sort((a, b) => group(a.item) - group(b.item) || labelRank(b.item.quality) - labelRank(a.item.quality) || a.index - b.index)
    .map(entry => entry.item);
}

// Audio languages as stored in the index (ISO codes the schema accepts).
function languagesOf(info) {
  return [...new Set(info.audio.map(track => track.language).filter(lang => /^[a-z]{2,3}$/.test(lang || '')))].slice(0, 16).sort();
}

function estimateBytes(info) {
  if (info.size > 0) return info.size;
  if (info.bitRate > 0 && info.durationSeconds > 0) return Math.ceil(info.bitRate * info.durationSeconds / 8);
  // Unknown (some HLS sources): assume a typical 1080p rate of 4 Mbit/s.
  return Math.ceil((info.durationSeconds || 7200) * 4000000 / 8);
}

const fileNameFor = req => `${req.imdbId}${req.season != null ? `-s${req.season}e${req.episode}` : ''}.mkv`;

// ---------- media tools ----------

// Proxied HLS segments are URLs like /api/media?token=..., with no file
// extension. FFmpeg 7+ rejects those unless told not to; older builds (the
// Docker image ships 5.1) don't know that option, so ask FFmpeg once.
let hlsOptions;
function hlsInputOptions() {
  hlsOptions ||= prep.run(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-h', 'demuxer=hls'], { timeoutMs: 15000 })
    .then(result => ['-allowed_extensions', 'ALL', ...(/extension_picky/.test(result.stdout) ? ['-extension_picky', '0'] : [])])
    .catch(() => ['-allowed_extensions', 'ALL']);
  return hlsOptions;
}

// Reads a source through the media proxy without downloading it.
async function probeSource(input, { hls = false, signal } = {}) {
  const remote = /^https?:\/\//.test(input);
  const result = await prep.run(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', ...(remote ? ['-rw_timeout', '20000000'] : []), ...(hls ? await hlsInputOptions() : []),
    '-show_entries', 'format=format_name,duration,size,bit_rate:stream=index,codec_type,codec_name,pix_fmt,width,height,disposition:stream_tags=language',
    '-of', 'json', input], { timeoutMs: 90000, signal });
  if (result.code !== 0) throw new ArchiveError('SOURCE_UNREADABLE', { retryable: true });
  let data;
  try { data = JSON.parse(result.stdout); } catch { throw new ArchiveError('SOURCE_UNREADABLE', { retryable: true }); }
  const streams = data.streams || [];
  const duration = Number(data.format?.duration);
  return {
    formatName: data.format?.format_name || '',
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
    size: Number(data.format?.size) > 0 ? Number(data.format.size) : 0,
    bitRate: Number(data.format?.bit_rate) > 0 ? Number(data.format.bit_rate) : 0,
    video: streams.filter(s => s.codec_type === 'video' && !s.disposition?.attached_pic)
      .map(s => ({ index: s.index, codec: s.codec_name, pixelFormat: s.pix_fmt, width: s.width, height: s.height })),
    audio: streams.filter(s => s.codec_type === 'audio').map(s => ({ index: s.index, codec: s.codec_name, language: prep.normalizeLanguage(s.tags?.language) })),
    subtitles: 0,
  };
}

// Stream-copies the source into a local Matroska file. A stalled source is
// stopped instead of hanging; the caller checks the result is complete.
async function download(input, output, { hls = false, durationSeconds = null, signal, onProgress = () => {}, stallMs = 180000 } = {}) {
  const remote = /^https?:\/\//.test(input);
  const inputOptions = hls ? await hlsInputOptions()
    : remote ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '30'] : [];
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostdin', '-v', 'error', ...(remote ? ['-rw_timeout', '30000000'] : []), ...inputOptions,
      '-i', input, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-sn', '-dn',
      '-progress', 'pipe:2', '-stats_period', '5', '-f', 'matroska', '-y', output];
    let child;
    try { child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch { return reject(new ArchiveError('FFMPEG_UNAVAILABLE', { retryable: true })); }
    let settled = false, buffer = '', lastChange = Date.now(), seconds = 0, bytes = 0;
    const done = (error, value) => {
      if (settled) return; settled = true;
      clearInterval(watch); clearTimeout(limit); signal?.removeEventListener('abort', onAbort);
      error ? reject(error) : resolve(value);
    };
    const kill = code => { child.kill('SIGKILL'); done(new ArchiveError(code, { retryable: true })); };
    const onAbort = () => kill('AUTO_ARCHIVE_CANCELLED');
    signal?.addEventListener('abort', onAbort, { once: true });
    const watch = setInterval(() => { if (Date.now() - lastChange > stallMs) kill('DOWNLOAD_STALLED'); }, 10000);
    const limit = setTimeout(() => kill('DOWNLOAD_TIMEOUT'), Math.max(2 * 3600000, (durationSeconds || 7200) * 3000));
    child.stderr.on('data', chunk => {
      buffer = (buffer + chunk).slice(-16384);
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        const [key, value] = line.trim().split('=');
        const number = Number(value);
        if (!Number.isFinite(number)) continue;
        if (key === 'out_time_us' && number / 1e6 > seconds) { seconds = number / 1e6; lastChange = Date.now(); }
        if (key === 'total_size' && number > bytes) { bytes = number; lastChange = Date.now(); }
        if (key === 'out_time_us' || key === 'total_size') onProgress({ seconds: Math.round(seconds), bytes });
      }
    });
    child.on('error', error => done(new ArchiveError(error.code === 'ENOENT' ? 'FFMPEG_UNAVAILABLE' : 'DOWNLOAD_FAILED', { retryable: true })));
    child.on('close', code => code === 0 ? done(null, { seconds, bytes }) : done(new ArchiveError('DOWNLOAD_FAILED', { retryable: true })));
  });
}

async function freeSpace(directory) {
  const disk = await fs.statfs(directory);
  return disk.bavail * disk.bsize;
}

// ---------- sources ----------

const typeOfFormat = format => format === 'hls' ? 'hls' : format === 'mkv' ? 'mkv' : 'mp4';

// Yields candidate sources lazily: the viewer's stream needs no provider
// lookup, and providers are only asked when it can't be used.
async function* sourcesFor(req, { maxHeight }) {
  const media = require('./mediaService');
  if (req.sourceToken) {
    try {
      const ticket = media.verifyToken(req.sourceToken);
      yield [{ link: ticket.url, headers: ticket.headers || {}, type: typeOfFormat(ticket.format), quality: '', fromViewer: true }];
    } catch { /* expired: fall through to providers */ }
  }
  const { ensureMovie, isSeries } = require('./movieService');
  const { resolvePlayback, normalizeStreams, episodeFor } = require('./providerService');
  let movie;
  try { movie = await ensureMovie(req.imdbId); } catch { throw new ArchiveError('TITLE_NOT_FOUND'); }
  const series = isSeries(movie);
  if (series !== (req.season != null)) throw new ArchiveError('INVALID_TITLE');
  const target = series ? episodeFor(movie, req.season, req.episode) : movie;
  const fresh = target?.stream_fetched_at && Date.now() - new Date(target.stream_fetched_at).getTime() < 3 * 3600000;
  const cached = fresh ? normalizeStreams(target.stream_data) : [];
  if (cached.length) yield orderCandidates(cached, maxHeight);
  const result = await resolvePlayback(movie.toObject(), { season: req.season ?? undefined, episode: req.episode ?? undefined, rediscover: cached.length > 0 })
    .catch(() => null);
  if (result?.streams?.length) yield orderCandidates(normalizeStreams(result.streams), maxHeight);
}

// The media proxy handles provider headers, redirects, HLS playlists and
// blocks private addresses, so FFmpeg only ever talks to this server.
function proxyInput(candidate, port) {
  const { signMedia } = require('./mediaService');
  const format = candidate.type === 'hls' ? 'hls' : '';
  return `http://127.0.0.1:${port}${signMedia(candidate.link, candidate.headers, format, Date.now() + 12 * 3600000)}`;
}

// First source that is browser-playable, within the quality cap and size limit.
async function chooseSource(req, ctx) {
  const { settings: s, deps, signal } = ctx;
  const tried = new Set(), problems = new Set();
  // The title's listed length: a file far shorter or longer is something else
  // with the same name (a song, a trailer, another film).
  let runtimeMinutes = null;
  try { runtimeMinutes = deps.runtimeOf ? await deps.runtimeOf(req) : null; } catch { /* unknown length */ }
  const length = { episode: req.season != null, runtimeMinutes };
  let probes = 0;
  for await (const batch of deps.sourcesFor(req, s)) {
    for (const candidate of batch) {
      if (tried.has(candidate.link) || probes >= 6) continue;
      tried.add(candidate.link); probes++;
      const hls = candidate.type === 'hls';
      const input = deps.proxyInput(candidate, ctx.port);
      let info;
      try { info = await deps.probeSource(input, { hls, signal }); }
      catch (error) { if (signal?.aborted) throw error; problems.add('SOURCE_UNREADABLE'); continue; }
      try { prep.planPreparation(info); }
      catch (error) { problems.add(error.code || 'VIDEO_NOT_BROWSER_COMPATIBLE'); continue; }
      if (!lengthFits(info.durationSeconds, length)) { problems.add('LENGTH_MISMATCH'); continue; }
      const video = info.video[0];
      if (labelRank(qualityLabel(video.width, video.height)) > s.maxHeight) { problems.add('ABOVE_MAX_QUALITY'); continue; }
      const bytes = estimateBytes(info);
      if (bytes > s.maxBytes) { problems.add('TOO_LARGE'); continue; }
      return { candidate, input, hls, info, bytes };
    }
  }
  // Only "can't be stored" reasons -> skip for good. Otherwise sources may come back later.
  const reasons = [...problems];
  if (reasons.length && reasons.every(code => SKIP_CODES.has(code))) throw new ArchiveError(reasons[0]);
  throw new ArchiveError(probes ? 'NO_PLAYABLE_SOURCE' : 'NO_SOURCE_FOUND', { retryable: true });
}

// ---------- one request ----------

async function cleanupDir(dir) { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }

function importContext(ctx) {
  const s = ctx.settings.storage;
  return {
    workerId: ctx.workerId,
    adapter: ctx.deps.adapter(),
    verifyConcurrency: s.fetchConcurrency,
    chatId: s.channelId,
    partSize: s.partSize,
    uploadConcurrency: s.uploadConcurrency,
    leaseMs: s.jobLeaseMs,
    workRoot: ctx.settings.importWorkDir,
    signal: ctx.signal,
    log: event => ctx.log({ ...event, source: 'auto-archive' }),
  };
}

// Runs (or resumes) the import job this request created.
async function runImport(req, jobId, ctx) {
  const vrepo = require('./videoStorageRepository');
  const job = await vrepo.claimJobById(jobId, ctx.workerId, { leaseMs: ctx.settings.storage.jobLeaseMs });
  if (!job) {
    // Someone else (e.g. the import CLI) holds it right now: check back later.
    await archiveRepo.reschedule(req.id, ctx.workerId, { delayMs: 10 * 60000, reason: 'IMPORT_BUSY' });
    return 'requeued';
  }
  ctx.state.phase = 'uploading';
  const result = await ctx.deps.runJob(job, importContext(ctx));
  if (result.status === 'succeeded') {
    await archiveRepo.finish(req.id, ctx.workerId, 'done');
    await cleanupDir(path.join(ctx.settings.workDir, req.id));
    ctx.log({ event: 'auto-archive-done', imdbId: req.imdbId, season: req.season, episode: req.episode, assetId: result.asset?.id });
    return 'done';
  }
  if (result.status === 'retry-scheduled' || result.status === 'lease-lost') {
    const at = result.job?.nextRunAt ? new Date(result.job.nextRunAt).getTime() : Date.now() + 5 * 60000;
    await archiveRepo.reschedule(req.id, ctx.workerId, { delayMs: Math.max(60000, at - Date.now()), reason: result.code });
    return 'requeued';
  }
  // The import gave up: decide at the request level (retry from a fresh download, or stop).
  throw new ArchiveError(result.code || 'IMPORT_FAILED', { retryable: !SKIP_CODES.has(result.code), fromImport: true });
}

async function processRequest(req, ctx) {
  const vrepo = require('./videoStorageRepository');
  const { settings: s, deps } = ctx;
  const dir = path.join(s.workDir, req.id);
  const file = path.join(dir, fileNameFor(req));
  ctx.state.current = { id: req.id, imdbId: req.imdbId, season: req.season, episode: req.episode, startedAt: new Date().toISOString() };
  ctx.state.phase = 'checking';
  const beat = setInterval(() => {
    archiveRepo.heartbeat(req.id, ctx.workerId, { leaseMs: s.leaseMs, progress: { phase: ctx.state.phase, ...ctx.state.progress } })
      .catch(error => { if (error.code === 'AUTO_ARCHIVE_LEASE_LOST') ctx.abort?.(); });
  }, Math.max(5000, Math.floor(s.leaseMs / 4)));
  beat.unref?.();
  try {
    // Resume: an import was already created for this request.
    if (req.assetId) {
      const asset = await vrepo.getAsset(req.assetId, { withParts: false });
      if (asset?.state === 'ready') { await archiveRepo.finish(req.id, ctx.workerId, 'done'); await cleanupDir(dir); return 'done'; }
      const job = asset && await vrepo.getActiveJobForAsset(asset.id);
      if (job && ['queued', 'running'].includes(job.status)) return await runImport(req, job.id, ctx);
      await archiveRepo.setAsset(req.id, ctx.workerId, null);
    }

    // The duplicate check, again right before spending bandwidth.
    if (await archiveRepo.isStored(req)) {
      await archiveRepo.finish(req.id, ctx.workerId, 'done', 'ALREADY_STORED');
      await cleanupDir(dir);
      return 'done';
    }

    const picked = await chooseSource(req, ctx);
    // Which provider the file comes from, so a wrong file can be traced.
    ctx.log({ event: 'auto-archive-source', imdbId: req.imdbId, season: req.season, episode: req.episode,
      provider: picked.candidate.fromViewer ? 'viewer' : String(picked.candidate.provider || 'unknown').slice(0, 40),
      seconds: Math.round(picked.info.durationSeconds || 0) });
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // Download + prepared copy + parts can reach ~3x the film; keep 1 GB spare.
    if (await deps.freeSpace(dir) < picked.bytes * 3.2 + 1024 ** 3) throw new ArchiveError('INSUFFICIENT_DISK_SPACE', { retryable: true });

    await archiveRepo.markDownloadStarted(req.id, ctx.workerId);
    ctx.state.phase = 'downloading';
    ctx.state.progress = { expectedSeconds: Math.round(picked.info.durationSeconds || 0), estimatedBytes: picked.bytes };
    const partial = file + '.partial';
    await deps.download(picked.input, partial, { hls: picked.hls, durationSeconds: picked.info.durationSeconds, signal: ctx.signal,
      onProgress: p => { ctx.state.progress = { ...ctx.state.progress, downloadedSeconds: p.seconds, downloadedBytes: p.bytes }; } });
    await fs.rename(partial, file);

    // A dropped connection can end FFmpeg "successfully" with half a film.
    ctx.state.phase = 'checking-download';
    const info = await deps.probeFile(file, { signal: ctx.signal });
    if (picked.info.durationSeconds && (!info.durationSeconds || info.durationSeconds < picked.info.durationSeconds * 0.97)) {
      throw new ArchiveError('DOWNLOAD_INCOMPLETE', { retryable: true });
    }
    prep.planPreparation(info);
    const video = info.video[0];
    const title = await deps.titleInfo(req.imdbId).catch(() => ({}));
    const identity = req.season != null ? { imdbId: req.imdbId, contentType: 'episode', season: req.season, episode: req.episode } : { imdbId: req.imdbId, contentType: 'movie' };
    if (await archiveRepo.isStored(req)) { await archiveRepo.finish(req.id, ctx.workerId, 'done', 'ALREADY_STORED'); await cleanupDir(dir); return 'done'; }
    let created;
    try {
      created = await vrepo.createImport({
        identity, variant: { quality: qualityLabel(video.width, video.height), edition: 'original', audioLanguages: languagesOf(info) },
        idempotencyKey: `auto-${req.id}-${req.attempts}`, title: title.title || undefined, releaseYear: title.releaseYear || undefined,
        maxAttempts: s.storage.importMaxAttempts,
        // Sample decode: the download was already read end to end by FFmpeg.
        artifacts: { sourcePath: file, allowTranscode: false, decodeMode: 'sample', makeDefault: true, autoArchive: true },
      });
    } catch (error) {
      // Another import of the same version started meanwhile.
      if (error.code === '23505') { await archiveRepo.finish(req.id, ctx.workerId, 'done', 'ALREADY_STORED'); await cleanupDir(dir); return 'done'; }
      throw error;
    }
    await archiveRepo.setAsset(req.id, ctx.workerId, created.asset.id);
    return await runImport(req, created.job.id, ctx);
  } catch (error) {
    return handleFailure(req, error, ctx, dir);
  } finally {
    clearInterval(beat);
    ctx.state.current = null; ctx.state.phase = 'idle'; ctx.state.progress = {};
  }
}

async function handleFailure(req, error, ctx, dir) {
  if (error?.code === 'AUTO_ARCHIVE_LEASE_LOST') return 'lease-lost';
  const { classify } = require('./videoImportWorker');
  const known = error instanceof ArchiveError || error instanceof prep.PrepareError;
  const failure = known ? { code: error.code, retryable: Boolean(error.retryable) } : classify(error);
  ctx.log({ event: 'auto-archive-failed', imdbId: req.imdbId, season: req.season, episode: req.episode, code: failure.code, retryable: failure.retryable });
  try {
    if (failure.code === 'AUTO_ARCHIVE_CANCELLED') {
      // Server shutting down: hand it back untouched (the download restarts later).
      await archiveRepo.reschedule(req.id, ctx.workerId, { delayMs: 60000, reason: failure.code });
      return 'requeued';
    }
    if (!failure.retryable || SKIP_CODES.has(failure.code) || req.attempts >= ctx.settings.maxAttempts) {
      await archiveRepo.finish(req.id, ctx.workerId, SKIP_CODES.has(failure.code) ? 'skipped' : 'failed', failure.code);
      await cleanupDir(dir);
      return SKIP_CODES.has(failure.code) ? 'skipped' : 'failed';
    }
    // 30 min, 1 h, 2 h ... (sources often come back); a missing source waits longer.
    const base = ['NO_SOURCE_FOUND', 'NO_PLAYABLE_SOURCE'].includes(failure.code) ? 6 * 3600000 : 30 * 60000;
    await archiveRepo.reschedule(req.id, ctx.workerId, { delayMs: Math.min(24 * 3600000, base * 2 ** Math.max(0, req.attempts - 1)), reason: failure.code, clearAsset: true });
    await cleanupDir(dir);
    return 'requeued';
  } catch (inner) {
    if (inner?.code === 'AUTO_ARCHIVE_LEASE_LOST') return 'lease-lost';
    throw inner;
  }
}

// ---------- the worker ----------

const defaultDeps = {
  sourcesFor,
  proxyInput,
  probeSource,
  download,
  freeSpace,
  probeFile: (file, options) => prep.probe(file, options),
  runtimeOf: async req => {
    const { ensureMovie } = require('./movieService');
    const { episodeFor } = require('./providerService');
    const movie = await ensureMovie(req.imdbId);
    return runtimeOf(movie, req.season != null ? episodeFor(movie, req.season, req.episode) : null);
  },
  titleInfo: async imdbId => {
    const { ensureMovie } = require('./movieService');
    const movie = await ensureMovie(imdbId);
    return { title: movie.title, releaseYear: movie.release_year };
  },
  adapter: () => require('./storedMediaRuntime').getAdapter(),
  runJob: (job, ctx) => require('./videoImportWorker').runJob(job, ctx),
};

const worker = {
  settings: null, timer: null, running: false, port: null, controller: null, log: () => {},
  workerId: `${os.hostname().slice(0, 40)}-${process.pid}-auto-${randomUUID().slice(0, 8)}`,
  state: { current: null, phase: 'idle', progress: {}, limited: false, lastRunAt: null },
  recent: new Map(),
};

async function tick(deps = defaultDeps) {
  if (worker.running || !worker.settings?.enabled) return;
  worker.running = true;
  try {
    while (!worker.controller?.signal.aborted) {
      const { request: req, limited } = await archiveRepo.claim(worker.workerId, { leaseMs: worker.settings.leaseMs, dailyLimit: worker.settings.dailyLimit });
      worker.state.limited = limited;
      if (!req) break;
      const abort = new AbortController();
      const signal = AbortSignal.any([worker.controller.signal, abort.signal]);
      await processRequest(req, { settings: worker.settings, deps, workerId: worker.workerId, port: worker.port,
        signal, abort: () => abort.abort(), state: worker.state, log: worker.log });
    }
  } catch (error) {
    // Usually a dropped database connection; the next tick (1 min) tries again.
    worker.log({ event: 'auto-archive-worker-error', code: require('./videoImportWorker').classify(error).code || 'WORKER_ERROR' });
  } finally {
    worker.running = false;
    worker.state.lastRunAt = new Date().toISOString();
  }
}

function start({ port, log = event => console.log(JSON.stringify(event)), env = process.env, intervalMs = 60000 } = {}) {
  worker.settings = settings(env);
  if (!worker.settings.enabled) return false;
  worker.port = port; worker.log = log;
  worker.controller = new AbortController();
  worker.timer = setInterval(() => tick(), intervalMs);
  worker.timer.unref?.();
  setTimeout(() => tick(), 5000).unref?.();
  log({ event: 'auto-archive-started', dailyLimit: worker.settings.dailyLimit, minWatchSeconds: worker.settings.minWatchSeconds, maxHeight: worker.settings.maxHeight });
  return true;
}

function stop() {
  clearInterval(worker.timer); worker.timer = null;
  worker.controller?.abort();
}

// Called for every provider playback sample. Cheap until the threshold is
// crossed; then the title is queued once (the database ignores repeats).
function noteWatched({ imdbId, season = null, episode = null, playedSeconds, sourceToken }) {
  const s = worker.settings;
  if (!s?.enabled || !(playedSeconds >= s.minWatchSeconds)) return false;
  const key = `${imdbId}:${season ?? ''}:${episode ?? ''}`;
  const now = Date.now();
  if (now - (worker.recent.get(key) || 0) < 30 * 60000) return false;
  worker.recent.set(key, now);
  if (worker.recent.size > 5000) for (const [k, at] of worker.recent) if (now - at > 30 * 60000) worker.recent.delete(k);
  archiveRepo.request({ imdbId, season, episode, sourceToken })
    .then(result => { if (result.created || result.queued) setImmediate(() => tick()); })
    .catch(error => { worker.recent.delete(key); worker.log({ event: 'auto-archive-request-failed', code: error.code || 'REQUEST_FAILED' }); });
  return true;
}

function status() {
  const s = worker.settings || settings();
  return {
    enabled: s.enabled, requested: s.requested, minWatchSeconds: s.minWatchSeconds, dailyLimit: s.dailyLimit,
    maxHeight: s.maxHeight, maxBytes: s.maxBytes, running: worker.running, phase: worker.state.phase,
    current: worker.state.current, progress: worker.state.progress, dailyLimitReached: worker.state.limited, lastRunAt: worker.state.lastRunAt,
  };
}

module.exports = {
  settings, start, stop, tick, noteWatched, status, processRequest, chooseSource,
  qualityLabel, labelRank, orderCandidates, languagesOf, estimateBytes, download, probeSource, proxyInput,
  ArchiveError, SKIP_CODES, _worker: worker,
};
