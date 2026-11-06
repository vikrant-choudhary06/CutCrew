const { test } = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
test('4khdhub metadata accepts absolute URLs and extracts IMDb identity', async () => {
  const { getMeta } = require('../../provider/dist/4khdhub/meta');
  let requested;
  const result = await getMeta({ link: 'https://source.example/movie/inception', providerContext: {
    getBaseUrl: async () => 'https://source.example',
    cheerio, axios: { get: async url => {
      requested = url; return { data: '<h1 class="page-title"> Inception (2010) </h1><a href="https://www.imdb.com/title/tt1375666/">IMDb</a>' };
    } },
  } });
  assert.equal(requested, 'https://source.example/movie/inception');
  assert.equal(result.title, 'Inception (2010)'); assert.equal(result.imdbId, 'tt1375666');
});
