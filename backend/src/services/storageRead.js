// Reads a stored part from Telegram in order, with several 1 MiB requests in
// flight (Phase 5/6). Used for read-back verification of whole parts.
const { createHash } = require('node:crypto');

const CHUNK = 1024 * 1024; // Telegram reads must stay inside one 1 MiB boundary

// Yields the part's bytes in order. At most `concurrency` chunks are requested
// ahead; consumers that hash or compare can stream through multi-GB parts.
async function* readOrdered(adapter, part, { concurrency = 8, signal } = {}) {
  const ref = { chatId: part.telegramChatId, messageId: part.telegramMessageId, documentId: part.mtprotoDocumentId, size: part.size };
  const offsets = [];
  for (let offset = 0; offset < part.size; offset += CHUNK) offsets.push(offset);
  const window = [];
  let next = 0;
  const launch = () => {
    while (window.length < concurrency && next < offsets.length) {
      const offset = offsets[next++];
      const length = Math.min(CHUNK, part.size - offset);
      const promise = adapter.readRange(ref, offset, length, { signal }).then(bytes => {
        if (bytes.length !== length) throw Object.assign(new Error('TRUNCATED_READ'), { code: 'TRUNCATED_READ' });
        return bytes;
      });
      promise.catch(() => {}); // observed when awaited below
      window.push(promise);
    }
  };
  launch();
  while (window.length) {
    if (signal?.aborted) throw Object.assign(new Error('READ_CANCELLED'), { code: 'READ_CANCELLED' });
    const bytes = await window.shift();
    launch();
    yield bytes;
  }
}

// SHA-256 of a whole stored part, read back from Telegram.
async function hashStoredPart(adapter, part, { concurrency = 8, signal, onBytes } = {}) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of readOrdered(adapter, part, { concurrency, signal })) {
    hash.update(chunk); bytes += chunk.length; onBytes?.(chunk, bytes);
  }
  return { sha256: hash.digest('hex'), bytes };
}

module.exports = { readOrdered, hashStoredPart, CHUNK };
