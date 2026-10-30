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
test('Rido metadata passes its stream adapter the JSON payload it expects', async () => {
  const { getMeta } = require('../../provider/dist/ridoMovies/meta');
  const result = await getMeta({ link: 'https://metadata.example/title', providerContext: {
    getBaseUrl: async () => 'https://source.example',
    axios: { get: async url => url.includes('/core/api/search') ?
      { data: { data: { items: [{ fullSlug: 'movies/inception' }] } } } :
      { data: { meta: { name: 'Inception', imdb_id: 'tt1375666', type: 'movie' } } } },
  } });
  assert.deepEqual(JSON.parse(result.linkList[0].directLinks[0].link),
    { baseUrl: 'https://source.example', slug: 'movies/inception', type: 'movie' });
});
