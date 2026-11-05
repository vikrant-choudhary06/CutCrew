// Run live provider diagnostics without a database or user credentials.
const fs = require('fs');
const path = require('path');
const express = require('express');
const { getProviderContext, getAvailableProvidersLocal, loadProvider } = require('../src/utils/providerHelper');
const { bounded, matches, normalizeMetadata, normalizeStreams, episodeFor } = require('../src/services/providerService');
const { relay, presentStreams, signMedia } = require('../src/services/mediaService');
const output = message => process.stdout.write(message + '\n');
// Diagnostics deliberately use no Cookie/Authorization values, including adapter-supplied ones.
const nativeFetch = global.fetch;
global.fetch = (input, options = {}) => {
  const headers = new Headers(options.headers || input?.headers);
  headers.delete('cookie'); headers.delete('authorization');
  return nativeFetch(input, { ...options, headers, credentials: 'omit' });
};
// Adapters often log full request configurations. Keep the report free of tokens/cookies.
console.log = console.warn = console.error = () => {};
const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
const requested = args.providers?.split(',');
const providers = getAvailableProvidersLocal({ includeUnverified: true }).filter(name => !requested || requested.includes(name));
const listed = (args.movies || '').split(';').filter(Boolean).map(entry => { const [imdb_id, title, year] = entry.split('|'); return { imdb_id, title, release_year: Number(year), title_type: 'Movie', kind: 'movie' }; });
const titles = (listed.length ? listed : args['imdb-id'] ? [
  { imdb_id: args['imdb-id'], title: args.title, release_year: Number(args.year), title_type: 'Movie', kind: 'movie' },
] : [
  { imdb_id: 'tt1375666', title: 'Inception', release_year: 2010, title_type: 'Movie', kind: 'movie' },
  { imdb_id: 'tt0944947', title: 'Game of Thrones', release_year: 2011, title_type: 'TV Series', kind: 'series', season: 1, episode: 1 },
]).filter(title => !args.content || title.kind === args.content);
if (listed.some(title => !/^tt\d{5,12}$/.test(title.imdb_id) || !title.title || !Number.isInteger(title.release_year))) throw new Error('--movies expects id|title|year;...');
if (args['imdb-id'] && (!/^tt\d{5,12}$/.test(args['imdb-id']) || !args.title || !Number.isInteger(Number(args.year)))) {
  throw new Error('Custom movie checks require --imdb-id=tt... --title=... --year=2026');
}
const results = [];
async function readPrefix(url, max = 65536) {
  const response = await fetch(url, { headers: { Range: 'bytes=0-65535' }, signal: AbortSignal.timeout(15000) });
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (size < max) {
      const next = await reader.read();
      if (next.done) break;
      const part = Buffer.from(next.value).subarray(0, max - size);
      chunks.push(part); size += part.length;
    }
  } finally { await reader.cancel(); }
  return { status: response.status, type: response.headers.get('content-type') || '', body: Buffer.concat(chunks) };
}
async function probe(stream, root) {
  const headers = Object.fromEntries(Object.entries(stream.headers || {}).filter(([name]) => !/^(cookie|authorization)$/i.test(name)));
  const presented = presentStreams([{ ...stream, headers }])[0];
  if (!presented) return { verified: false, reason: 'unsupported-media-url' };
  let url = root + (stream.type==='mkv'?signMedia(stream.link,headers,'original'):presented.link);
  for (let depth = 0; depth < 3; depth++) {
    const response = await readPrefix(url);
    if (response.status >= 400) return { verified: false, reason: 'media-http-' + response.status };
    const text = response.body.toString('utf8');
    if (text.trimStart().startsWith('#EXTM3U')) {
      const next = text.split(/\r?\n/).find(line => line.trim() && !line.startsWith('#'));
      if (!next) return { verified: false, reason: 'empty-playlist' };
      url = new URL(next, url).href;
      continue;
    }
    const bytes = response.body;
    const mp4 = bytes.subarray(0, 64).includes(Buffer.from('ftyp')) || bytes.subarray(0, 64).includes(Buffer.from('styp'));
    const ts = bytes[0] === 0x47 && (bytes.length < 189 || bytes[188] === 0x47);
    const webm = bytes.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
    return { verified: mp4 || ts || webm, reason: mp4 ? 'mp4-bytes' : ts ? 'mpeg-ts-bytes' : webm ? 'webm-or-matroska-bytes' : 'unrecognized-media-bytes',
      contentType: response.type, bytesRead: bytes.length };
  }
  return { verified: false, reason: 'playlist-depth-limit' };
}
async function inspect(provider, movie, root) {
  const started = Date.now();
  const result = { provider, content: movie.kind, title: movie.title, imdbId: movie.imdb_id,
    status: 'not-tested', searchResults: 0, matchingMetadata: 0, sourceCount: 0, networkErrors: {} };
  try {
    await bounded(async signal => {
      const context = getProviderContext(signal, provider);
      context.axios.interceptors.request.use(config => {
        config.headers.delete('Cookie'); config.headers.delete('Authorization');
        return config;
      });
      context.axios.interceptors.response.use(response => response, error => {
        const code = error.response?.status || error.code || 'network';
        result.networkErrors[code] = (result.networkErrors[code] || 0) + 1;
        throw error;
      });
      const originalBase = context.getBaseUrl;
      context.getBaseUrl = async name => {
        try { return await originalBase(name); }
        catch (error) { result.configurationError = error.message; throw error; }
      };
      const posts = loadProvider(provider, 'posts'), metaModule = loadProvider(provider, 'meta'), streamModule = loadProvider(provider, 'stream');
      if (!posts.getSearchPosts || !metaModule.getMeta || !streamModule.getStream) {
        result.status = 'incomplete-adapter'; return;
      }
      result.status = 'search-empty';
      const search = await posts.getSearchPosts({ searchQuery: movie.title, page: 1, providerValue: provider, signal, providerContext: context });
      const list = Array.isArray(search) ? search : [];
      result.searchResults = list.length;
      if (!list.length) return;
      result.status = 'no-identity-match';
      const candidateLimit = Math.min(20, Math.max(1, Number(args.candidates) || 4));
      const candidates = await Promise.all(list.slice(0, candidateLimit).map(async item => {
        try {
          const meta = await metaModule.getMeta({ link: item.link, provider: provider, signal, providerContext: context });
          (result.candidates ||= []).push({ searchTitle: item.title, title: meta?.title,
            imdbId: meta?.imdbId, type: meta?.type, linkGroups: meta?.linkList?.length });
          if (meta && matches(movie, meta, item)) { result.matchingMetadata++; return meta; }
          return null;
        } catch { return null; }
      }));
      if (args['metadata-only'] === 'true') { result.status = 'metadata-inspected'; return; }
      for (const metadata of candidates.filter(Boolean)) {
        result.status = 'no-content-links';
        const candidate = await normalizeMetadata(movie, metadata, provider, context);
        if (!candidate) continue;
        const links = movie.kind === 'series' ? [episodeFor(candidate, movie.season, movie.episode)?.link] : candidate.links;
        if (!links?.some(Boolean)) { result.status = 'requested-episode-missing'; continue; }
        for (const link of links.filter(Boolean).slice(0, 2)) {
          result.status = 'stream-empty';
          const streams = normalizeStreams(await streamModule.getStream({ link,
            type: movie.kind === 'series' ? (provider === 'guardahd' ? 'tv' : 'series') : 'movie', signal, providerContext: context }));
          result.sourceCount += streams.length;
          if (!streams.length) continue;
          result.status = 'sources-resolved';
          result.formats = [...new Set(streams.map(stream => stream.type))];
          result.probes = [];
          for (const stream of streams.slice(0, 2)) {
            try { result.probes.push(await probe(stream, root)); }
            catch (error) { result.probes.push({ verified: false, reason: error.name === 'TimeoutError' ? 'probe-timeout' : 'probe-error' }); }
          }
          if (result.probes.some(probe => probe.verified)) { result.status = 'media-verified'; return; }
        }
      }
    }, Number(args.timeout || 25000));
  } catch (error) {
    result.status = error.message.includes('timed out') ? 'deadline-' + result.status : 'adapter-error';
    result.error = /timed out|interactive browser|No base URL/.test(error.message) ? error.message : error.code || 'adapter request failed';
  }
  result.durationMs = Date.now() - started;
  results.push(result);
  output(JSON.stringify(result));
}
async function main() {
  const app = express(); app.get('/api/media', relay);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const root = 'http://127.0.0.1:' + server.address().port;
  const jobs = providers.flatMap(provider => titles.map(movie => ({ provider, movie })));
  let index = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (index < jobs.length) {
      const job = jobs[index++]; await inspect(job.provider, job.movie, root);
    }
  }));
  server.closeAllConnections(); server.close();
  const report = { checkedAt: new Date().toISOString(), credentialFree: true, sampleTitles: titles, results,
    verifiedProviders: [...new Set(results.filter(result => result.status === 'media-verified').map(result => result.provider))] };
  const dir = args['report-dir'] ? path.resolve(args['report-dir']) : path.resolve(__dirname, '../../reports'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, args.report || 'provider-health.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  output(JSON.stringify({ report: file, checks: results.length, verifiedProviders: report.verifiedProviders }));
  process.exit(0);
}
main().catch(error => { output(JSON.stringify({ error: error.message })); process.exit(1); });
