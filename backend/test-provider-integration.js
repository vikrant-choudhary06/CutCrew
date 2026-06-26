require('dotenv').config();
const { fetchAndAttachProviderLinks } = require('./src/services/providerService');

async function run() {
  const movieData = {
    imdb_id: 'tt1375666', // Inception
    title: 'Inception',
    release_date: '2010-07-16',
    title_type: 'movie'
  };

  console.log("Testing fetchAndAttachProviderLinks...");
  const result = await fetchAndAttachProviderLinks(movieData);
  console.log("Result:", JSON.stringify(result, null, 2));
}

run();
