const https = require('https');
const http = require('http');

const genres = [
  "Action", "Adventure", "Animation", "Comedy", "Crime", 
  "Documentary", "Drama", "Family", "Fantasy", "History", 
  "Horror", "Music", "Mystery", "Romance", "Science Fiction", 
  "TV Movie", "Thriller", "War", "Western"
];

// Number of movies per genre to fetch safely (avoiding rate limits)
const LIMIT_PER_GENRE = 50; 
const SCRAPER_BASE_URL = 'https://cut-crew-all.onrender.com';
const LOCAL_API_URL = 'http://localhost:5000/api/movies/scrape';

// Helper to make HTTP requests
function makeRequest(url, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const options = { method, headers: {} };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
    }
    const req = lib.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runSeeder() {
  console.log('🚀 Starting Automated Movie Seeder...');
  
  let totalSaved = 0;

  for (const genre of genres) {
    console.log(`\n========================================`);
    console.log(`🎬 Fetching top ${LIMIT_PER_GENRE} movies for genre: ${genre}`);
    console.log(`========================================`);

    try {
      // 1. Fetch from Scraper
      const url = `${SCRAPER_BASE_URL}/search/genre/${encodeURIComponent(genre)}?limit=${LIMIT_PER_GENRE}`;
      const searchResults = await makeRequest(url);

      if (!Array.isArray(searchResults) || searchResults.length === 0) {
        console.log(`⚠️ No movies found for genre ${genre}`);
        continue;
      }

      // The API returns [ [ {node: { title: { id: "..." } } } ], { hasNextPage... } ]
      const moviesArray = searchResults[0];

      if (!Array.isArray(moviesArray) || moviesArray.length === 0) {
        console.log(`⚠️ No valid movie array found for genre ${genre}`);
        continue;
      }

      console.log(`✅ Found ${moviesArray.length} movies. Sending to local backend for saving...`);

      // 2. Loop through and save each to MongoDB via Backend API
      for (let i = 0; i < moviesArray.length; i++) {
        const item = moviesArray[i];
        // The ID is nested inside item.node.title.id
        const imdbId = item?.node?.title?.id;
        
        if (!imdbId) continue;

        try {
          const res = await makeRequest(LOCAL_API_URL, 'POST', { imdb_id: imdbId });
          console.log(`[${i + 1}/${moviesArray.length}] Saved: ${imdbId} -> Source: ${res.source || 'unknown'}`);
          totalSaved++;
        } catch (err) {
          console.error(`❌ Failed to save ${imdbId}: ${err.message}`);
        }

        // Delay 1 second to avoid killing the local backend / DB
        await sleep(1000); 
      }
    } catch (err) {
      console.error(`❌ Failed to fetch genre ${genre}: ${err.message}`);
    }

    // Delay 3 seconds between genres to be nice to Render API
    console.log(`⏳ Waiting 3 seconds before next genre...`);
    await sleep(3000);
  }

  console.log(`\n🎉 SEEDING COMPLETE! Successfully processed ${totalSaved} movies requests.`);
}

runSeeder();
