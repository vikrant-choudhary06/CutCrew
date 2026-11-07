const test = require('node:test');
const assert = require('node:assert');
const { lengthFits, runtimeOf } = require('../src/services/lengthCheck');
const { storedSources } = require('../src/services/storedPlayback');

test('a song or trailer filed under a movie does not fit; the film does', () => {
  assert.equal(lengthFits(211, { runtimeMinutes: 192 }), false);
  assert.equal(lengthFits(192 * 60, { runtimeMinutes: 192 }), true);
  assert.equal(lengthFits(211, {}), false); // no listed length: a movie is at least 40 min
  assert.equal(lengthFits(95 * 60, {}), true);
  assert.equal(lengthFits(null, { runtimeMinutes: 120 }), true); // unknown length cannot be judged
  assert.equal(lengthFits(6 * 3600, { runtimeMinutes: 120 }), false); // another, much longer film
});

test('episodes and anime allow short and double episodes', () => {
  assert.equal(lengthFits(23 * 60, { runtimeMinutes: 24, episode: true }), true);
  assert.equal(lengthFits(90 * 60, { runtimeMinutes: 45, episode: true }), true);
  assert.equal(lengthFits(3 * 60, { runtimeMinutes: 45, episode: true }), false);
  assert.equal(lengthFits(3 * 60, { episode: true }), true); // short anime with no listed length
});

test('the episode length wins over the show length', () => {
  assert.equal(runtimeOf({ runtime_minutes: 45 }, { runtime_minutes: 22 }), 22);
  assert.equal(runtimeOf({ runtime_minutes: 45 }, null), 45);
  assert.equal(runtimeOf({}, null), null);
});

test('a stored file far from the title length is not offered', async () => {
  const repo = { findReadyVersions: async () => [
    { id: '6af44f8e-e9f1-4327-9e22-fa9761136171', quality: '480p', durationSeconds: 211, edition: 'original', audioLanguages: [] },
    { id: '7bf44f8e-e9f1-4327-9e22-fa9761136172', quality: '1080p', durationSeconds: 191 * 60, edition: 'original', audioLanguages: [] },
  ] };
  const events = [];
  const list = await storedSources({ imdbId: 'tt27530512', runtimeMinutes: 192 }, { config: { enabled: true, ticketTtlMs: 60000 }, repo, log: e => events.push(e) });
  assert.deepEqual(list.map(s => s.quality), ['1080p']);
  assert.equal(events[0].event, 'stored-length-mismatch');
});
