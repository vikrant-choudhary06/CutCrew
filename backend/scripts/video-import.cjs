// Operator CLI for Telegram video imports (telegramintegration.md, Phase 2).
// Not mounted in the API. Output is JSON lines with safe fields only.
//
//   npm run video:import -- import --file <path> --imdb tt1234567 --quality 1080p --audio hi,en
//        [--season 2 --episode 5] [--edition original] [--title "XYZ"] [--year 2026]
//        [--episode-year 2024] [--allow-transcode] [--decode sample] [--default] [--keep-artifacts] [--key <id>]
//   npm run video:import -- resume        Process any queued/interrupted imports
//   npm run video:import -- status [id]   List recent imports, or one asset with its parts
//   npm run video:import -- verify <id> [--deep]   Check every part in Telegram (--deep re-reads all bytes)
//   npm run video:import -- restore <id>  Put an unavailable asset back once its parts check out
//   npm run video:import -- retry <id>    Requeue a failed import, then run resume
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
// The CLI's queries are small: give up on a stalled database reply sooner and retry.
process.env.DB_QUERY_TIMEOUT_MS ||= '20000';
const db = require('../src/config/db');
const repo = require('../src/services/videoStorageRepository');
const { videoStorageConfig } = require('../src/config/videoStorage');
const { configuration } = require('../src/services/telegramStorage');
const { createTelegramAdapter } = require('../src/services/videoStorageAdapter');
const { runWorker } = require('../src/services/videoImportWorker');

// Prepared files and parts can be ~2x the movie size: keep them out of OneDrive.
const WORK_ROOT = process.env.VIDEO_WORK_DIR ? path.resolve(process.env.VIDEO_WORK_DIR) : require('../src/services/telegramStorage').localWorkDir('video-import');
const out = value => process.stdout.write(JSON.stringify(value) + '\n');

function parseArgs(argv) {
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const name = arg.slice(2);
    if (['allow-transcode', 'default', 'keep-artifacts', 'deep'].includes(name)) flags[name] = true;
    else { const value = argv[++i]; if (value === undefined) throw new Error(`--${name} needs a value`); flags[name] = value; }
  }
  return { flags, positional };
}
const optionalInt = (value, name) => {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`--${name} must be a whole number`);
  return Number(value);
};

function workerContext() {
  const settings = videoStorageConfig({ ...process.env, TELEGRAM_STORAGE_ENABLED: 'true' });
  const telegram = configuration();
  if (!telegram.ready || settings.errors.length) {
    throw Object.assign(new Error('TELEGRAM_CONFIGURATION_INCOMPLETE'), { safe: { missing: telegram.missing, invalid: [...new Set([...telegram.errors, ...settings.errors])] } });
  }
  return {
    workerId: `${os.hostname().slice(0, 40)}-${process.pid}-${randomUUID().slice(0, 8)}`,
    // Parallel download connections make read-back verification of large parts practical.
    adapter: createTelegramAdapter(telegram, { downloadSessions: settings.downloadSessions, downloadInflight: settings.downloadInflight }),
    verifyConcurrency: settings.fetchConcurrency,
    chatId: telegram.channelId,
    partSize: settings.partSize,
    uploadConcurrency: settings.uploadConcurrency,
    leaseMs: settings.jobLeaseMs,
    workRoot: WORK_ROOT,
    log: event => out(event),
  };
}

async function importCommand(flags) {
  if (!flags.file) throw new Error('--file is required');
  const file = path.resolve(flags.file);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) throw new Error('--file does not point to a readable file');
  const season = optionalInt(flags.season, 'season'), episode = optionalInt(flags.episode, 'episode');
  const identity = { imdbId: flags.imdb, contentType: season !== undefined || episode !== undefined ? 'episode' : 'movie', season, episode };
  const variant = { quality: flags.quality, edition: flags.edition || 'original', audioLanguages: (flags.audio || '').split(',').map(s => s.trim()).filter(Boolean) };
  repo.normalizeIdentity(identity); repo.normalizeVariant(variant);
  if (flags.decode && !['full', 'sample'].includes(flags.decode)) throw new Error('--decode must be full or sample');
  const settings = videoStorageConfig({ ...process.env, TELEGRAM_STORAGE_ENABLED: 'true' });
  // Same file + same target version => same key, so re-running resumes instead of duplicating.
  const idempotencyKey = flags.key || 'cli-' + createHash('sha256').update(JSON.stringify([file, stat.size, Math.floor(stat.mtimeMs), identity, variant])).digest('hex').slice(0, 40);
  const ctx = workerContext();
  const { asset, job, created } = await repo.createImport({
    identity, variant, idempotencyKey, title: flags.title, releaseYear: optionalInt(flags.year, 'year'),
    episodeReleaseYear: optionalInt(flags['episode-year'], 'episode-year'), maxAttempts: settings.importMaxAttempts,
    artifacts: { sourcePath: file, allowTranscode: Boolean(flags['allow-transcode']), decodeMode: flags.decode || 'full',
      makeDefault: Boolean(flags.default), keepArtifacts: Boolean(flags['keep-artifacts']) },
  });
  out({ event: created ? 'import-created' : 'import-exists', assetId: asset.id, jobId: job.id, state: asset.state, jobStatus: job.status });
  try {
    const results = await runWorker(ctx);
    for (const result of results) out({ event: 'job-result', jobId: result.jobId, assetId: result.assetId, status: result.status, code: result.code });
    const final = await repo.getAsset(asset.id, { withParts: false });
    const finalJob = await repo.getJob(job.id);
    out({ event: 'summary', assetId: asset.id, state: final.state, jobStatus: finalJob.status, nextRunAt: finalJob.status === 'queued' ? finalJob.nextRunAt : undefined, failureReason: final.failureReason });
    if (final.state !== 'ready') process.exitCode = 2;
  } finally { await ctx.adapter.close(); }
}

