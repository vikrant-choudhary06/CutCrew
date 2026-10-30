const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const originalGet = axios.get;
let requests = 0;
axios.get = async url => {
  requests++;
  assert.equal(url, 'https://raw.githubusercontent.com/Zenda-Cross/vega-providers/refs/heads/main/urls.json');
  return { data: { Vega: { url: 'https://video.example' }, drive: { url: 'https://drive.example' } } };
};
const { getProviderContext } = require('../src/utils/providerHelper');
after(() => { axios.get = originalGet; delete process.env.PROVIDER_BASE_URLS; });
test('current provider registry is cached across provider lookups', async () => {
  const context = getProviderContext();
  assert.equal(await context.getBaseUrl('Vega'), 'https://video.example');
  assert.equal(await context.getBaseUrl('drive'), 'https://drive.example');
  assert.equal(requests, 1);
});
test('explicit provider URL overrides work without a registry request', async () => {
  process.env.PROVIDER_BASE_URLS = JSON.stringify({ rive: 'https://override.example' });
  assert.equal(await getProviderContext().getBaseUrl('rive'), 'https://override.example');
  assert.equal(requests, 1);
  delete process.env.PROVIDER_BASE_URLS;
});
test('provider SHA-1 compatibility uses the real crypto implementation', async () => {
  assert.equal(await getProviderContext().Aes.sha1('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
});

test('default providers are limited to the live-verified shortlist', () => {
  const { getAvailableProvidersLocal } = require('../src/utils/providerHelper');
  assert.deepEqual(getAvailableProvidersLocal(), ['4khdhub', 'vega']);
  assert.ok(getAvailableProvidersLocal({ includeUnverified: true }).length > 2);
  process.env.ENABLED_PROVIDERS = 'vega,autoEmbed';
  try { assert.deepEqual(getAvailableProvidersLocal(), ['vega', 'autoEmbed']); }
  finally { delete process.env.ENABLED_PROVIDERS; }
});
