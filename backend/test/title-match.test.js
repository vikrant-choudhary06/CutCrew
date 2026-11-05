// Provider listings carry release details around the title. Matching must
// recover the title, yet never accept a different film.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matches } = require('../src/services/providerService');

const movie = (title, year, type = 'Movie') => ({ imdb_id: 'tt0000001', title, release_year: year, title_type: type });
const accepts = (m, title, extra = {}) => assert.equal(matches(m, { title, ...extra }, {}), true, `${m.title} should accept: ${title}`);
const rejects = (m, title, extra = {}) => assert.equal(matches(m, { title, ...extra }, {}), false, `${m.title} should reject: ${title}`);

test('titles wrapped in release details are recognised', () => {
  const inception = movie('Inception', 2010);
  accepts(inception, 'Inception (2010) BluRay [Hindi (ORG 5.1) & English] 4K 1080p 720p');
  accepts(inception, '⭐ 8.4 Hindi, English, Dual Audio Inception Dual Audio Download 4K UHD');
  accepts(inception, ' Inception Inception (2010) ');
  accepts(inception, 'Inception 2010 Movie', { type: 'movie' });
  accepts(inception, 'Inception 4k ');
  accepts(movie('Jawan', 2023), 'Download Jawan – Netflix (2023) Hindi ORG. DD5.1 [Extended Version]');
  accepts(movie('Jawan', 2023), 'Jawan 2023 Hindi Download 2160p WEB-DL');
  accepts(movie('Pathaan', 2023), 'Pathaan 2023 Hindi 5.1ch Movie BluRay 1080p');
  accepts(movie('Interstellar', 2014), 'Interstellar 2014 IMAX Dual Audio [Hindi ORG 5.1 – Eng 5.1] 1080p');
  accepts(movie('Blade Runner 2049', 2017), 'Blade Runner 2049 (2017) BluRay');
  accepts(movie('1917', 2019), '1917 (2019) Dual Audio');
  accepts(movie('Mad Max: Fury Road', 2015), 'Mad Max: Fury Road (2015) Hindi');
});

test('different films with overlapping names are rejected', () => {
  const jawan = movie('Jawan', 2023);
  rejects(jawan, 'Kuriyan Jawan Bapu Preshaan (2021) WEB-DL');
  rejects(jawan, 'Raat Jawan Hai S01 (2024) Hindi Complete');
  rejects(jawan, 'Jawaan (2017) HDRip Hindi Dubbed');
  rejects(jawan, 'Hai Jawani Toh Ishq Hona Hai (2026)');
  rejects(movie('Inception', 2010), 'Inception 2 (2010)');
  rejects(movie('Mad Max: Fury Road', 2015), 'Mad Max (1979)');
  rejects(movie('Inception', 2010), '', { type: 'series' });
});

test('year and ID conflicts always win', () => {
  rejects(movie('Inception', 2010), 'Inception (2011)');
  rejects(movie('Inception', 2010), 'Inception', { year: 2011 });
  assert.equal(matches(movie('Inception', 2010), { imdbId: 'tt0111161', title: 'Inception' }, {}), false);
});

test('series words decide type; a wrong "series" label on a dated movie is overruled', () => {
  accepts(movie('Inception', 2010), 'Inception (2010) BluRay [Hindi] 4K', { type: 'series' });
  accepts(movie('Jawan', 2023), 'Download Jawan – Netflix (2023) Hindi', { type: 'series' });
  accepts(movie('Game of Thrones', 2011, 'TV Series'), 'Game of Thrones Season 1 (2011) Hindi');
  rejects(movie('Game of Thrones', 2011, 'TV Series'), 'Game of Thrones (2011) Movie', { type: 'movie' });
  rejects(movie('Inception', 2010), 'Inception Season 1 (2010)');
});
