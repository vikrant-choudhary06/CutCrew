// Storage adapter contract for Telegram-held video parts (Phase 1).
//
// Every adapter implements:
//   uploadPart({ filePath, caption, expectedSize })
//       -> { chatId, messageId, botFileId, botFileUniqueId, documentId?, size }
//   lookupMessage({ chatId, messageId, expected? })
//       -> { chatId, messageId, documentId, size }
//   refreshReference({ chatId, messageId, documentId?, size? })
//       -> same shape as lookupMessage; throws REFERENCED_FILE_CHANGED if the
//          message now holds a different file
//   readRange({ chatId, messageId, documentId?, size? }, offset, length, { signal })
//       -> Buffer of exactly `length` bytes (length <= MAX_READ_BYTES)
//   close()
// Optional:
//   probeUploads({ chatId, fromMessageId, count })
//       -> [{ messageId, caption, documentId, size }] for document messages in
//          that ID window. Lets a resumed import adopt an upload Telegram
//          accepted just before the worker crashed, instead of re-uploading.
//
// Reference refresh and permanent-unavailability handling stay inside the
// adapter; callers only see bytes or a safe error code.
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { Phase0Error, botCall: defaultBotCall } = require('./telegramStorage');

const METHODS = ['uploadPart', 'lookupMessage', 'refreshReference', 'readRange', 'close'];
const MAX_READ_BYTES = 4 * 1024 * 1024;
const CAPTION_LIMIT = 1024; // Telegram caption limit

class StorageAdapterError extends Error {
  constructor(code, details = {}) { super(code); this.code = code; this.details = details; }
}

function assertStorageAdapter(adapter) {
  const missing = METHODS.filter(name => typeof adapter?.[name] !== 'function');
  if (missing.length) throw new StorageAdapterError('STORAGE_ADAPTER_INVALID', { missing });
  return adapter;
}

function probeIds(fromMessageId, count) {
  if (!Number.isSafeInteger(fromMessageId) || fromMessageId < 1 || !Number.isSafeInteger(count) || count < 1 || count > 1000) {
    throw new StorageAdapterError('INVALID_PROBE_WINDOW');
  }
  return Array.from({ length: count }, (_, i) => fromMessageId + i);
}

function checkRange(offset, length, size) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 ||
      length > MAX_READ_BYTES || (Number.isSafeInteger(size) && offset + length > size)) {
    throw new StorageAdapterError('INVALID_RANGE');
  }
}

