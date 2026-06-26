const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');

/**
 * Creates the provider context required by the provider modules.
 * This mimics the context provided by dev-server.js in cut-crew-providers.
 */
function getProviderContext() {
  let getBaseUrl = () => "";
  try {
    // Attempt to load getBaseUrl.js from the providers dist directory
    const getBaseUrlPath = path.join(__dirname, '../../../cut-crew-providers/dist/getBaseUrl.js');
    if (fs.existsSync(getBaseUrlPath)) {
      getBaseUrl = require(getBaseUrlPath).getBaseUrl;
    } else {
      console.warn("[ProviderHelper] getBaseUrl.js not found at " + getBaseUrlPath);
    }
  } catch (e) {
    console.warn("[ProviderHelper] Could not load getBaseUrl.js", e);
  }

  return {
    axios,
    cheerio,
    getBaseUrl,
    commonHeaders: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    Aes: {}, // Assuming Aes is not heavily used or can be mocked this way for now.
  };
}

/**
 * Returns the list of available providers from the dist directory.
 */
function getAvailableProvidersLocal() {
  const distDir = path.join(__dirname, '../../../cut-crew-providers/dist');
  if (!fs.existsSync(distDir)) {
    console.error("[ProviderHelper] dist directory not found at", distDir);
    return [];
  }

  return fs
    .readdirSync(distDir, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => item.name);
}

module.exports = {
  getProviderContext,
  getAvailableProvidersLocal
};
