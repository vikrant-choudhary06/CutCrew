// Telegram storage Phase 4: offer Ready stored videos to the normal Play flow.
// Each Ready version becomes an ordinary MP4 source whose link is a signed,
// expiring ticket for that exact immutable asset. Any problem (switch off,
// database slow or failing) returns no sources so the providers take over.
const { videoStorageConfig } = require('../config/videoStorage');
const tickets = require('./storedMediaTicket');
const { lengthFits } = require('./lengthCheck');

const STORAGE_PROVIDER = 'cutcrew-storage';

let languageNames;
function languageLabel(codes) {
  try { languageNames ||= new Intl.DisplayNames(['en'], { type: 'language' }); } catch { /* fall back to codes */ }
  return codes.map(code => { try { return languageNames?.of(code) || code; } catch { return code; } }).join(', ');
}

async function withTimeout(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('STORED_LOOKUP_TIMEOUT')), ms); })]); }
  finally { clearTimeout(timer); }
}

async function storedSources({ imdbId, season = null, episode = null, quality, runtimeMinutes = null } = {}, {
  config = videoStorageConfig(),
  repo = require('./videoStorageRepository'),
  timeoutMs = 4000,
  log = () => {},
} = {}) {
  if (!config.enabled) return [];
  let versions;
  try {
    versions = await withTimeout(repo.findReadyVersions({ imdbId, season: season ?? undefined, episode: episode ?? undefined, quality }), timeoutMs);
  } catch (error) {
    // Storage must never block playback: fall back to providers.
    log({ event: 'stored-lookup-failed', code: error.code || error.message });
    return [];
  }
  // A stored file far from the title's length is something else with the same
  // name: leave it out, so the providers' sources play instead.
  const fitting = versions.filter(asset => {
    const fits = lengthFits(asset.durationSeconds, { runtimeMinutes, episode: season != null });
    if (!fits) log({ event: 'stored-length-mismatch', assetId: asset.id, seconds: Math.round(asset.durationSeconds || 0), runtimeMinutes });
    return fits;
  });
  return fitting.map(asset => ({
    link: `/api/stored-media/${tickets.sign(asset.id, { ttlMs: config.ticketTtlMs })}`,
    type: 'mp4',
    server: 'CutCrew storage',
    quality: asset.quality,
    language: asset.audioLanguages?.length ? languageLabel(asset.audioLanguages) : undefined,
    edition: asset.edition !== 'original' ? asset.edition : undefined,
    stored: true,
    remuxed: false,
    subtitles: [],
  }));
}

module.exports = { storedSources, STORAGE_PROVIDER };
