// Real-provider browser preview on a disposable database; never uses account cookies.
const db = require('../src/config/db');
process.env.ENABLED_PROVIDERS = '4khdhub,vega';
const out = message => process.stdout.write(message + '\n');
console.log = console.warn = console.error = () => {};
const nativeFetch = global.fetch;
global.fetch = (input, options = {}) => {
  const headers = new Headers(options.headers || input?.headers);
  headers.delete('Cookie'); headers.delete('Authorization');
  return nativeFetch(input, { ...options, headers, credentials: 'omit' });
};
const helper = require('../src/utils/providerHelper');
const getContext = helper.getProviderContext;
helper.getProviderContext = signal => {
  const context = getContext(signal);
  context.axios.interceptors.request.use(config => {
    config.headers.delete('Cookie'); config.headers.delete('Authorization'); return config;
  });
  return context;
};
const { ensureMovie } = require('../src/services/movieService');
async function main() {
  await db({ embedded: true });
  await Promise.all(['tt1375666', 'tt0944947'].map(ensureMovie));
  const app = require('../src/app');
  const server = app.listen(5001, '127.0.0.1', () => out('Real-provider preview ready at http://localhost:5001'));
  const shutdown = async () => { server.closeAllConnections(); server.close(); await db.close(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
main().catch(error => { out(error.message); process.exit(1); });
