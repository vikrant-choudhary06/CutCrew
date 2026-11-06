// Telegram storage Phase 2: resumable import worker (telegramintegration.md
// §5–§9). Each job moves through validate → prepare → upload → verify →
// publish. Every step is recorded in PostgreSQL, so a restarted worker
// continues where the last one stopped and never publishes an incomplete asset.
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const repo = require('./videoStorageRepository');
const prep = require('./videoPrepare');
const { splitFile, hashFile, partFileName } = require('./videoSplit');
const { buildCaption, assertStorageAdapter } = require('./videoStorageAdapter');
const { readOrdered } = require('./storageRead');
const { safeFailure } = require('./telegramStorage');

const STAGE_STATE = { validate: 'validating', prepare: 'preparing', upload: 'uploading', verify: 'verifying', publish: 'verifying' };
const MAX_VERIFY_ROUNDS = 3;
const DEFAULT_PROBE_WINDOW = 200;

class ImportError extends Error {
  constructor(code, { retryable = false } = {}) { super(code); this.code = code; this.retryable = retryable; }
}

// Safe category + retry decision for any failure. Messages are never stored.
function classify(error) {
  if (error instanceof prep.PrepareError || error instanceof ImportError) return { code: error.code, retryable: error.retryable };
  if (error?.code === 'LEASE_LOST') return { code: 'LEASE_LOST', retryable: true, leaseLost: true };
  if (['INSUFFICIENT_DISK_SPACE', 'SOURCE_CHANGED_DURING_SPLIT', 'SPLIT_CANCELLED', 'HASH_CANCELLED'].includes(error?.code)) return { code: error.code, retryable: true };
  if (error instanceof repo.VideoStorageError) return { code: error.code, retryable: false };
  if (error?.code === 'ENOENT') return { code: 'LOCAL_FILE_MISSING', retryable: true };
  // PostgreSQL / pooler problems (dropped connection, query timeout) are not Telegram failures.
  if (error?.severity || /^(08|57|53)/.test(String(error?.code || '')) ||
      /Connection terminated|Query read timeout|connection error|not queryable|timeout exceeded when trying to connect/i.test(error?.message || '')) {
    return { code: 'DATABASE_UNAVAILABLE', retryable: true };
  }
  const safe = safeFailure(error || {});
  return { code: safe.code, retryable: true, retryAfterMs: (safe.retryAfterSeconds || 0) * 1000 };
}

async function sourceFingerprint(file) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) throw new ImportError('SOURCE_NOT_FOUND');
  return { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) };
}

// Bounded parallel map that stops starting new work after the first error.
async function pool(items, limit, work) {
  let next = 0, failed;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try { await work(item); } catch (error) { failed ||= error; }
    }
  });
  await Promise.all(runners);
  if (failed) throw failed;
}

