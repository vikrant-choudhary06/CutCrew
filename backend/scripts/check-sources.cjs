#!/usr/bin/env node
// End-to-end check of every playback source (vega, Stremio and Doom-style):
// find streams for real titles, then read real video bytes. Sources run in
// parallel per title, with the same time limits as playback.
//   node scripts/check-sources.cjs [--titles="tt1375666|Inception|2010;tt0903747|Breaking Bad|2008|1|1"]
//     [--sources=desiflix,moviebox] [--report-dir=dir] [--report=name.json] [--update-state]
// --update-state (used by the weekly job) records failures per source: a source
// with no playable stream for SOURCE_AUTO_DISABLE_AFTER weekly checks in a row
// (default 2) is skipped by playback until a later check passes.
const fs = require('fs');
const path = require('path');
const sources = require('../src/services/streamSources');

const DEFAULT_TITLES = 'tt15354916|Jawan|2023;tt12844910|Pathaan|2023;tt1375666|Inception|2010;tt0816692|Interstellar|2014;tt0903747|Breaking Bad|2008|1|1';
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const titles = (arg('titles') || DEFAULT_TITLES).split(';').map(entry => {
  const [imdb_id, title, year, season, episode] = entry.split('|');
  if (!/^tt\d{5,12}$/.test(imdb_id || '') || !title) return null;
  const series = season && episode;
  return { imdb_id, title, original_title: title, release_year: Number(year) || null, title_type: series ? 'TV Series' : 'Movie', season: series ? Number(season) : undefined, episode: series ? Number(episode) : undefined };
}).filter(Boolean).slice(0, 40);
const chosen = (arg('sources') || sources.sourceOrder({ includeOff: true }).join(',')).split(',').map(s => s.trim()).filter(Boolean);
const reportDir = path.resolve(arg('report-dir') || path.join(__dirname, '../.local/provider-check'));
const reportName = (arg('report') || 'sources-health.json').replace(/[^\w.-]/g, '');

(async () => {
  const results = [];
  for (const title of titles) {
    const label = title.season ? `${title.title} S${title.season}E${title.episode}` : title.title;
    const runs = await Promise.all(chosen.map(source => sources.runSource(source, { ...title, movie: title }, Number(arg("timeout")) > 0 ? { timeoutMs: Number(arg("timeout")) } : {})));
    for (const run of runs) {
      const entry = {
        source: run.source, title: label, imdbId: title.imdb_id,
        status: run.streams.length ? 'media-verified' : run.skipped ? 'skipped' : run.error === 'timed out' ? 'timed-out' : run.error ? 'error' : 'no-stream',
        streams: run.streams.length, formats: [...new Set(run.streams.map(s => s.type))],
        qualities: [...new Set(run.streams.map(s => s.quality).filter(Boolean))],
        audio: [...new Set(run.streams.flatMap(s => s.audio || []))], ms: run.ms, ...(run.error ? { error: String(run.error).slice(0, 200) } : {}),
      };
      results.push(entry);
      console.log(JSON.stringify(entry));
    }
  }
  const bySource = {};
  for (const r of results) {
    const s = bySource[r.source] ||= { verified: 0, checked: 0, statuses: {}, formats: [], audio: [] };
    // Skipped titles (e.g. new films for Internet Archive) are not failures.
    if (r.status !== 'skipped') s.checked++;
    if (r.status === 'media-verified') s.verified++;
    s.statuses[r.status] = (s.statuses[r.status] || 0) + 1;
    s.formats = [...new Set([...s.formats, ...r.formats])]; s.audio = [...new Set([...s.audio, ...r.audio])];
  }
  const report = { checkedAt: new Date().toISOString(), titles: titles.map(t => t.title), sources: chosen, bySource, results };
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, reportName), JSON.stringify(report, null, 2));

  if (process.argv.includes('--update-state')) {
    const limit = Number(process.env.SOURCE_AUTO_DISABLE_AFTER) || 2;
    const file = sources.stateFile();
    let state = {};
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
    for (const [source, summary] of Object.entries(bySource)) {
      if (!summary.checked) continue;
      const failures = summary.verified ? 0 : (state[source]?.failures || 0) + 1;
      state[source] = { failures, disabled: failures >= limit, lastChecked: report.checkedAt, lastVerified: summary.verified ? report.checkedAt : state[source]?.lastVerified || null };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  }
  console.log(JSON.stringify({ report: path.join(reportDir, reportName), bySource: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, `${v.verified}/${v.checked}`])) }));
  process.exit(0);
})().catch(error => { console.error(error.message); process.exit(1); });
