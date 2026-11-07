const test = require('node:test');
const assert = require('node:assert');
const { readHeader, findCluster, openAt } = require('../src/services/mkvJump');

// A tiny MKV: EBML + Segment with Info (1 ms unit, 3600 s), then clusters every 600 s.
function info(seconds) {
  const d = Buffer.alloc(8); d.writeDoubleBE(seconds * 1000);
  const body = Buffer.concat([Buffer.from([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]), Buffer.from([0x44, 0x89, 0x88]), d]);
  return Buffer.concat([Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x80 | body.length]), body]);
}
function cluster(ms, pad) {
  const tc = Buffer.from([0xe7, 0x84, (ms >>> 24) & 255, (ms >>> 16) & 255, (ms >>> 8) & 255, ms & 255]);
  const body = Buffer.concat([tc, Buffer.alloc(pad, 0xaa)]);
  const size = Buffer.from([0x10 | 0, 0, 0, 0]); size.writeUInt32BE(0x10000000 | body.length);
  return Buffer.concat([Buffer.from([0x1f, 0x43, 0xb6, 0x75]), size, body]);
}
const header = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), info(3600)]);
const clusters = [0, 600, 1200, 1800, 2400, 3000].map(s => cluster(s * 1000, 50000));
const file = Buffer.concat([header, ...clusters]);

function fakeFetch(data) {
  return async (url, { headers }) => {
    const from = Number(/bytes=(\d+)-/.exec(headers.Range)[1]);
    return new Response(data.subarray(from), { status: 206, headers: { 'content-range': `bytes ${from}-${data.length - 1}/${data.length}` } });
  };
}

test('reads the header of an MKV without an index', () => {
  const h = readHeader(file);
  assert.equal(h.clusterAt, header.length);
  assert.equal(h.scale, 1e6);
  assert.equal(h.seconds, 3600);
  assert.equal(h.indexed, false);
});

test('finds the next cluster and its time, waiting when one is cut off', () => {
  const at = header.length + clusters[0].length + 100;
  const found = findCluster(file.subarray(at), 1e6);
  assert.equal(found.seconds, 1200);
  assert.deepEqual(findCluster(clusters[1].subarray(0, 6), 1e6), { more: true });
});

test('opens the file a little before the wanted time, with the header first', async () => {
  const jump = await openAt('http://x', 2000, { fetchImpl: fakeFetch(file) });
  assert.ok(jump.start <= 2000 && jump.start >= 1200, `start ${jump.start}`);
  const parts = [];
  for await (const chunk of jump.stream) parts.push(chunk);
  const out = Buffer.concat(parts);
  assert.ok(out.subarray(0, header.length).equals(header));
  assert.equal(findCluster(out.subarray(header.length), 1e6).seconds, jump.start);
});

test('leaves files with an index to ffmpeg', async () => {
  const cues = Buffer.concat([header, Buffer.from([0x1c, 0x53, 0xbb, 0x6b]), ...clusters]);
  assert.equal(await openAt('http://x', 2000, { fetchImpl: fakeFetch(cues) }), null);
});

test('a repeated jump starts straight from where the last one landed', async () => {
  let calls = 0;
  const counting = (inner => async (...args) => { calls++; return inner(...args); })(fakeFetch(file));
  const firstJump = await openAt('http://x', 2500, { fetchImpl: counting, key: 'film' });
  firstJump.stream.destroy();
  calls = 0;
  const again = await openAt('http://x', 2500, { fetchImpl: counting, key: 'film' });
  again.stream.destroy();
  assert.equal(again.start, firstJump.start);
  assert.equal(calls, 2);
});
