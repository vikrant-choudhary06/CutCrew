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

// Needs the built providers (cd provider && npm run build); Docker builds them itself.
const built = require('node:fs').existsSync(require('node:path').join(__dirname, '../../provider/dist/4khdhub/stream.js'));
test('default providers are limited to the live-verified shortlist', { skip: !built && 'providers are not built' }, () => {
  const { getAvailableProvidersLocal } = require('../src/utils/providerHelper');
  assert.deepEqual(getAvailableProvidersLocal(), ['4khdhub', 'internetArchive']);
  process.env.ENABLED_PROVIDERS = 'internetArchive';
  try { assert.deepEqual(getAvailableProvidersLocal(), ['internetArchive']); }
  finally { delete process.env.ENABLED_PROVIDERS; }
});

test('providers read their own settings through kvStore', async () => {
  const { getProviderContext } = require('../src/utils/providerHelper');
  const saved = process.env.PROVIDER_SETTINGS;
  process.env.PROVIDER_SETTINGS = JSON.stringify({ internetArchive: { licenses: 'publicDomain' } });
  try {
    const archive = getProviderContext(undefined, 'internetArchive').kvStore;
    const other = getProviderContext(undefined, '4khdhub').kvStore;
    assert.equal(await archive.get('licenses'), 'publicDomain');
    assert.equal(await archive.get('sort'), undefined, 'unset keys fall back to the provider default');
    assert.equal(await other.get('licenses'), undefined, 'settings are per provider');
    await archive.set('sort', 'avg_rating');
    assert.equal(await getProviderContext(undefined, 'internetArchive').kvStore.get('sort'), 'avg_rating');
    await archive.delete('sort');
    assert.equal(await archive.get('sort'), undefined);
    process.env.PROVIDER_SETTINGS = 'not json';
    assert.equal(await archive.get('licenses'), undefined, 'a broken setting never crashes a provider');
  } finally {
    if (saved === undefined) delete process.env.PROVIDER_SETTINGS; else process.env.PROVIDER_SETTINGS = saved;
  }
});
