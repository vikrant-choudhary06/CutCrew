#!/usr/bin/env node
// Audio check: for each title, every enabled source is run (as playback does),
// the audio tracks of what it found are listed, and the stream and track that
// playback would pick are shown for Hindi and for English.
//
//   node scripts/check-audio.cjs [--titles="tt123|Name|2024[|season|episode][|IN]";...] [--client=web|app]
const sources = require('../src/services/streamSources');
const audio = require('../src/services/audioTracks');

const DEFAULT_TITLES = [
  'tt26735683|Toxic|2026|||IN', 'tt10698680|K.G.F: Chapter 2|2022|||IN', 'tt16539454|Pushpa 2: The Rule|2024|||IN', 'tt15327088|Kantara|2022|||IN',
  'tt4154796|Avengers: Endgame|2019', 'tt15398776|Oppenheimer|2023', 'tt0816692|Interstellar|2014', 'tt15354916|Jawan|2023|||IN',
  'tt10919420|Squid Game|2021|1|1', 'tt6468322|Money Heist|2017|1|1', 'tt0903747|Breaking Bad|2008|1|1',
].join(';');
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const client = arg('client') === 'app' ? 'app' : 'web';
const titles = (arg('titles') || DEFAULT_TITLES).split(';').map(entry => {
  const [imdb_id, title, year, season, episode, country] = entry.split('|');
  if (!/^tt\d{5,12}$/.test(imdb_id || '') || !title) return null;
  const series = season && episode;
  return { imdb_id, title, original_title: title, release_year: Number(year) || null, title_type: series ? 'TV Series' : 'Movie',
    season: series ? Number(season) : undefined, episode: series ? Number(episode) : undefined, countries: country === 'IN' ? ['India'] : [] };
}).filter(Boolean).slice(0, 20);
const order = sources.sourceOrder();
// Provider libraries print a lot; only this script's lines are shown.
const out = console.log.bind(console);
console.log = console.info = console.warn = console.error = console.debug = () => {};
const describe = s => `${s.provider}/${s.type}${s.height ? '/' + s.height + 'p' : ''}${s.hevc ? '/heavy' : ''}`;

(async () => {
  const summary = [];
  for (const title of titles) {
    const label = title.season ? `${title.title} S${title.season}E${title.episode}` : title.title;
    const runs = await Promise.all(order.map(source => sources.runSource(source, { ...title, movie: title })));
    // What the answer had in time, then what the background inspection added.
    const inTime = runs.reduce((n, r) => n + r.streams.filter(s => s.audioTracks?.length).length, 0);
    await Promise.all(runs.map(r => r.inspection));
    out(`  tracks read in time: ${inTime}, after background inspection: ${runs.reduce((n, r) => n + r.streams.filter(s => s.audioTracks?.length).length, 0)}`);
    const all = sources.rank(sources.dedupe(runs.flatMap(r => r.streams)), order, { client, indian: sources.isIndian(title) });
    out(`\n=== ${label}  (${all.length} streams, ${client})`);
    for (const run of runs) {
      if (!run.streams.length) { out(`  ${run.source.padEnd(15)} -  ${run.skipped || run.error || 'nothing found'}`); continue; }
      for (const s of run.streams.slice(0, 4)) {
        const tracks = s.audioTracks?.length ? s.audioTracks.map(t => t.label).join(', ') : s.type === 'hls' ? '(HLS, no separate audio)' : '(not read)';
        out(`  ${run.source.padEnd(15)} ${describe(s).padEnd(28)} ${tracks}`);
      }
    }
    const pick = lang => {
      const [first] = audio.withChoice(audio.preferLanguage(all, lang, { client }), lang, client);
      if (!first) return { lang, stream: 'none' };
      const track = first.audioTracks?.find(t => t.index === first.audioIndex);
      return { lang, stream: describe(first), track: track ? track.label : '(unknown: file default)', matched: first.audioMatched ?? null };
    };
    // Files whose tracks were not read in time: read once more with a longer limit, to see why.
    for (const run of runs) {
      const missed = run.streams.find(s => s.type !== 'hls' && !s.audioTracks?.length);
      if (!missed) continue;
      const started = Date.now();
      const tracks = await audio.readTracks(missed, { timeoutMs: 20000 });
      out(`  retry ${run.source}: ${tracks.length ? tracks.map(x => x.label).join(', ') : 'still nothing'} after ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
    const hi = pick('hi'), en = pick('en');
    const hindiAnywhere = all.some(s => audio.playableLanguages(s, client).includes('hi'));
    out(`  -> Hindi preference:   ${hi.stream}  plays ${hi.track}${hi.matched === false ? '  (Hindi not found, notice shown)' : ''}`);
    out(`  -> English preference: ${en.stream}  plays ${en.track}${en.matched === false ? '  (English not found)' : ''}`);
    summary.push({ title: label, streams: all.length, withTracks: all.filter(s => s.audioTracks?.length).length, hindiAnywhere, hindi: hi, english: en });
  }
  out('\nSUMMARY');
  for (const s of summary) {
    out(`${s.title.padEnd(26)} streams ${String(s.streams).padStart(2)} | tracks read ${String(s.withTracks).padStart(2)} | Hindi found: ${s.hindiAnywhere ? 'yes' : 'no '} | hi -> ${s.hindi.track} | en -> ${s.english.track}`);
  }
  process.exit(0);
})().catch(error => { out(error); process.exit(1); });
