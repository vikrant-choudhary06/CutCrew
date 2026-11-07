const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const distDir = path.resolve(__dirname, '../../../provider/dist');
const baseUrls = { expires: 0, data: null, pending: null };
let registryRetryAt = 0;
async function getBaseUrl(provider) {
  const overrides = JSON.parse(process.env.PROVIDER_BASE_URLS || '{}');
  if (overrides[provider]) return overrides[provider];
  if (Date.now() < registryRetryAt) throw new Error('Provider registry is unavailable; configure PROVIDER_BASE_URLS or PROVIDER_REGISTRY_URL');
  if (Date.now() > baseUrls.expires) {
    if (!baseUrls.pending) baseUrls.pending = axios.get(
      process.env.PROVIDER_REGISTRY_URL || 'https://raw.githubusercontent.com/Zenda-Cross/vega-providers/refs/heads/main/urls.json', { timeout: 8000 }
    ).then(({ data }) => {
      baseUrls.data = data;
      baseUrls.expires = Date.now() + 3600000;
    }).catch(error => { registryRetryAt = Date.now() + 60000; throw error; })
      .finally(() => { baseUrls.pending = null; });
    await baseUrls.pending;
  }
  const url = baseUrls.data?.[provider]?.url;
  if (!url) throw new Error('No base URL configured for provider ' + provider);
  return url;
}
// Per-provider settings for providers that read them (kvStore). Set in .env as
// PROVIDER_SETTINGS={"internetArchive":{"licenses":"publicDomain"}}; anything
// not set falls back to the provider's own default.
const savedSettings = new Map();
function providerSettings(provider) {
  try {
    const all = JSON.parse(process.env.PROVIDER_SETTINGS || '{}');
    return all && typeof all[provider] === 'object' && all[provider] ? all[provider] : {};
  } catch { return {}; }
}
function kvStoreFor(provider) {
  const own = () => { if (!savedSettings.has(provider)) savedSettings.set(provider, new Map()); return savedSettings.get(provider); };
  return {
    get: async key => (own().has(key) ? own().get(key) : providerSettings(provider)[key]),
    set: async (key, value) => { own().set(key, value); },
    delete: async key => { own().delete(key); },
  };
}
function getProviderContext(signal, provider = '') {
  const client = axios.create({ timeout: 10000, signal });
  return {
    kvStore: kvStoreFor(provider),
    axios: client, cheerio, getBaseUrl,
    commonHeaders: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
    Aes: { sha1: async input => crypto.createHash('sha1').update(String(input)).digest('hex') },
    openWebView: async () => { throw new Error('This provider requires an interactive browser challenge'); },
  };
}
function loadProvider(provider, moduleName) {
  if (!/^[a-zA-Z0-9_-]+$/.test(provider)) throw new Error('Invalid provider name');
  const target = path.join(distDir, provider, moduleName + '.js');
  return fs.existsSync(target) ? require(target) : {};
}
function getAvailableProvidersLocal({ includeUnverified = false, includeSwitchedOff = false } = {}) {
  if (!fs.existsSync(distDir)) return [];
  const configured = process.env.ENABLED_PROVIDERS?.split(',').map(s => s.trim()).filter(Boolean);
  const defaults = require('../../../provider/provider-policy.json').defaultProviders;
  const enabled = configured || (includeUnverified ? null : defaults);
  const providers = fs.readdirSync(distDir, { withFileTypes: true })
    .filter(item => item.isDirectory() && fs.existsSync(path.join(distDir, item.name, 'stream.js')))
    .map(item => item.name).filter(name => !enabled || enabled.includes(name))
    // Switched off in the admin panel.
    .filter(name => includeSwitchedOff || !require('../services/providerSwitches').isOff(name));
  return providers.sort((a, b) => enabled ? enabled.indexOf(a) - enabled.indexOf(b) : a.localeCompare(b));
}
module.exports = { getProviderContext, getAvailableProvidersLocal, loadProvider };
