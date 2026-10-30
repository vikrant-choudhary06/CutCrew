// Telegram storage Phase 3: bounded disk cache of verified video blocks
// (telegramintegration.md §12). Telegram is the storage; this is temporary.
//
// - Keys are (asset, part, block). Ready assets never change, so a key's bytes
//   never change either.
// - Writes go to a .tmp file and are renamed when complete; leftovers from a
//   crash are deleted at startup and never served.
// - Total size stays under maxBytes. Least-recently-used blocks are evicted,
//   except blocks that are currently being read.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE = /^(\d{1,5})-(\d{1,7})\.blk$/;

class BlockCache {
  constructor({ dir, maxBytes }) {
    if (!dir) throw new Error('cache dir required');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('maxBytes must be a positive integer');
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.entries = new Map(); // key -> { size, used }
    this.pins = new Map();    // key -> active readers
    this.total = 0;
    this.stats = { hits: 0, misses: 0, writes: 0, evictions: 0, skipped: 0, corrupt: 0 };
    this.ready = null;
  }

  static key(assetId, partNumber, blockIndex) { return `${assetId}/${partNumber}-${blockIndex}`; }
  fileFor(key) { return path.join(this.dir, key + '.blk'); }

  // Rebuilds the index from disk and removes incomplete writes.
  init() {
    this.ready ||= (async () => {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      for (const asset of await fs.readdir(this.dir, { withFileTypes: true })) {
        const assetDir = path.join(this.dir, asset.name);
        if (!asset.isDirectory() || !UUID.test(asset.name)) continue;
        for (const name of await fs.readdir(assetDir)) {
          const file = path.join(assetDir, name);
          if (name.endsWith('.tmp')) { await fs.rm(file, { force: true }); continue; }
          if (!FILE.test(name)) continue;
          const stat = await fs.stat(file).catch(() => null);
          if (!stat?.isFile()) continue;
          const key = `${asset.name}/${name.slice(0, -4)}`;
          this.entries.set(key, { size: stat.size, used: stat.mtimeMs });
          this.total += stat.size;
        }
      }
      await this.evict(0);
    })();
    return this.ready;
  }

  pin(key) { this.pins.set(key, (this.pins.get(key) || 0) + 1); }
  unpin(key) { const n = (this.pins.get(key) || 1) - 1; if (n) this.pins.set(key, n); else this.pins.delete(key); }

  // Returns the cached bytes only if they still match the expected checksum.
  async get(key, { size, sha256 } = {}) {
    await this.init();
    const entry = this.entries.get(key);
    if (!entry) { this.stats.misses++; return null; }
    const bytes = await fs.readFile(this.fileFor(key)).catch(() => null);
    if (!bytes || (size !== undefined && bytes.length !== size) || (sha256 && createHash('sha256').update(bytes).digest('hex') !== sha256)) {
      this.stats.corrupt++;
      await this.remove(key);
      this.stats.misses++;
      return null;
    }
    entry.used = Date.now();
    this.stats.hits++;
    return bytes;
  }

  // Stores verified bytes. Returns false (and stores nothing) if the quota
  // can't be met without evicting blocks that are in use.
  async put(key, bytes) {
    await this.init();
    // Making room and reserving it happen one put at a time; otherwise
    // parallel puts could each see free space and overshoot the quota.
    const step = (this.reserving || Promise.resolve()).then(async () => {
      if (this.entries.has(key)) { this.entries.get(key).used = Date.now(); return 'exists'; }
      if (bytes.length > this.maxBytes || !(await this.evict(bytes.length))) { this.stats.skipped++; return 'full'; }
      this.entries.set(key, { size: bytes.length, used: Date.now(), writing: true });
      this.total += bytes.length;
      return 'reserved';
    });
    this.reserving = step.catch(() => {}); // one failure must not block later puts
    const reserved = await step;
    if (reserved === 'exists') return true;
    if (reserved === 'full') return false;
    const file = this.fileFor(key);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, bytes, { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, file);
      this.entries.get(key).writing = false;
      this.stats.writes++;
      return true;
    } catch (error) {
      await fs.rm(temp, { force: true });
      this.entries.delete(key); this.total -= bytes.length;
      throw error;
    }
  }

  // Frees space for `incoming` bytes by evicting unpinned, least-recently-used blocks.
  async evict(incoming) {
    if (this.total + incoming <= this.maxBytes) return true;
    const candidates = [...this.entries].filter(([key, e]) => !this.pins.has(key) && !e.writing).sort((a, b) => a[1].used - b[1].used);
    for (const [key] of candidates) {
      if (this.total + incoming <= this.maxBytes) break;
      await this.remove(key);
      this.stats.evictions++;
    }
    return this.total + incoming <= this.maxBytes;
  }

  async remove(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.total -= entry.size;
    await fs.rm(this.fileFor(key), { force: true }).catch(() => {});
  }

  usage() { return { bytes: this.total, maxBytes: this.maxBytes, blocks: this.entries.size, pinned: this.pins.size, ...this.stats }; }
}

module.exports = { BlockCache };
