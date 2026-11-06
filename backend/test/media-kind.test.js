// The relay checks the first bytes when a source mislabels video segments
// (AnimeParadise sends TS segments as image/jpeg, text/html, text/css…).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { mediaKind, firstChunk } = require('../src/services/mediaService');

test('media is recognised by its first bytes', () => {
  const ts = Buffer.alloc(376); ts[0] = 0x47; ts[188] = 0x47;
  assert.equal(mediaKind(ts), 'video/mp2t');
  assert.equal(mediaKind(Buffer.from('\0\0\0\x18ftypisom', 'latin1')), 'video/mp4');
  assert.equal(mediaKind(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0])), 'video/x-matroska');
  assert.equal(mediaKind(Buffer.from('ID3\x04', 'latin1')), 'audio/aac');
  assert.equal(mediaKind(Buffer.from('<!doctype html><html>', 'latin1')), null);
  assert.equal(mediaKind(Buffer.alloc(0)), null);
});

test('the first chunk is read and can be put back for piping', async () => {
  const stream = Readable.from([Buffer.from([0x47, 1, 2]), Buffer.from([3, 4])]);
  const first = await firstChunk(stream);
  assert.deepEqual([...first], [0x47, 1, 2]);
  stream.unshift(first);
  const all = [];
  for await (const chunk of stream) all.push(...chunk);
  assert.deepEqual(all, [0x47, 1, 2, 3, 4]);
});