async function runJob(job, ctx) {
  const { workerId, adapter, chatId, log = () => {} } = ctx;
  assertStorageAdapter(adapter);
  const partSize = ctx.partSize;
  const leaseMs = ctx.leaseMs ?? 120000;
  const concurrency = ctx.uploadConcurrency ?? 2;
  const workDir = path.join(ctx.workRoot, job.assetId);
  const partsDir = path.join(workDir, 'parts');
  const abort = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, abort.signal]) : abort.signal;

  let current = job;
  let progress = { ...job.progress };
  let artifacts = { ...job.artifacts };
  let chain = Promise.resolve();
  // Progress writes are serialized so parallel uploads never overwrite each other.
  const save = (extra = {}) => {
    const write = chain.then(async () => {
      current = await repo.advanceJob(job.id, workerId, { progress, artifacts: { ...artifacts, ...extra } });
      artifacts = current.artifacts;
    });
    chain = write.catch(() => {});
    return write;
  };
  const advance = async stage => { await chain; current = await repo.advanceJob(job.id, workerId, { stage, progress, artifacts }); };

  let leaseError;
  const heartbeat = setInterval(() => {
    repo.heartbeatJob(job.id, workerId, { leaseMs }).catch(error => { leaseError = error; abort.abort(); });
  }, Math.max(1000, Math.floor(leaseMs / 3)));
  heartbeat.unref?.();
  const checkLease = () => { if (leaseError) throw leaseError; if (signal.aborted) throw new ImportError('IMPORT_CANCELLED', { retryable: true }); };

  const asset = () => repo.getAsset(job.assetId);
  // Moves the asset into the state a stage needs; resuming from failed is allowed.
  const enter = async (target, from) => {
    const value = await asset();
    if (value.state === target) return value;
    if (value.state === 'failed' || from.includes(value.state)) return repo.transitionAsset(value.id, value.state, target);
    throw new ImportError('ASSET_STATE_UNEXPECTED');
  };

  try {
    let stage = current.stage;
    const start = await asset();
    if (start.state === 'ready') { stage = 'done'; }
    if (start.state === 'superseded' || start.state === 'unavailable') throw new ImportError('ASSET_NOT_IMPORTABLE');

    while (stage !== 'done') {
      checkLease();
      log({ event: 'stage', stage, assetId: job.assetId, attempt: current.attempts });

      if (stage === 'validate') {
        await enter('validating', ['pending']);
        const source = artifacts.sourcePath;
        const fingerprint = await sourceFingerprint(source);
        const info = await prep.probe(source, { signal });
        prep.planPreparation(info, { allowTranscode: Boolean(artifacts.allowTranscode) });
        const value = await asset();
        prep.checkLanguages(info, value.audioLanguages);
        await prep.decodeCheck(source, info, { mode: artifacts.decodeMode === 'sample' ? 'sample' : 'full', signal });
        artifacts = { ...artifacts, sourceFingerprint: fingerprint };
        await advance(stage = 'prepare');
      }

      else if (stage === 'prepare') {
        const value = await enter('preparing', ['validating']);
        if (value.totalSize == null) {
          const fingerprint = await sourceFingerprint(artifacts.sourcePath);
          if (artifacts.sourceFingerprint && JSON.stringify(fingerprint) !== JSON.stringify(artifacts.sourceFingerprint)) throw new ImportError('SOURCE_CHANGED');
          const prepared = await prep.prepare(artifacts.sourcePath, workDir, {
            allowTranscode: Boolean(artifacts.allowTranscode), declaredLanguages: value.audioLanguages, decodeMode: 'none', signal });
          checkLease();
          const split = await splitFile(prepared.file, partSize, partsDir, { signal,
            onProgress: p => { progress = { ...progress, split: p }; } });
          checkLease();
          await repo.recordPreparedFile(job.assetId, {
            totalSize: split.totalSize, sha256: split.sha256, partSize,
            parts: split.parts.map(p => ({ sha256: p.sha256, size: p.size, integrityManifest: p.integrityManifest })),
            media: prepared.media,
          });
          artifacts = { ...artifacts, preparedFile: prepared.file, preparedIsSource: prepared.copiedSource,
            remuxed: prepared.remuxed, transcoded: prepared.transcoded };
          log({ event: 'prepared', assetId: job.assetId, bytes: split.totalSize, parts: split.parts.length, remuxed: prepared.remuxed, transcoded: prepared.transcoded });
        }
        await advance(stage = 'upload');
      }

      else if (stage === 'upload') {
        const value = await enter('uploading', ['preparing', 'verifying']);
        let parts = await repo.listParts(value.id);
        const pending = parts.filter(p => p.state === 'pending');
        if (pending.length) await ensurePartFiles(value, pending, artifacts, partsDir, signal);
        progress.intents ||= {};
        progress.possibleOrphans ||= [];

        // Ambiguous case: an upload was started but its result never saved.
        for (const part of pending) {
          const intent = progress.intents[part.partNumber];
          if (!intent) continue;
          const caption = buildCaption(value, part.partNumber);
          let adopted = null;
          if (typeof adapter.probeUploads === 'function' && intent.afterMessageId >= 0) {
            const window = await adapter.probeUploads({ chatId, fromMessageId: intent.afterMessageId + 1, count: ctx.probeWindow ?? DEFAULT_PROBE_WINDOW });
            const taken = new Set(parts.map(p => p.telegramMessageId).filter(Boolean));
            adopted = window.find(m => m.caption === caption && m.size === part.size && !taken.has(m.messageId));
          }
          if (adopted) {
            await repo.recordPartUpload(value.id, part.partNumber, { chatId, messageId: adopted.messageId, documentId: adopted.documentId });
            log({ event: 'adopted-upload', assetId: value.id, part: part.partNumber });
          } else {
            // Not found: re-upload. A stray copy may exist in the chat; record
            // where to look so an admin can remove it.
            progress.possibleOrphans.push({ partNumber: part.partNumber, afterMessageId: intent.afterMessageId, startedAt: intent.startedAt });
          }
          delete progress.intents[part.partNumber];
        }
        await save();
        parts = await repo.listParts(value.id);

        const todo = parts.filter(p => p.state === 'pending');
        let uploaded = parts.length - todo.length;
        await pool(todo, concurrency, async part => {
          checkLease();
          const file = path.join(partsDir, partFileName(part.partNumber, value.partCount));
          progress.intents[part.partNumber] = { afterMessageId: await repo.maxMessageId(chatId), startedAt: new Date().toISOString() };
          await save();
          const ref = await adapter.uploadPart({ filePath: file, caption: buildCaption(value, part.partNumber), expectedSize: part.size });
          if (String(ref.chatId) !== String(chatId)) throw new ImportError('STORAGE_CHAT_MISMATCH');
          await repo.recordPartUpload(value.id, part.partNumber, ref);
          delete progress.intents[part.partNumber];
          progress.partsUploaded = ++uploaded;
          await save();
          log({ event: 'uploaded', assetId: value.id, part: part.partNumber, of: value.partCount });
        });
        await advance(stage = 'verify');
      }

      else if (stage === 'verify') {
        const value = await enter('verifying', ['uploading']);
        const parts = await repo.listParts(value.id);
        if (parts.some(p => p.state === 'pending' || p.state === 'missing')) { await advance(stage = 'upload'); continue; }
        // Strict check: read every part back through the retrieval path, in
        // order, and rebuild the whole-file checksum from those bytes.
        const whole = createHash('sha256');
        const bad = [];
        for (const part of parts) {
          checkLease();
          const hash = createHash('sha256');
          let ok = true;
          try {
            // Ordered parallel 1 MiB reads: several requests in flight, bytes hashed in order.
            for await (const bytes of readOrdered(adapter, part, { concurrency: ctx.verifyConcurrency ?? 8, signal })) {
              hash.update(bytes); whole.update(bytes);
              progress.verifiedBytes = (progress.verifiedBytes || 0) + bytes.length;
            }
          } catch (error) {
            if (!['UPLOADED_MESSAGE_NOT_ACCESSIBLE', 'REFERENCED_FILE_CHANGED'].includes(error?.code)) throw error;
            ok = false;
          }
          const digest = ok && hash.digest('hex');
          if (ok && digest === part.sha256) {
            await repo.markPartVerified(value.id, part.partNumber, { sha256: digest });
          } else {
            bad.push(part);
          }
          progress.partsVerified = parts.indexOf(part) + 1 - bad.length;
          await save();
        }
        if (bad.length) {
          progress.verifyRounds = (progress.verifyRounds || 0) + 1;
          if (progress.verifyRounds >= MAX_VERIFY_ROUNDS) throw new ImportError('READBACK_MISMATCH_REPEATED');
          progress.possibleOrphans ||= [];
          for (const part of bad) {
            progress.possibleOrphans.push({ partNumber: part.partNumber, messageLink: part.messageLink, reason: 'READBACK_MISMATCH' });
            await repo.resetPartForReupload(value.id, part.partNumber);
          }
          log({ event: 'readback-mismatch', assetId: value.id, parts: bad.map(p => p.partNumber) });
          await repo.transitionAsset(value.id, 'verifying', 'uploading');
          await advance(stage = 'upload');
          continue;
        }
        if (whole.digest('hex') !== value.sha256) throw new ImportError('RECONSTRUCTION_MISMATCH');
        await advance(stage = 'publish');
      }

      else if (stage === 'publish') {
        const value = await asset();
        if (value.state !== 'ready') {
          const { supersededId } = await repo.publishReady(value.id, { makeDefault: Boolean(artifacts.makeDefault) });
          log({ event: 'ready', assetId: value.id, supersededId });
        }
        stage = 'done';
      }

      else throw new ImportError('UNKNOWN_STAGE');
    }

    await chain;
    clearInterval(heartbeat);
    const done = await repo.completeJob(job.id, workerId);
    if (!artifacts.keepArtifacts) await cleanup(workDir);
    return { status: 'succeeded', job: done, asset: await asset() };
  } catch (error) {
    clearInterval(heartbeat);
    await chain;
    const failure = classify(leaseError || error);
    log({ event: 'failed', assetId: job.assetId, code: failure.code, retryable: failure.retryable });
    // A lost lease means another worker owns the job now: change nothing.
    if (failure.leaseLost) return { status: 'lease-lost', code: failure.code };
    const value = await asset();
    if (!['failed', 'ready', 'superseded', 'unavailable'].includes(value.state)) {
      await repo.transitionAsset(value.id, value.state, 'failed', { failureReason: failure.code }).catch(() => {});
    }
    const failed = await repo.failJob(job.id, workerId, { errorCategory: failure.code, retryable: failure.retryable,
      retryAfterMs: failure.retryAfterMs, baseDelayMs: ctx.retryBaseDelayMs }).catch(() => null);
    return { status: failed?.status === 'queued' ? 'retry-scheduled' : 'failed', code: failure.code, job: failed };
  }
}

