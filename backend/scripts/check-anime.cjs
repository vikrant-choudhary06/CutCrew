#!/usr/bin/env node
// End-to-end check of the anime sources: AniList title -> provider match ->
// episode stream -> real video bytes. Writes a JSON report.
//   node scripts/check-anime.cjs [--ids=21,16498] [--episode=1] [--report-dir=dir] [--report=name.json]
const fs = require('fs');
const path = require('path');
const anime = require('../src/services/animeService');
const anilist = require('../src/services/anilist');

// Popular long-running and finished shows (AniList ids), episode 1 by default.
const DEFAULT_IDS = [21, 16498, 101922, 1535, 151807, 140960, 127230, 154587, 113415, 20];
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const ids = (arg('ids') || DEFAULT_IDS.join(',')).split(',').map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 30);
const episode = Number(arg('episode') || 1);
const reportDir = path.resolve(arg('report-dir') || path.join(__dirname, '../.local/provider-check'));
const reportName = (arg('report') || 'anime-health.json').replace(/[^\w.-]/g, '');

const timeout = (ms, label) => new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out')), ms));

// First media segment of an HLS stream (or the start of an MP4) must be video.
async function probe(stream) {
  const headers = { 'User-Agent': 'Mozilla/5.0', ...(stream.headers || {}) };
  const get = (url, extra = {}) => fetch(url, { headers: { ...headers, ...extra }, signal: AbortSignal.timeout(20000) });
  let url = stream.link;
  if (stream.type === 'hls') {
    let text = await (await get(url)).text();
    if (!text.includes('#EXTM3U')) return { ok: false, reason: 'not-a-playlist' };
    let lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (text.includes('#EXT-X-STREAM-INF')) {
      url = new URL(lines[0], url).href;
      text = await (await get(url)).text();
      lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    }
    if (!lines.length) return { ok: false, reason: 'empty-playlist' };
    url = new URL(lines[0], url).href;
  }
  const response = await get(url, { Range: 'bytes=0-65535' });
  const bytes = Buffer.from(await response.arrayBuffer());
  const ts = bytes[0] === 0x47, mp4 = bytes.subarray(4, 8).toString() === 'ftyp';
  return { ok: ts || mp4, reason: ts ? 'ts-bytes' : mp4 ? 'mp4-bytes' : `unexpected-${response.status}` };
}

(async () => {
  const results = [];
  for (const id of ids) {
    const started = Date.now();
    const entry = { anilistId: id, episode, title: '', status: 'failed', provider: '', subtitles: [], detail: '' };
    try {
      const info = await anilist.details(id);
      entry.title = info.title;
      const result = await Promise.race([anime.play(id, episode), timeout(90000, 'playback lookup')]);
      entry.provider = result.provider;
      entry.match = result.match?.exact ? 'artwork-id' : 'title';
      entry.subtitles = result.streams[0].subtitles.map(s => s.language);
      const check = await probe(result.streams[0]);
      entry.status = check.ok ? 'media-verified' : 'stream-broken';
      entry.detail = check.reason;
    } catch (error) {
      entry.status = error.status === 503 ? 'playback-off' : error.status === 404 ? 'not-found' : 'failed';
      entry.detail = [error.message, ...(error.problems || [])].join(' | ').slice(0, 300);
    }
    entry.durationMs = Date.now() - started;
    results.push(entry);
    console.log(JSON.stringify(entry));
  }
  const report = {
    checkedAt: new Date().toISOString(), providers: anime.status().providers, episode,
    results, verified: results.filter(r => r.status === 'media-verified').length, checked: results.length,
  };
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, reportName), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: path.join(reportDir, reportName), verified: report.verified, checked: report.checked }));
  process.exit(0);
})().catch(error => { console.error(error.message); process.exit(1); });
