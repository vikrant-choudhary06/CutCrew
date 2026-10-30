// Telegram storage Phase 4: the Play endpoint prefers Ready stored videos and
// falls back to providers. Movie, provider and repository calls are stubbed.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

const sourceProbe = require('../src/services/sourceProbe');
sourceProbe.filterPlayable = async streams => streams;
const { Movie } = require('../src/models');
const providers = require('../src/services/providerService');
// Installed before the app loads: the route keeps a reference to this function.
let resolveImpl;
providers.resolvePlayback = (...args) => resolveImpl(...args);
const repo = require('../src/services/videoStorageRepository');
const tickets = require('../src/services/storedMediaTicket');
const { storedSources } = require('../src/services/storedPlayback');

const TELEGRAM = { TELEGRAM_BOT_TOKEN: '123456789:' + 'x'.repeat(35), TELEGRAM_API_ID: '12345', TELEGRAM_API_HASH: 'a'.repeat(32), TELEGRAM_STORAGE_CHANNEL_ID: '-1001234567890' };
const saved = { ...process.env };
const enable = on => { Object.assign(process.env, TELEGRAM, { TELEGRAM_STORAGE_ENABLED: on ? 'true' : 'false' }); };

let providerCalls, lookups, versions, lookupImpl;
const asset = (extra = {}) => ({ id: randomUUID(), state: 'ready', imdbId: 'tt1375666', season: null, episode: null, quality: '1080p', edition: 'original', audioLanguages: ['hi', 'en'], ...extra });
function doc(extra = {}) { const m = { imdb_id: 'tt1375666', title: 'Inception', title_type: 'Movie', metadata_complete: true, release_year: 2010, seasons: [], ...extra }; m.toObject = () => ({ ...m }); return m; }

