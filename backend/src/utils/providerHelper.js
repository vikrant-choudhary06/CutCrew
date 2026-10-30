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
function getProviderContext(signal) {
  const client = axios.create({ timeout: 10000, signal });
  return {
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
function getAvailableProvidersLocal({ includeUnverified = false } = {}) {
  if (!fs.existsSync(distDir)) return [];
  const configured = process.env.ENABLED_PROVIDERS?.split(',').map(s => s.trim()).filter(Boolean);
  const defaults = require('../../../provider/provider-policy.json').defaultProviders;
  const enabled = configured || (includeUnverified ? null : defaults);
  const providers = fs.readdirSync(distDir, { withFileTypes: true })
    .filter(item => item.isDirectory() && fs.existsSync(path.join(distDir, item.name, 'stream.js')))
    .map(item => item.name).filter(name => !enabled || enabled.includes(name));
  return providers.sort((a, b) => enabled ? enabled.indexOf(a) - enabled.indexOf(b) : a.localeCompare(b));
}
module.exports = { getProviderContext, getAvailableProvidersLocal, loadProvider };