async function resumeCommand() {
  const ctx = workerContext();
  try {
    const results = await runWorker(ctx);
    for (const result of results) out({ event: 'job-result', jobId: result.jobId, assetId: result.assetId, status: result.status, code: result.code });
    if (!results.length) out({ event: 'nothing-due' });
  } finally { await ctx.adapter.close(); }
}

async function maintenanceCommand(command, id, flags) {
  if (!/^[0-9a-f-]{36}$/.test(id || '')) throw new Error('Give the asset (Upload) ID from status');
  const { verifyAsset, restoreAsset } = require('../src/services/storageMaintenance');
  const ctx = workerContext();
  try {
    const mode = flags.deep ? 'deep' : 'quick';
    const result = command === 'verify'
      ? await verifyAsset(id, { adapter: ctx.adapter, mode, concurrency: ctx.verifyConcurrency, log: e => out(e) })
      : await restoreAsset(id, { adapter: ctx.adapter, mode, concurrency: ctx.verifyConcurrency });
    out({ event: command + '-result', ...result });
    if (!result.ok) process.exitCode = 2;
  } finally { await ctx.adapter.close(); }
}

async function statusCommand(id) {
  if (id) {
    const asset = await repo.getAsset(id);
    if (!asset) throw new Error('No asset with that ID');
    const job = await repo.getActiveJobForAsset(id);
    out({ asset: { id: asset.id, imdbId: asset.imdbId, season: asset.season, episode: asset.episode, quality: asset.quality,
      edition: asset.edition, audio: asset.audioLanguages, state: asset.state, failureReason: asset.failureReason,
      totalSize: asset.totalSize, partCount: asset.partCount, isDefault: asset.isDefault, readyAt: asset.readyAt },
    job: job && { id: job.id, stage: job.stage, status: job.status, attempts: job.attempts, maxAttempts: job.maxAttempts,
      nextRunAt: job.nextRunAt, errorCategory: job.errorCategory, possibleOrphans: job.progress.possibleOrphans || [] },
    parts: asset.parts.map(p => ({ part: p.partNumber, size: p.size, state: p.state, messageLink: p.messageLink })) });
    return;
  }
  for (const asset of await repo.listAssets({ limit: 50 })) {
    out({ id: asset.id, imdbId: asset.imdbId, season: asset.season, episode: asset.episode, quality: asset.quality,
      audio: asset.audioLanguages, state: asset.state, failureReason: asset.failureReason, parts: asset.partCount });
  }
}

(async () => {
  const [command = 'status', ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);
  await db();
  try {
    if (command === 'import') await importCommand(flags);
    else if (command === 'resume') await resumeCommand();
    else if (command === 'status') await statusCommand(positional[0]);
    else if (command === 'verify' || command === 'restore') await maintenanceCommand(command, positional[0], flags);
    else if (command === 'retry') { const job = await repo.retryJob(positional[0]); out({ event: 'requeued', jobStatus: job.status, next: 'npm run video:import -- resume' }); }
    else throw new Error('Use import, resume, status, verify, restore or retry');
  } finally { await db.close(); }
})().catch(error => {
  // Only codes and names: never raw messages that could include secrets.
  const code = error.code || (/^[A-Z0-9_]+$/.test(error.message) ? error.message : null);
  out({ event: 'error', code: code || 'CLI_ERROR', message: code ? undefined : String(error.message).replace(/bot\d+:[\w-]+/g, 'bot[redacted]').slice(0, 200), ...(error.safe || {}) });
  process.exitCode = 1;
});