beforeEach(() => {
  enable(true);
  providerCalls = 0; lookups = []; versions = [];
  lookupImpl = async query => { lookups.push(query); return versions; };
  repo.findReadyVersions = (...args) => lookupImpl(...args);
  Movie.findOne = async () => doc();
  Movie.updateOne = async () => ({ matchedCount: 1 });
  resolveImpl = async () => { providerCalls++; return { streams: [{ link: 'https://video.example/a.mp4', type: 'mp4', server: 'Provider', headers: {}, subtitles: [] }], provider: 'sample', candidate: {} }; };
});
const app = require('../src/app');
const server = http.createServer(app);
const ready = new Promise(r => server.listen(0, '127.0.0.1', r));
after(() => { server.close(); process.env = saved; });
async function play(path) {
  await ready;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/movies/play/${path}`);
  return { status: response.status, body: await response.json() };
}

test('a Ready stored movie is returned first with a ticket bound to that asset, without calling providers', async () => {
  const a = asset(); versions = [a];
  const { status, body } = await play('tt1375666');
  assert.equal(status, 200);
  assert.equal(body.provider, 'cutcrew-storage'); assert.equal(body.stored, true);
  assert.equal(providerCalls, 0, 'providers are not searched');
  const [stream] = body.streams;
  assert.match(stream.link, /^\/api\/stored-media\/[\w-]+\.[\w-]+$/);
  assert.equal(tickets.verify(stream.link.split('/').pop()), a.id);
  assert.deepEqual([stream.type, stream.quality, stream.language, stream.remuxed], ['mp4', '1080p', 'Hindi, English', false]);
  assert.deepEqual(lookups[0], { imdbId: 'tt1375666', season: undefined, episode: undefined, quality: undefined });
});

test('several Ready versions become separate sources in the repository order', async () => {
  versions = [asset({ quality: '1080p' }), asset({ quality: '720p', audioLanguages: ['ta'], edition: 'extended' })];
  const { body } = await play('tt1375666?quality=720p');
  assert.deepEqual(body.streams.map(s => [s.quality, s.language, s.edition]), [['1080p', 'Hindi, English', undefined], ['720p', 'Tamil', 'extended']]);
  assert.equal(lookups[0].quality, '720p');
});

test('series episodes are looked up by season and episode', async () => {
  Movie.findOne = async () => doc({ title_type: 'TV Series', seasons: [{ season_number: 2, episodes: [{ episode_number: 5 }] }] });
  versions = [asset({ season: 2, episode: 5 })];
  const { body } = await play('tt1375666?season=2&episode=5');
  assert.equal(body.provider, 'cutcrew-storage');
  assert.deepEqual([lookups[0].season, lookups[0].episode], [2, 5]);
});

test('without a Ready version, or when the player excludes storage, providers are used', async () => {
  versions = [];
  let { body } = await play('tt1375666');
  assert.equal(body.provider, 'sample'); assert.equal(providerCalls, 1);
  versions = [asset()];
  ({ body } = await play('tt1375666?exclude=cutcrew-storage'));
  assert.equal(body.provider, 'sample'); assert.equal(lookups.length, 1, 'storage not consulted after exclusion');
});

test('with the switch off, storage is never consulted', async () => {
  enable(false); versions = [asset()];
  const { body } = await play('tt1375666');
  assert.equal(body.provider, 'sample'); assert.equal(lookups.length, 0);
});

test('a dropped Telegram connection is replaced and the read retried; other errors are not retried', async () => {
  const { createTelegramAdapter } = require('../src/services/videoStorageAdapter');
  const { configuration } = require('../src/services/telegramStorage');
  const doc = { id: { toString: () => '777' }, size: { toString: () => '100' } };
  let connects = 0;
  const sessions = [];
  const connect = async () => {
    const n = ++connects;
    let alive = true, reads = 0;
    const s = { n, isConnected: () => alive, close: async () => { alive = false; },
      message: async id => ({ id, document: doc }),
      reader: () => ({ read: async (o, l) => {
        reads++;
        if (n === 1 && reads === 2) { alive = false; throw new Error('Not connected'); } // connection drops mid-stream
        if (n === 2 && o === 50) throw Object.assign(new Error('bad'), { code: 'SOME_TELEGRAM_ERROR' });
        return Buffer.alloc(l, n);
      }, refresh: async () => {} }) };
    sessions.push(s);
    return s;
  };
  const adapter = createTelegramAdapter(configuration(TELEGRAM), { connect });
  const ref = { chatId: TELEGRAM.TELEGRAM_STORAGE_CHANNEL_ID, messageId: 5, size: 100 };
  assert.equal((await adapter.readRange(ref, 0, 10))[0], 1, 'first read on connection 1');
  assert.equal((await adapter.readRange(ref, 10, 10))[0], 2, 'dropped connection replaced, read retried on connection 2');
  assert.equal(connects, 2);
  await assert.rejects(adapter.readRange(ref, 50, 10), /bad/);
  assert.equal(connects, 2, 'a normal error on a live connection does not reconnect');
  await adapter.close();
});

test('a failing or slow storage lookup falls back to providers instead of blocking playback', async () => {
  lookupImpl = async () => { throw Object.assign(new Error('Query read timeout')); };
  assert.equal((await play('tt1375666')).body.provider, 'sample');
  const events = [];
  const slow = { findReadyVersions: () => new Promise(r => setTimeout(() => r([asset()]), 500)) };
  const started = Date.now();
  const sources = await storedSources({ imdbId: 'tt1375666' }, { repo: slow, timeoutMs: 50, log: e => events.push(e) });
  assert.deepEqual(sources, []); assert.ok(Date.now() - started < 400);
  assert.equal(events[0].code, 'STORED_LOOKUP_TIMEOUT');
});

test('stored availability lists Ready titles, is empty when off, and never blocks on a slow database', async () => {
  const express = require('express');
  const { createStoredAvailableRouter } = require('../src/routes/storedAvailable');
  const serve = async router => { const app = express(); app.use('/a', router); const s = http.createServer(app); await new Promise(r => s.listen(0, '127.0.0.1', r)); return s; };
  const get = async s => (await fetch(`http://127.0.0.1:${s.address().port}/a`)).json();
  let calls = 0;
  const on = await serve(createStoredAvailableRouter({ config: () => ({ enabled: true }), query: async () => { calls++; return { rows: [{ imdb_id: 'tt0000001' }, { imdb_id: 'tt0000002' }] }; } }));
  const off = await serve(createStoredAvailableRouter({ config: () => ({ enabled: false }), query: async () => { throw new Error('must not query'); } }));
  const slow = await serve(createStoredAvailableRouter({ config: () => ({ enabled: true }), query: () => new Promise(() => {}) }));
  try {
    assert.deepEqual((await get(on)).data, ['tt0000001', 'tt0000002']);
    await get(on); assert.equal(calls, 1, 'cached');
    assert.deepEqual((await get(off)).data, []);
    const t = Date.now(); assert.deepEqual((await get(slow)).data, []); assert.ok(Date.now() - t < 4500);
  } finally { for (const s of [on, off, slow]) { s.closeAllConnections(); s.close(); } }
});
