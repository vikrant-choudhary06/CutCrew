// A host that ignores byte ranges: apps asking for a later part get a quick
// error (the player moves on) instead of the whole file from the start.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable } = require('node:stream');
const axios = require('axios');
const actualCreate = axios.create;
const bytes = Buffer.alloc(5000, 7);
// The fake host always answers 200 with the full file, whatever the range.
axios.create = () => ({ get: async () => ({ status: 200, headers: { 'content-type': 'video/x-matroska', 'content-length': String(bytes.length) }, data: Readable.from([bytes]) }) });
const media = require('../src/services/mediaService');
axios.create = actualCreate;

test('apps get an error, not the whole file, when a host cannot seek', async () => {
  const app = express(); app.get('/api/media', media.relay);
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const raw = base + media.signMedia('https://public.example/no-range.mkv', {}, 'raw');
    // The start of the file still plays.
    const first = await fetch(raw, { headers: { Range: 'bytes=0-' } });
    assert.equal(first.status, 200);
    assert.equal((await first.arrayBuffer()).byteLength, bytes.length);
    // A later part: fail fast.
    const later = await fetch(raw, { headers: { Range: 'bytes=4000-' } });
    assert.equal(later.status, 502);
    // The server's own conversion (website) still reads such files from the start.
    const original = base + media.signMedia('https://public.example/no-range.mkv', {}, 'original');
    const web = await fetch(original, { headers: { Range: 'bytes=4000-' } });
    assert.equal(web.status, 200);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test('apps get MKV files without an index (or on hosts without ranges) converted, others as they are', () => {
  const base = { link: 'https://public.example/a.mkv', type: 'mkv', headers: {}, subtitles: [] };
  const [plain, noIndex, stuck] = media.presentStreams([base, { ...base, link: 'https://public.example/b.mkv', noIndex: true }, { ...base, link: 'https://public.example/c.mkv', seekable: false }], { client: 'app' });
  assert.deepEqual([plain.type, plain.remuxed], ['mkv', false]);
  assert.deepEqual([noIndex.type, noIndex.remuxed], ['mp4', true]);
  assert.deepEqual([stuck.type, stuck.remuxed], ['mp4', true]);
  assert.equal(media.verifyToken(new URL(noIndex.link, 'http://x').searchParams.get('token')).format, 'mkv');
});
