// Telegram storage Phase 3: read a stored asset as one continuous, immutable
// file (telegramintegration.md §11–§13).
//
// Original-file offsets map to (part, local offset). Data is fetched in
// integrity blocks (the import's block size, usually 8 MiB), each downloaded
// as parallel 1 MiB Telegram-aligned chunks, checked against the import's
// SHA-256 and cached. Requested bytes beat speculative prefetch.
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { BlockCache } = require('./streamCache');

const CHUNK = 1024 * 1024; // Telegram partial downloads must not cross 1 MiB boundaries
const PERMANENT = ['UPLOADED_MESSAGE_NOT_ACCESSIBLE', 'REFERENCED_FILE_CHANGED', 'STORAGE_CHAT_MISMATCH'];

class StreamError extends Error {
  constructor(code, { status = 502 } = {}) { super(code); this.code = code; this.status = status; }
}

// Bounded worker pool whose queue is ordered by live priority, so a prefetch
// that a viewer suddenly needs can jump ahead.
class PriorityLimiter {
  constructor(limit) { this.limit = limit; this.active = 0; this.queue = []; }
  run(task, priority) {
    return new Promise((resolve, reject) => { this.queue.push({ task, priority, resolve, reject }); this.pump(); });
  }
  pump() {
    while (this.active < this.limit && this.queue.length) {
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) if (this.queue[i].priority.high && !this.queue[best].priority.high) best = i;
      const job = this.queue.splice(best, 1)[0];
      this.active++;
      Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => { this.active--; this.pump(); });
    }
  }
}

// Locates the parts/blocks covering [start, end] (inclusive) of the original file.
function planRange(asset, start, end) {
  const out = [];
  for (const part of asset.parts) {
    const partEnd = part.offset + part.size - 1;
    if (partEnd < start || part.offset > end) continue;
    const blockSize = part.integrityManifest?.blockSize || 8 * 1024 * 1024;
    const from = Math.max(start, part.offset) - part.offset;
    const to = Math.min(end, partEnd) - part.offset;
    for (let block = Math.floor(from / blockSize); block * blockSize <= to; block++) {
      const blockStart = block * blockSize;
      const blockLength = Math.min(blockSize, part.size - blockStart);
      out.push({ part, block, blockStart, blockLength,
        sliceFrom: Math.max(from, blockStart) - blockStart, sliceTo: Math.min(to, blockStart + blockLength - 1) - blockStart });
    }
  }
  return out;
}

class StoredStreamer {
  constructor({ adapter, cache, fetchConcurrency = 8, prefetchBlocks = 3, retries = 3, retryBaseMs = 300, maxWaitMs = 30000, onPartMissing } = {}) {
    if (!(cache instanceof BlockCache)) throw new Error('cache must be a BlockCache');
    this.adapter = adapter;
    this.cache = cache;
    this.limiter = new PriorityLimiter(fetchConcurrency);
    this.prefetchBlocks = prefetchBlocks;
    this.retries = retries;
    this.retryBaseMs = retryBaseMs;
    this.maxWaitMs = maxWaitMs;
    this.onPartMissing = onPartMissing;
    this.inflight = new Map(); // block key -> { promise, priority, owners }
    this.reportedMissing = new Set();
    this.stats = { blocksFetched: 0, bytesFetched: 0, chunkRetries: 0, integrityRefetches: 0, prefetchStarted: 0, prefetchCancelled: 0 };
  }

