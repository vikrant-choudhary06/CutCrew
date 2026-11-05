// Weekly end-to-end provider check (search -> match -> stream -> real video
// bytes) for every installed provider, run as a separate process so a slow
// provider can't block the server. The latest report is shown on the admin page.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SAMPLE_MOVIES = 'tt1375666|Inception|2010;tt0816692|Interstellar|2014;tt15354916|Jawan|2023;tt12844910|Pathaan|2023';
const reportDir = () => process.env.PROVIDER_CHECK_DIR ? path.resolve(process.env.PROVIDER_CHECK_DIR) : path.resolve(__dirname, '../../.local/provider-check');
const REPORT = 'provider-health-weekly.json';
let running = null;

function run({ timeoutMs = 45 * 60000 } = {}) {
  if (running) return running;
  running = new Promise(resolve => {
    fs.mkdirSync(reportDir(), { recursive: true });
    // Every installed provider is checked, not only the ones enabled for playback.
    const env = { ...process.env };
    delete env.ENABLED_PROVIDERS;
    const child = spawn(process.execPath, ['scripts/check-providers.cjs', `--movies=${SAMPLE_MOVIES}`, '--timeout=45000', '--candidates=4',
      `--report-dir=${reportDir()}`, `--report=${REPORT}`], { cwd: path.resolve(__dirname, '../..'), env, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', code => { clearTimeout(timer); resolve(code === 0); });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
  }).finally(() => { running = null; });
  return running;
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

module.exports = { run, latest, running: () => Boolean(running) };
