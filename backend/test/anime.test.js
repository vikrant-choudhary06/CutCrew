const test = require('node:test');
const assert = require('node:assert/strict');
const anilist = require('../src/services/anilist');
const anime = require('../src/services/animeService');

test('AniList media becomes a CutCrew item keyed by anilist id', () => {
  const item = anilist.toItem({
    id: 140960, idMal: 50265, title: { english: 'SPY x FAMILY', romaji: 'SPY×FAMILY', native: 'SPY×FAMILY' },
    format: 'TV', status: 'FINISHED', episodes: 12, seasonYear: 2022, averageScore: 85, genres: ['Action'],
    coverImage: { extraLarge: 'https://img/x.jpg' }, bannerImage: 'https://img/b.jpg',
    description: 'A spy<br>needs a <i>family</i>.<br><br>(Source: Crunchyroll)',
  });
  assert.equal(item.imdb_id, 'anilist:140960');
  assert.equal(item.anilist_id, 140960);
  assert.equal(item.kind, 'anime');
  assert.equal(item.title, 'SPY x FAMILY');
  assert.equal(item.title_type, 'Anime');
  assert.equal(item.rating, 8.5);
  assert.equal(item.plot, 'A spy\nneeds a family.');
  assert.equal(anilist.toItem({ id: 1, title: {} }), null, 'a title is required');
  assert.equal(anilist.toItem({ id: 5, format: 'MOVIE', title: { romaji: 'Kimi no Na wa.' } }).title_type, 'Anime Movie');
});

test('only aired episodes count as available', () => {
  assert.equal(anilist.availableEpisodes({ status: 'RELEASING', nextAiringEpisode: { episode: 1181 }, episodes: null }), 1180);
  assert.equal(anilist.availableEpisodes({ status: 'FINISHED', episodes: 12 }), 12);
  assert.equal(anilist.availableEpisodes({ status: 'FINISHED', format: 'MOVIE', episodes: null }), 1);
  assert.equal(anilist.availableEpisodes({ status: 'NOT_YET_RELEASED', episodes: 12 }), 0);
});

test('current season follows the calendar', () => {
  assert.deepEqual(anilist.currentSeason(new Date('2026-11-06T00:00:00Z')), { season: 'FALL', seasonYear: 2026 });
  assert.deepEqual(anilist.currentSeason(new Date('2026-02-01T00:00:00Z')), { season: 'WINTER', seasonYear: 2026 });
});

test('provider results match an AniList entry by its artwork id first', () => {
  assert.equal(anime.anilistIdFromImage('https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx140960-Kb6R5nYQfjmP.jpg'), 140960);
  assert.equal(anime.anilistIdFromImage('https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/b21-tXrNsBvDZJjA.jpg'), 21);
  assert.equal(anime.anilistIdFromImage('https://media.kitsu.app/anime/45398/poster.jpg'), null);
  const spy = { anilist_id: 140960, title: 'SPY x FAMILY', romaji_title: 'SPY×FAMILY', release_year: 2022 };
  const results = [
    { id: 'p:cour2', title: 'SPY x FAMILY Cour 2', thumbnailUrl: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx142838-a.jpg' },
    { id: 'p:s1', title: 'SPY x FAMILY', thumbnailUrl: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx140960-b.jpg' },
  ];
  assert.equal(anime.pickResult(spy, results).id, 'p:s1');
  // A same-named entry whose artwork belongs to another AniList title is rejected.
  assert.equal(anime.pickResult(spy, [{ id: 'p:other', title: 'SPY x FAMILY', thumbnailUrl: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx158927-c.jpg' }]), null);
  // Without artwork ids, an exact title (and year, when given) is accepted.
  assert.equal(anime.pickResult(spy, [{ id: 'p:plain', title: 'Spy × Family', year: 2022 }]).id, 'p:plain');
  assert.equal(anime.pickResult(spy, [{ id: 'p:old', title: 'Spy x Family', year: 2019 }]), null);
});

test('search terms include the series name without a season suffix', () => {
  const terms = anime.searchTerms({ title: 'Frieren: Beyond Journey’s End Season 2', romaji_title: 'Sousou no Frieren 2nd Season' });
  assert.ok(terms.includes('Frieren: Beyond Journey’s End'));
  assert.ok(terms.includes('Sousou no Frieren'));
});

test('provider streams become player streams with usable subtitles only', () => {
  const stream = anime.toStream({
    sourceUrl: 'https://stream.example/m3u8?url=x', isHLS: true, quality: 'auto', language: 'sub', headers: { Referer: 'https://example/' },
    subtitles: [
      { url: 'https://stream.example/captions?url=en', label: 'English', language: 'en', format: 'vtt' },
      { url: 'https://stream.example/sub.ass', label: 'Styled', language: 'en', format: 'ass' },
    ],
  }, 'animeparadise');
  assert.equal(stream.type, 'hls');
  assert.equal(stream.server, 'AnimeParadise');
  assert.equal(stream.quality, 'Auto');
  assert.deepEqual(stream.subtitles, [{ uri: 'https://stream.example/captions?url=en', language: 'en', title: 'English', type: 'vtt' }]);
});

test('anime playback can be switched off', async () => {
  const saved = process.env.ANIME_PLAYBACK;
  process.env.ANIME_PLAYBACK = 'false';
  try {
    await assert.rejects(anime.play(140960, 1), error => error.status === 503);
    assert.equal(anime.status().playback, false);
  } finally {
    if (saved === undefined) delete process.env.ANIME_PLAYBACK; else process.env.ANIME_PLAYBACK = saved;
  }
});

test('ANIME_PROVIDERS keeps only installed providers, in order', () => {
  const saved = process.env.ANIME_PROVIDERS;
  process.env.ANIME_PROVIDERS = 'missing,animeparadise';
  try {
    assert.deepEqual(anime.providerIds(), ['animeparadise']);
  } finally {
    if (saved === undefined) delete process.env.ANIME_PROVIDERS; else process.env.ANIME_PROVIDERS = saved;
  }
});

test('browse rejects unknown lists and genres', async () => {
  await assert.rejects(anilist.browse({ kind: 'nope' }), error => error.status === 400);
  await assert.rejects(anilist.browse({ kind: 'popular', genre: 'Hentai' }), error => error.status === 400);
  await assert.rejects(anilist.details('abc'), error => error.status === 400);
});
