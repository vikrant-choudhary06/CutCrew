// Disposable embedded PostgreSQL preview, public sample-media adapter only.
const db = require('../src/config/db');
const { Movie } = require('../src/models');
const helper = require('../src/utils/providerHelper');
const sampleMp4 = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
const shortEpisodes = process.env.PREVIEW_SHORT_EPISODES === '1';
const sampleHls = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
helper.getAvailableProvidersLocal = () => ['sample'];
helper.loadProvider = (_provider, module) => module === 'stream' ? {
  getStream: async ({ link }) => [{ link, server: 'Public sample', type: link.includes('m3u8') ? 'hls' : link.includes('webm') ? 'mkv' : 'mp4' }],
} : {};
async function start() {
  await db({ embedded: true });
  await Movie.create([
    ...(process.env.PREVIEW_CONVERTED === '1' ? [{imdb_id:'tt0000003',title:'Public Sample Converted Movie',title_type:'Movie',metadata_complete:true,release_year:2026,rating:9,vote_count:101,provider_name:'sample',defaultStreamLink:'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm'}] : []),
    { imdb_id: 'tt0000001', title: 'Public Sample Movie', title_type: 'Movie', metadata_complete: true,
      release_year: 2026, rating: 8, vote_count: 100, genres: ['Action'], country: ['India'],
      plot: 'Public sample media used to verify MP4 playback. This record exists only in a temporary test database.',
      provider_name: 'sample', defaultStreamLink: sampleMp4 },
    { imdb_id: 'tt0000002', title: 'Public Sample Series', title_type: 'TV Series', metadata_complete: true,
      release_year: 2026, rating: 8, vote_count: 100,
      plot: 'Public HLS test media used to verify seasons, episode navigation and adaptive playback.',
      provider_name: 'sample', seasons: [
        { season_number: 1, episodes: [{ episode_number: 1, title: 'First sample', link: shortEpisodes ? sampleMp4 : sampleHls },
          { episode_number: 2, title: 'MP4 sample', link: sampleMp4 }] },
        { season_number: 2, episodes: [{ episode_number: 1, title: 'Second season sample', link: sampleHls }] },
      ] },
  ]);
  const app = require('../src/app');
  const port = Number(process.env.PORT) || 5000;
  const server = app.listen(port, '127.0.0.1', error => {if(error){console.error('Preview port is unavailable');db.close().finally(()=>{process.exitCode=1});return;}console.log(`Disposable PostgreSQL preview ready on http://localhost:${port}`)});
  const shutdown = async () => { server.closeAllConnections(); server.close(); await db.close(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
start().catch(error => { console.error(error.message); process.exit(1); });
