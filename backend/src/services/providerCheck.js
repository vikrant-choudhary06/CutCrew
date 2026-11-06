// Weekly end-to-end provider check (search -> match -> stream -> real video
// bytes) for every installed provider, run as a separate process so a slow
// provider can't block the server. The latest report is shown on the admin page.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SAMPLE_MOVIES = 'tt1375666|Inception|2010;tt0816692|Interstellar|2014;tt15354916|Jawan|2023;tt12844910|Pathaan|2023';
const reportDir = () => process.env.PROVIDER_CHECK_DIR ? path.resolve(process.env.PROVIDER_CHECK_DIR) : path.resolve(__dirname, '../../.local/provider-check');
const REPORT = 'provider-health-weekly.json';
const ANIME_REPORT = 'anime-health-weekly.json';
const SOURCES_REPORT = 'sources-health-weekly.json';
let running = null;

function runScript(args, env, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: path.resolve(__dirname, '../..'), env, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', code => { clearTimeout(timer); resolve(code === 0); });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

function run({ timeoutMs = 45 * 60000 } = {}) {
  if (running) return running;
  running = (async () => {
    fs.mkdirSync(reportDir(), { recursive: true });
    // Every installed provider is checked, not only the ones enabled for playback.
    const env = { ...process.env };
    delete env.ENABLED_PROVIDERS;
    const movies = await runScript(['scripts/check-providers.cjs', `--movies=${SAMPLE_MOVIES}`, '--timeout=45000', '--candidates=4',
      `--report-dir=${reportDir()}`, `--report=${REPORT}`], env, timeoutMs);
    // Anime sources: ten popular shows, episode 1.
    const anime = await runScript(['scripts/check-anime.cjs', `--report-dir=${reportDir()}`, `--report=${ANIME_REPORT}`], process.env, 20 * 60000);
    // Every playback source (Stremio add-ons and vega-style providers). Sources that
    // fail two weekly checks in a row are switched off until they pass again.
    const playback = await runScript(['scripts/check-sources.cjs', `--report-dir=${reportDir()}`, `--report=${SOURCES_REPORT}`, '--update-state'], process.env, 30 * 60000);
    return movies && anime && playback;
  })().finally(() => { running = null; });
  return running;
}

// Last playback-source check, and which sources are switched off.
function latestSources() {
  try {
    const report = JSON.parse(fs.readFileSync(path.join(reportDir(), SOURCES_REPORT), 'utf8'));
    const state = require('./streamSources').sourceState();
    // Sources the weekly check switched off, shown as an alert on the admin page.
    const alerts = Object.entries(state).filter(([, s]) => s?.disabled)
      .map(([id, s]) => `${id} is switched off: nothing played in ${s.failures} weekly checks in a row (last ${String(s.lastChecked || '').slice(0, 10)})`);
    return { checkedAt: report.checkedAt, titles: report.titles, alerts,
      bySource: Object.fromEntries(Object.entries(report.bySource || {}).map(([id, s]) => [id, { verified: s.verified, checked: s.checked, statuses: s.statuses, formats: s.formats, off: Boolean(state[id]?.disabled), failedChecks: state[id]?.failures || 0 }])) };
  } catch {
    return null;
  }
}

// Short summary of the last anime check for the admin health view.
function latestAnime() {
  try {
    const report = JSON.parse(fs.readFileSync(path.join(reportDir(), ANIME_REPORT), 'utf8'));
    return { checkedAt: report.checkedAt, providers: report.providers, verified: report.verified, checked: report.checked,
      failed: (report.results || []).filter(r => r.status !== 'media-verified').map(r => ({ title: r.title || r.anilistId, status: r.status })) };
  } catch {
    return null;
  }
}

// Short summary for the admin health view: which providers delivered real video.
function latest() {
  try {
    const report = JSON.parse(fs.readFileSync(path.join(reportDir(), REPORT), 'utf8'));
    const byProvider = {};
    for (const r of report.results || []) {
      const entry = byProvider[r.provider] ||= { verified: 0, checked: 0, statuses: {} };
      entry.checked++;
      if (r.status === 'media-verified') entry.verified++;
      entry.statuses[r.status] = (entry.statuses[r.status] || 0) + 1;
    }
    return { checkedAt: report.checkedAt, sampleMovies: (report.sampleTitles || []).map(t => t.title), working: report.verifiedProviders || [], byProvider };
  } catch {
    return null;
  }
}

module.exports = { run, latest, latestAnime, latestSources, running: () => Boolean(running) };