const pad = (value, width = 2) => String(value).padStart(width, '0');
const clean = value => String(value).replace(/[\r\n]+/g, ' ').trim();
const LANGUAGE_NAMES = { hi: 'Hindi', en: 'English', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam', kn: 'Kannada', bn: 'Bengali', mr: 'Marathi', pa: 'Punjabi', gu: 'Gujarati', ur: 'Urdu', ja: 'Japanese', ko: 'Korean', es: 'Spanish', fr: 'French', de: 'German' };

// Caption per telegramintegration.md §7. Captions help humans recover files;
// playback never searches them.
function buildCaption(asset, partNumber) {
  const total = asset.partCount;
  if (!Number.isSafeInteger(total) || total < 1 || !Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > total) {
    throw new StorageAdapterError('INVALID_PART_NUMBER');
  }
  const width = Math.max(2, String(total).length);
  const audio = (asset.audioLanguages || []).map(code => LANGUAGE_NAMES[code] || code).join(', ') || 'Unknown';
  const lines = ['Schema: cutcrew-video-v1'];
  if (asset.contentType === 'episode') {
    lines.push('Type: Series', `IMDb ID: ${asset.imdbId}`);
    if (asset.title) lines.push(`Title: ${clean(asset.title).slice(0, 200)}`);
    if (asset.releaseYear) lines.push(`Series release year: ${asset.releaseYear}`);
    lines.push(`Season: ${pad(asset.season)}`, `Episode: ${pad(asset.episode)}`);
    if (asset.episodeReleaseYear) lines.push(`Episode release year: ${asset.episodeReleaseYear}`);
  } else {
    lines.push('Type: Movie', `IMDb ID: ${asset.imdbId}`);
    if (asset.title) lines.push(`Title: ${clean(asset.title).slice(0, 200)}`);
    if (asset.releaseYear) lines.push(`Release year: ${asset.releaseYear}`);
  }
  lines.push(`Quality: ${asset.quality}`);
  if (asset.edition && asset.edition !== 'original') lines.push(`Edition: ${asset.edition}`);
  lines.push(`Audio: ${audio}`, `Part: ${pad(partNumber, width)}/${pad(total, width)}`, `Upload ID: ${asset.id}`);
  const caption = lines.join('\n');
  if (caption.length > CAPTION_LIMIT) throw new StorageAdapterError('CAPTION_TOO_LONG');
  return caption;
}

// ---------- Telegram implementation (Local Bot API upload + MTProto read) ----------

function createTelegramAdapter(config, { botCall = defaultBotCall, connect = require('./telegramClient').connect, downloadSessions = 1, downloadInflight = 1 } = {}) {
  if (!config?.ready) throw new StorageAdapterError('CONFIGURATION_INCOMPLETE');
  let session, connecting;
  const readers = new Map();
  // Drops a dead connection (and the readers bound to it) so the next call reconnects.
  const reset = dead => {
    if (!dead || session !== dead) return;
    readers.clear(); session = undefined;
    Promise.resolve(dead.close()).catch(() => {});
  };
  const mtproto = async () => {
    if (session && session.isConnected?.() === false) reset(session);
    if (session) return session;
    connecting ||= connect(config, { downloadSessions, downloadInflight }).then(value => { session = value; return value; }).finally(() => { connecting = undefined; });
    return connecting;
  };
  // Runs one MTProto operation; if it failed because the connection dropped,
  // reconnects and tries once more. Other errors pass through unchanged.
  const withSession = async work => {
    const first = await mtproto();
    try { return await work(first); }
    catch (error) {
      if (first.isConnected?.() !== false) throw error;
      reset(first);
      return work(await mtproto());
    }
  };
  const ownChat = chatId => {
    if (String(chatId) !== String(config.channelId)) throw new StorageAdapterError('STORAGE_CHAT_MISMATCH');
  };
  const describeMessage = message => ({
    chatId: String(config.channelId), messageId: Number(message.id),
    documentId: message.document.id.toString(), size: Number(message.document.size.toString()),
  });
  const expectedIdentity = ref => (ref.documentId != null && ref.size != null ? { id: String(ref.documentId), size: Number(ref.size) } : undefined);

  async function readerFor(ref, client) {
    const key = Number(ref.messageId);
    if (!readers.has(key)) {
      const message = await client.message(key, expectedIdentity(ref));
      readers.set(key, client.reader(message));
    }
    return readers.get(key);
  }

  return assertStorageAdapter({
    async uploadPart({ filePath, caption, expectedSize }) {
      if (typeof caption !== 'string' || caption.length > CAPTION_LIMIT) throw new StorageAdapterError('CAPTION_TOO_LONG');
      const stat = await fs.stat(filePath);
      if (expectedSize !== undefined && stat.size !== expectedSize) throw new StorageAdapterError('PART_SIZE_MISMATCH');
      const result = await botCall(config, 'sendDocument',
        { chat_id: config.channelId, caption, disable_content_type_detection: true }, filePath);
      if (!result?.message_id || !result.document?.file_id) throw new StorageAdapterError('BOT_API_INVALID_RESPONSE');
      ownChat(result.chat?.id);
      const size = Number(result.document.file_size);
      if (Number.isFinite(size) && size !== stat.size) throw new StorageAdapterError('PART_SIZE_MISMATCH');
      return { chatId: String(result.chat.id), messageId: Number(result.message_id), botFileId: result.document.file_id,
        botFileUniqueId: result.document.file_unique_id ?? null, documentId: null, size: stat.size };
    },
    async lookupMessage(ref) {
      ownChat(ref.chatId);
      return withSession(async client => describeMessage(await client.message(Number(ref.messageId), expectedIdentity(ref))));
    },
    async refreshReference(ref) {
      ownChat(ref.chatId);
      return withSession(async client => {
        await (await readerFor(ref, client)).refresh();
        return describeMessage(await client.message(Number(ref.messageId), expectedIdentity(ref)));
      });
    },
    async probeUploads({ chatId, fromMessageId, count }) {
      ownChat(chatId);
      const ids = probeIds(fromMessageId, count);
      return withSession(async client => {
        const found = [];
        for (let i = 0; i < ids.length; i += 100) {
          for (const row of await client.messages(ids.slice(i, i + 100))) if (row) found.push({ messageId: row.id, caption: row.caption, documentId: row.documentId, size: row.size });
        }
        return found;
      });
    },
    async readRange(ref, offset, length, { signal } = {}) {
      ownChat(ref.chatId);
      checkRange(offset, length, ref.size);
      if (signal?.aborted) throw new StorageAdapterError('READ_CANCELLED');
      return withSession(async client => (await readerFor(ref, client)).read(offset, length));
    },
    async close() {
      readers.clear();
      const current = session; session = undefined;
      if (current) await current.close();
    },
  });
}

// ---------- In-memory implementation (tests and local development) ----------

function createMemoryAdapter({ chatId = '-1001234567890' } = {}) {
  const messages = new Map();
  let nextId = 1;
  const find = ref => {
    if (String(ref.chatId) !== chatId) throw new StorageAdapterError('STORAGE_CHAT_MISMATCH');
    const message = messages.get(Number(ref.messageId));
    if (!message) throw new StorageAdapterError('UPLOADED_MESSAGE_NOT_ACCESSIBLE');
    if (ref.documentId != null && String(ref.documentId) !== message.documentId) throw new StorageAdapterError('REFERENCED_FILE_CHANGED');
    return message;
  };
  const describe = (id, message) => ({ chatId, messageId: id, documentId: message.documentId, size: message.bytes.length });
  return assertStorageAdapter({
    messages,
    async uploadPart({ filePath, caption, expectedSize }) {
      const bytes = await fs.readFile(filePath);
      if (expectedSize !== undefined && bytes.length !== expectedSize) throw new StorageAdapterError('PART_SIZE_MISMATCH');
      const id = nextId++;
      const documentId = String(BigInt('0x' + randomUUID().replace(/-/g, '').slice(0, 15)));
      messages.set(id, { bytes, caption, documentId });
      return { chatId, messageId: id, botFileId: 'mem-' + id, botFileUniqueId: 'memu-' + id, documentId, size: bytes.length };
    },
    async lookupMessage(ref) { return describe(Number(ref.messageId), find(ref)); },
    async refreshReference(ref) { return describe(Number(ref.messageId), find(ref)); },
    async readRange(ref, offset, length, { signal } = {}) {
      const message = find(ref);
      checkRange(offset, length, message.bytes.length);
      if (signal?.aborted) throw new StorageAdapterError('READ_CANCELLED');
      return Buffer.from(message.bytes.subarray(offset, offset + length));
    },
    async probeUploads({ chatId: probeChat, fromMessageId, count }) {
      if (String(probeChat) !== chatId) throw new StorageAdapterError('STORAGE_CHAT_MISMATCH');
      return probeIds(fromMessageId, count).filter(id => messages.has(id))
        .map(id => ({ messageId: id, caption: messages.get(id).caption, documentId: messages.get(id).documentId, size: messages.get(id).bytes.length }));
    },
    deleteMessage(messageId) { messages.delete(Number(messageId)); },
    async close() {},
  });
}

module.exports = {
  METHODS, MAX_READ_BYTES, CAPTION_LIMIT, StorageAdapterError, Phase0Error,
  assertStorageAdapter, buildCaption, createTelegramAdapter, createMemoryAdapter,
};
