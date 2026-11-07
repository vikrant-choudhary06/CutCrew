// Jump inside an MKV that has no index (Cues). Without one, ffmpeg reads the
// whole file up to the wanted time, so a jump to 1:25:00 downloads over an hour
// of video first. Instead: keep the file's header, guess the byte position from
// the length, find the next cluster there and continue from it.
const { Readable } = require('node:stream');

const CLUSTER = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
const CUES = Buffer.from([0x1c, 0x53, 0xbb, 0x6b]);
const INFO = Buffer.from([0x15, 0x49, 0xa9, 0x66]);
const SCALE = Buffer.from([0x2a, 0xd7, 0xb1]);
const DURATION = Buffer.from([0x44, 0x89]);
const HEAD_BYTES = 1048576;
const LOOK_BYTES = 8 * 1048576;

// An element size: the first byte's leading zeros give its length.
function vint(buf, pos) {
  const first = buf[pos];
  if (!first) return null;
  let length = 1, mask = 0x80;
  while (!(first & mask)) { mask >>= 1; length++; }
  if (pos + length > buf.length) return null;
  let value = first & (mask - 1);
  for (let i = 1; i < length; i++) value = value * 256 + buf[pos + i];
  return { value, length, unknown: value === 2 ** (7 * length) - 1 };
}
function uint(buf, pos, size) {
  let value = 0;
  for (let i = 0; i < size; i++) value = value * 256 + buf[pos + i];
  return value;
}

// Header facts from the first bytes: where the first cluster starts, the time
// unit, the length in seconds, and whether the file has an index after all.
function readHeader(head) {
  const clusterAt = head.indexOf(CLUSTER);
  if (clusterAt < 0) return null;
  const header = head.subarray(0, clusterAt);
  const infoAt = header.indexOf(INFO);
  if (infoAt < 0) return null;
  const infoSize = vint(header, infoAt + 4);
  if (!infoSize) return null;
  const info = header.subarray(infoAt + 4 + infoSize.length, Math.min(header.length, infoAt + 4 + infoSize.length + infoSize.value));
  let scale = 1e6;
  const scaleAt = info.indexOf(SCALE);
  if (scaleAt >= 0) {
    const size = vint(info, scaleAt + 3);
    if (size && size.value >= 1 && size.value <= 8) scale = uint(info, scaleAt + 3 + size.length, size.value) || scale;
  }
  let length = 0;
  const durationAt = info.indexOf(DURATION);
  if (durationAt >= 0) {
    const size = vint(info, durationAt + 2), at = durationAt + 2 + (size?.length || 0);
    if (size?.value === 8 && at + 8 <= info.length) length = info.readDoubleBE(at);
    else if (size?.value === 4 && at + 4 <= info.length) length = info.readFloatBE(at);
  }
  return { header, clusterAt, scale, seconds: length * scale / 1e9, indexed: header.includes(CUES) };
}

// The first cluster in buf whose timestamp can be read: { at, seconds }.
// `more` means a candidate was cut off at the end, so read more first.
function findCluster(buf, scale) {
  for (let at = buf.indexOf(CLUSTER); at >= 0; at = buf.indexOf(CLUSTER, at + 1)) {
    const size = vint(buf, at + 4);
    if (!size) return { more: true };
    const tc = at + 4 + size.length;
    if (tc + 2 > buf.length) return { more: true };
    if (buf[tc] !== 0xe7) continue;
    const tcSize = vint(buf, tc + 1);
    if (!tcSize) return { more: true };
    if (tcSize.value < 1 || tcSize.value > 8) continue;
    if (tc + 1 + tcSize.length + tcSize.value > buf.length) return { more: true };
    return { at, seconds: uint(buf, tc + 1 + tcSize.length, tcSize.value) * scale / 1e9 };
  }
  return null;
}

async function readFrom(url, offset, fetchImpl, signal) {
  const response = await fetchImpl(url, { headers: { Range: `bytes=${offset}-` }, signal });
  if (response.status !== 206 || !response.body) { await response.body?.cancel().catch(() => {}); return null; }
  const total = Number((response.headers.get('content-range') || '').split('/')[1]) || 0;
  return { reader: response.body.getReader(), total };
}

// A stream of the header plus the file from a cluster at or a little before
// `target` seconds, with that cluster's time; null when this file needs no
// help (it has an index) or the guess does not work out.
async function openAt(url, target, { fetchImpl = fetch, lead = 40, signal } = {}) {
  const first = await readFrom(url, 0, fetchImpl, signal);
  if (!first) return null;
  let head = Buffer.alloc(0);
  while (head.length < HEAD_BYTES) {
    const { value, done } = await first.reader.read();
    if (done) break;
    head = Buffer.concat([head, Buffer.from(value)]);
  }
  first.reader.cancel().catch(() => {});
  const info = readHeader(head);
  if (!info || info.indexed || !first.total || !(info.seconds > target) || info.seconds > 172800) return null;
  const body = first.total - info.clusterAt;
  let want = Math.max(0, target - lead);
  for (let tries = 0; tries < 4; tries++) {
    const offset = info.clusterAt + Math.floor(body * want / info.seconds);
    const part = await readFrom(url, offset, fetchImpl, signal);
    if (!part) return null;
    let buf = Buffer.alloc(0), found = null;
    while (buf.length < LOOK_BYTES) {
      const { value, done } = await part.reader.read();
      if (done) break;
      buf = Buffer.concat([buf, Buffer.from(value)]);
      found = findCluster(buf, info.scale);
      if (found && !found.more) break;
    }
    if (!found || found.more) { part.reader.cancel().catch(() => {}); return null; }
    if (found.seconds > target) {
      // Landed past the wanted point: step back by the overshoot and try again.
      part.reader.cancel().catch(() => {});
      want -= found.seconds - target + lead;
      if (want <= 0) return null;
      continue;
    }
    const reader = part.reader, rest = buf.subarray(found.at);
    async function* chunks() {
      try {
        yield info.header;
        yield rest;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          yield Buffer.from(value);
        }
      } finally { reader.cancel().catch(() => {}); }
    }
    return { start: found.seconds, stream: Readable.from(chunks(), { objectMode: false }) };
  }
  return null;
}

module.exports = { openAt, readHeader, findCluster, vint };
