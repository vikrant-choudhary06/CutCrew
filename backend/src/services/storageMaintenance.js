// Telegram storage Phase 5: checks and repairs for stored videos.
//
// verifyAsset   - every part's Telegram message still exists with the same
//                 file and size; 'quick' also checks the first and last
//                 integrity blocks, 'deep' re-reads every byte and compares
//                 the whole-file checksum (a full reconstruction check).
// restoreAsset  - an 'unavailable' asset whose parts check out again goes
//                 back to Ready (through the same Ready gate as an import).
// revalidateDue - bounded background pass over the least recently checked
//                 Ready assets.
// Only a confirmed missing or changed message marks a part missing; network
// problems are reported but change nothing.
const { createHash } = require('node:crypto');
const repo = require('./videoStorageRepository');
const { hashStoredPart } = require('./storageRead');

const CONFIRMED = ['UPLOADED_MESSAGE_NOT_ACCESSIBLE', 'REFERENCED_FILE_CHANGED', 'STORAGE_CHAT_MISMATCH', 'BLOCK_MISMATCH', 'PART_MISMATCH', 'SIZE_MISMATCH'];
const safeCode = error => String(error?.code || 'CHECK_FAILED').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 64);

async function checkPart(adapter, part, mode, { concurrency, signal }) {
  const ref = { chatId: part.telegramChatId, messageId: part.telegramMessageId, documentId: part.mtprotoDocumentId, size: part.size };
  const info = await adapter.lookupMessage(ref);
  if (Number(info.size) !== part.size) throw Object.assign(new Error('SIZE_MISMATCH'), { code: 'SIZE_MISMATCH' });
  if (part.mtprotoDocumentId && info.documentId && String(info.documentId) !== String(part.mtprotoDocumentId)) {
    throw Object.assign(new Error('REFERENCED_FILE_CHANGED'), { code: 'REFERENCED_FILE_CHANGED' });
  }
  if (mode === 'deep') {
    const { sha256 } = await hashStoredPart(adapter, part, { concurrency, signal });
    if (sha256 !== part.sha256) throw Object.assign(new Error('PART_MISMATCH'), { code: 'PART_MISMATCH' });
    return { bytesRead: part.size };
  }
  if (mode === 'quick') {
    const manifest = part.integrityManifest;
    if (!manifest?.blocks?.length) return { bytesRead: 0 };
    let bytesRead = 0;
    for (const index of [...new Set([0, manifest.blocks.length - 1])]) {
      const start = index * manifest.blockSize, length = Math.min(manifest.blockSize, part.size - start);
      const chunks = [];
      // Read in <=1 MiB pieces aligned to 1 MiB (Telegram's rule).
      for (let at = start; at < start + length;) {
        const next = Math.min(start + length, (Math.floor(at / 1048576) + 1) * 1048576);
        chunks.push(await adapter.readRange(ref, at, next - at, { signal }));
        at = next;
      }
      const bytes = Buffer.concat(chunks);
      bytesRead += bytes.length;
      if (createHash('sha256').update(bytes).digest('hex') !== manifest.blocks[index]) throw Object.assign(new Error('BLOCK_MISMATCH'), { code: 'BLOCK_MISMATCH' });
    }
    return { bytesRead };
  }
  return { bytesRead: 0 };
}

async function verifyAsset(assetId, { adapter, mode = 'quick', concurrency = 8, signal, markMissing = true, log = () => {} } = {}) {
  const asset = await repo.getAsset(assetId);
  if (!asset) throw Object.assign(new Error('ASSET_NOT_FOUND'), { code: 'ASSET_NOT_FOUND' });
  if (!asset.parts?.length) throw Object.assign(new Error('ASSET_HAS_NO_PARTS'), { code: 'ASSET_HAS_NO_PARTS' });
  const started = Date.now(), parts = [];
  for (const part of asset.parts) {
    if (!part.telegramMessageId) { parts.push({ part: part.partNumber, ok: false, code: 'NOT_UPLOADED', confirmed: false }); continue; }
    try {
      const { bytesRead } = await checkPart(adapter, part, mode, { concurrency, signal });
      parts.push({ part: part.partNumber, ok: true, bytesRead });
    } catch (error) {
      const code = safeCode(error), confirmed = CONFIRMED.includes(code);
      parts.push({ part: part.partNumber, ok: false, code, confirmed });
      log({ event: 'part-check-failed', assetId, part: part.partNumber, code, confirmed });
      if (confirmed && markMissing && ['ready', 'unavailable'].includes(asset.state) && part.state !== 'missing') {
        await repo.markPartMissing(assetId, part.partNumber);
      }
    }
  }
  const allOk = parts.every(p => p.ok);
  if (allOk) await repo.touchValidated(assetId);
  const after = await repo.getAsset(assetId, { withParts: false });
  return { assetId, mode, ok: allOk, stateBefore: asset.state, stateAfter: after.state, seconds: +((Date.now() - started) / 1000).toFixed(1), parts };
}

// Brings an unavailable asset back once every part checks out again.
async function restoreAsset(assetId, { adapter, mode = 'quick', concurrency = 8, signal } = {}) {
  const asset = await repo.getAsset(assetId);
  if (!asset) throw Object.assign(new Error('ASSET_NOT_FOUND'), { code: 'ASSET_NOT_FOUND' });
  if (asset.state !== 'unavailable') throw Object.assign(new Error('ASSET_NOT_UNAVAILABLE'), { code: 'ASSET_NOT_UNAVAILABLE' });
  const report = await verifyAsset(assetId, { adapter, mode, concurrency, signal, markMissing: false });
  if (!report.ok) return { ...report, restored: false };
  for (const part of asset.parts.filter(p => p.state === 'missing')) await repo.markPartReverified(assetId, part.partNumber);
  await repo.transitionAsset(assetId, 'unavailable', 'verifying');
  await repo.publishReady(assetId);
  return { ...report, restored: true, stateAfter: 'ready' };
}

// Background pass: a few least-recently-checked Ready assets, lookup only by
// default so it stays cheap. Returns a short summary for logs.
async function revalidateDue({ adapter, limit = 5, olderThanMs = 24 * 3600 * 1000, mode = 'lookup', log = () => {} } = {}) {
  const due = await repo.assetsDueForValidation({ olderThanMs, limit });
  const results = [];
  for (const asset of due) {
    try { const r = await verifyAsset(asset.id, { adapter, mode, log }); results.push({ assetId: asset.id, ok: r.ok, stateAfter: r.stateAfter }); }
    catch (error) { results.push({ assetId: asset.id, ok: false, code: safeCode(error) }); }
  }
  return { checked: results.length, problems: results.filter(r => !r.ok), results };
}

module.exports = { verifyAsset, restoreAsset, revalidateDue };