// Part files must match the checksums already in the index. If any are
// missing or changed, re-split the prepared file and require identical results.
async function ensurePartFiles(asset, pending, artifacts, partsDir, signal) {
  for (const part of pending) {
    const file = path.join(partsDir, partFileName(part.partNumber, asset.partCount));
    const local = await hashFile(file, { signal }).catch(() => null);
    if (local && local.size === part.size && local.sha256 === part.sha256) continue;
    if (!artifacts.preparedFile) throw new ImportError('PREPARED_FILE_MISSING');
    const split = await splitFile(artifacts.preparedFile, asset.partSize, partsDir, { signal }).catch(error => {
      if (error.code === 'ENOENT') throw new ImportError('PREPARED_FILE_MISSING');
      throw error;
    });
    if (split.sha256 !== asset.sha256 || split.parts.length !== asset.partCount) throw new ImportError('PREPARED_FILE_CHANGED');
    const index = await repo.listParts(asset.id);
    if (split.parts.some((p, i) => p.sha256 !== index[i].sha256)) throw new ImportError('PREPARED_FILE_CHANGED');
    return;
  }
}

async function cleanup(workDir) {
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
}

// Processes due jobs until none remain (or `maxJobs` is reached).
async function runWorker(ctx, { maxJobs = Infinity } = {}) {
  const results = [];
  const claim = async () => {
    // A flaky database connection shouldn't end the run: retry the claim.
    for (let attempt = 0; ; attempt++) {
      try { return await repo.claimJob(ctx.workerId, { leaseMs: ctx.leaseMs ?? 120000 }); }
      catch (error) {
        if (attempt >= (ctx.claimRetries ?? 4) || classify(error).code !== 'DATABASE_UNAVAILABLE') throw error;
        ctx.log?.({ event: 'database-retry', attempt: attempt + 1 });
        await new Promise(resolve => setTimeout(resolve, (ctx.claimRetryBaseMs ?? 2000) * 2 ** attempt));
      }
    }
  };
  while (results.length < maxJobs) {
    if (ctx.signal?.aborted) break;
    const job = await claim();
    if (!job) break;
    results.push({ jobId: job.id, assetId: job.assetId, ...(await runJob(job, ctx)) });
  }
  return results;
}

module.exports = { runJob, runWorker, classify, ImportError };
