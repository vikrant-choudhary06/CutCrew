// APK / installer downloads: the download links point at
// /api/app/download/<platform>, which saves one row and redirects to GitHub.
const db = require('../config/db');
const live = require('./liveActivity');

const REPO = process.env.GITHUB_RELEASE_REPO || 'vikrant-choudhary06/CutCrew';
const FILES = { android: 'cutcrew.apk', windows: 'cutcrew-windows-setup.exe' };
const latestUrl = platform => `https://github.com/${REPO}/releases/latest/download/${FILES[platform]}`;

async function record(req, { platform, version = null, source = 'web' }) {
  const ip = live.cleanIp(req.ip);
  if (!ip) return;
  await db.query('INSERT INTO app_downloads (platform, version, source, ip, country, user_agent) VALUES ($1, $2, $3, $4, $5, $6)',
    [platform, /^\d+\.\d+\.\d+$/.test(version || '') ? version : null, ['web', 'app', 'landing'].includes(source) ? source : 'web',
      ip.slice(0, 64), live.countryOf(ip) || null, (req.get('user-agent') || '').slice(0, 300) || null]);
}

async function stats() {
  const [totals, versions, countries, days, recent] = await Promise.all([
    db.query(`SELECT platform, count(*)::int AS total, count(DISTINCT ip)::int AS people,
      count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS today,
      count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS week,
      count(*) FILTER (WHERE created_at > now() - interval '10 minutes')::int AS live
      FROM app_downloads GROUP BY platform`),
    db.query(`SELECT platform, coalesce(version, '?') AS version, source, count(*)::int AS total FROM app_downloads GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 30`),
    db.query(`SELECT coalesce(country, '?') AS country, count(*)::int AS total FROM app_downloads GROUP BY 1 ORDER BY 2 DESC LIMIT 20`),
    db.query(`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS total FROM app_downloads
      WHERE created_at > now() - interval '14 days' GROUP BY 1 ORDER BY 1`),
    db.query(`SELECT platform, version, source, ip, country, user_agent, created_at FROM app_downloads ORDER BY created_at DESC LIMIT 50`),
  ]);
  return { totals: totals.rows, versions: versions.rows, countries: countries.rows, days: days.rows, recent: recent.rows };
}

// Download counts GitHub keeps for each release file (cached for 10 minutes).
let github = { at: 0, value: null };
async function githubCounts() {
  if (Date.now() - github.at < 600000 && github.value) return github.value;
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=10`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CutCrew-admin' }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('GitHub ' + response.status);
    const releases = await response.json();
    const value = releases.map(r => ({ tag: r.tag_name, publishedAt: r.published_at,
      files: (r.assets || []).map(a => ({ name: a.name, downloads: a.download_count, sizeMb: Math.round(a.size / 1e6) })) }));
    github = { at: Date.now(), value };
    return value;
  } catch { return github.value; }
}

module.exports = { record, stats, githubCounts, latestUrl, FILES };
