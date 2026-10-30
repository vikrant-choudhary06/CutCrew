// Telegram storage Phase 2: split the prepared file into exact raw byte parts
// (telegramintegration.md §6). Joining the parts in order reproduces the
// prepared file byte for byte; parts are not playable on their own.
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { planParts } = require('./videoStorageRepository');

const MAX_BLOCKS_PER_PART = 256;
const MIN_BLOCK = 8 * 1024 * 1024;
const ALIGN = 512 * 1024; // matches Telegram's download alignment

// Block size for partial-read integrity checks: >= 8 MiB, 512 KiB aligned,
// and at most 256 block hashes per part.
function blockSizeFor(partSize) {
  const wanted = Math.max(MIN_BLOCK, Math.ceil(partSize / MAX_BLOCKS_PER_PART));
  return Math.ceil(wanted / ALIGN) * ALIGN;
}

const partFileName = (number, count) => `part-${String(number).padStart(Math.max(2, String(count).length), '0')}.bin`;

async function writeAll(handle, buffer) {
  let written = 0;
  while (written < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, written, buffer.length - written);
    if (!bytesWritten) throw new Error('SPLIT_WRITE_FAILED');
    written += bytesWritten;
  }
}

// One streaming pass: whole-file SHA-256, per-part SHA-256 and block hashes.
// Part files are written as .tmp and renamed only when complete.
async function splitFile(file, partSize, outDir, { signal, onProgress } = {}) {
  const { size } = await fs.stat(file);
  const plan = planParts(size, partSize);
  const blockSize = blockSizeFor(partSize);
  await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
  const disk = await fs.statfs(outDir);
  if (disk.bavail * disk.bsize < size + 128 * 1024 * 1024) throw Object.assign(new Error('INSUFFICIENT_DISK_SPACE'), { code: 'INSUFFICIENT_DISK_SPACE', retryable: true });

  const whole = createHash('sha256');
  const parts = [];
  let index = -1, handle, partHash, blockHash, blockFill = 0, blocks = [], partWritten = 0, total = 0, temp;

  const openPart = async () => {
    index++;
    const slice = plan[index];
    temp = path.join(outDir, partFileName(slice.partNumber, plan.length) + '.tmp');
    handle = await fs.open(temp, 'w', 0o600);
    partHash = createHash('sha256'); blockHash = createHash('sha256'); blockFill = 0; blocks = []; partWritten = 0;
  };
  const closePart = async () => {
    if (blockFill) blocks.push(blockHash.digest('hex'));
    await handle.sync(); await handle.close(); handle = undefined;
    const slice = plan[index];
    const final = path.join(outDir, partFileName(slice.partNumber, plan.length));
    await fs.rename(temp, final);
    parts.push({ partNumber: slice.partNumber, offset: slice.offset, size: slice.size, path: final,
      sha256: partHash.digest('hex'), integrityManifest: { algorithm: 'sha256', blockSize, blocks } });
  };

  try {
    await openPart();
    for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) {
      if (signal?.aborted) throw Object.assign(new Error('SPLIT_CANCELLED'), { code: 'SPLIT_CANCELLED', retryable: true });
      whole.update(chunk);
      let used = 0;
      while (used < chunk.length) {
        const slice = plan[index];
        const take = Math.min(chunk.length - used, slice.size - partWritten, blockSize - blockFill);
        const piece = chunk.subarray(used, used + take);
        await writeAll(handle, piece);
        partHash.update(piece); blockHash.update(piece);
        used += take; partWritten += take; blockFill += take; total += take;
        if (blockFill === blockSize) { blocks.push(blockHash.digest('hex')); blockHash = createHash('sha256'); blockFill = 0; }
        if (partWritten === slice.size) {
          await closePart();
          onProgress?.({ partsWritten: parts.length, partCount: plan.length, bytes: total });
          if (index + 1 < plan.length) await openPart();
        }
      }
    }
    if (total !== size || parts.length !== plan.length) throw Object.assign(new Error('SOURCE_CHANGED_DURING_SPLIT'), { code: 'SOURCE_CHANGED_DURING_SPLIT', retryable: true });
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (temp) await fs.rm(temp, { force: true });
    throw error;
  }
  return { totalSize: size, sha256: whole.digest('hex'), partSize, blockSize, parts };
}

async function hashFile(file, { signal } = {}) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) {
    if (signal?.aborted) throw Object.assign(new Error('HASH_CANCELLED'), { code: 'HASH_CANCELLED', retryable: true });
    hash.update(chunk); size += chunk.length;
  }
  return { sha256: hash.digest('hex'), size };
}

module.exports = { splitFile, hashFile, blockSizeFor, partFileName, MAX_BLOCKS_PER_PART };