  // One 1 MiB chunk with bounded retries; Telegram waits are honoured up to maxWaitMs.
  async readChunk(part, offset, length, signal) {
    const ref = { chatId: part.telegramChatId, messageId: part.telegramMessageId, documentId: part.mtprotoDocumentId, size: part.size };
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new StreamError('STREAM_CANCELLED', { status: 499 });
      try {
        const bytes = await this.adapter.readRange(ref, offset, length, { signal });
        if (bytes.length !== length) throw new StreamError('TRUNCATED_CHUNK');
        return bytes;
      } catch (error) {
        if (PERMANENT.includes(error?.code)) {
          // Parallel chunks of one part may all hit this; report it once.
          const missingKey = `${part.assetId}/${part.partNumber}`;
          if (!this.reportedMissing.has(missingKey)) {
            this.reportedMissing.add(missingKey);
            await Promise.resolve(this.onPartMissing?.(part)).catch(() => {});
          }
          throw new StreamError('STORED_PART_UNAVAILABLE', { status: 503 });
        }
        if (error?.code === 'STREAM_CANCELLED' || attempt >= this.retries) throw error;
        const waitMs = (Number(error?.seconds) || Number(error?.details?.retryAfterSeconds) || 0) * 1000;
        if (waitMs > this.maxWaitMs) throw new StreamError('TELEGRAM_WAIT_TOO_LONG', { status: 503 });
        this.stats.chunkRetries++;
        await sleep(Math.max(waitMs, this.retryBaseMs * 2 ** attempt), undefined, signal ? { signal } : undefined).catch(() => {});
      }
    }
  }

  // Downloads one integrity block in parallel chunks and verifies it.
  async downloadBlock(item, entry) {
    const { part, block, blockStart, blockLength } = item;
    const expected = part.integrityManifest?.blocks?.[block];
    const wanted = () => entry.priority.high || [...entry.owners].some(signal => !signal.aborted);
    for (let round = 0; round < 2; round++) {
      // Chunks follow absolute 1 MiB boundaries of the part (blocks are only
      // 512 KiB aligned), so no Telegram request crosses a 1 MiB boundary.
      const chunks = [];
      for (let at = blockStart; at < blockStart + blockLength;) {
        const next = Math.min(blockStart + blockLength, (Math.floor(at / CHUNK) + 1) * CHUNK);
        chunks.push([at - blockStart, next - at]);
        at = next;
      }
      const pieces = await Promise.all(chunks.map(([offset, length]) => this.limiter.run(() => {
        if (!wanted()) { throw new StreamError('PREFETCH_CANCELLED', { status: 499 }); }
        return this.readChunk(part, blockStart + offset, length);
      }, entry.priority)));
      const bytes = Buffer.concat(pieces);
      if (!expected || createHash('sha256').update(bytes).digest('hex') === expected) {
        this.stats.blocksFetched++; this.stats.bytesFetched += bytes.length;
        return bytes;
      }
      this.stats.integrityRefetches++;
    }
    throw new StreamError('BLOCK_INTEGRITY_FAILED');
  }

  // Cached → in-flight → new download. Concurrent callers share one download.
  async getBlock(asset, item, { high = true, signal } = {}) {
    const key = BlockCache.key(asset.id, item.part.partNumber, item.block);
    const expected = item.part.integrityManifest?.blocks?.[item.block];
    let entry = this.inflight.get(key);
    if (entry) {
      if (high) entry.priority.high = true;
      if (signal) entry.owners.add(signal);
      // A prefetch can be cancelled just before a viewer joins it: start over.
      return entry.promise.catch(error => (high && error.code === 'PREFETCH_CANCELLED' ? this.getBlock(asset, item, { high, signal }) : Promise.reject(error)));
    }
    entry = { priority: { high }, owners: new Set(signal ? [signal] : []) };
    entry.promise = (async () => {
      const cached = await this.cache.get(key, { size: item.blockLength, sha256: expected });
      if (cached) return cached;
      const bytes = await this.downloadBlock(item, entry);
      await this.cache.put(key, bytes).catch(() => false);
      return bytes;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, entry);
    return entry.promise;
  }

  // Writes bytes [start, end] of the asset to `out`, in order, honouring
  // backpressure and cancellation. Prefetches a bounded number of blocks ahead.
  async streamRange(asset, start, end, out, signal) {
    const plan = planRange(asset, start, end);
    const prefetch = index => {
      for (let i = index + 1; i <= Math.min(plan.length - 1, index + this.prefetchBlocks); i++) {
        this.stats.prefetchStarted++;
        this.getBlock(asset, plan[i], { high: false, signal }).catch(() => { this.stats.prefetchCancelled++; });
      }
    };
    for (let i = 0; i < plan.length; i++) {
      if (signal.aborted) throw new StreamError('STREAM_CANCELLED', { status: 499 });
      const item = plan[i];
      const key = BlockCache.key(asset.id, item.part.partNumber, item.block);
      prefetch(i);
      const bytes = await this.getBlock(asset, item, { high: true, signal });
      this.cache.pin(key);
      try {
        const slice = bytes.subarray(item.sliceFrom, item.sliceTo + 1);
        if (!out.write(slice)) await once(out, 'drain', { signal });
      } finally { this.cache.unpin(key); }
    }
  }
}

// ---------- HTTP range rules ----------

// Single-range support per RFC 9110. Multi-range and malformed headers are
// ignored (served as 200 with the whole file), which the RFC allows.
function parseRange(header, size) {
  if (!header) return { type: 'full' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (!match[1] && !match[2])) return { type: 'full' };
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix)) return { type: 'full' };
    if (suffix === 0) return { type: 'unsatisfiable' };
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { type: 'full' };
    if (match[2] && Number(match[2]) < start) return { type: 'full' };
    if (start >= size) return { type: 'unsatisfiable' };
  }
  return { type: 'partial', start, end };
}

module.exports = { StoredStreamer, PriorityLimiter, StreamError, planRange, parseRange, CHUNK };
