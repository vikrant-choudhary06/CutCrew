const fs = require('fs');
const path = require('path');
const axios = require('axios');

/**
 * Downloads an image from a URL and saves it locally.
 * @param {string} url - The remote image URL.
 * @param {string} imdbId - The IMDB ID used to name the file.
 * @param {string} type - "poster" or "backdrop".
 * @returns {Promise<string>} The local path to the image, or empty string if failed.
 */
async function downloadImage(url, imdbId, type = 'poster') {
  if (!url) return '';

  const dir = path.join(__dirname, '..', '..', 'public', 'images', type + 's');
  
  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Handle extension
  const extMatch = url.match(/\.(jpg|jpeg|png|webp|gif)/i);
  const ext = extMatch ? extMatch[1] : 'jpg';
  const fileName = `${imdbId}.${ext}`;
  const filePath = path.join(dir, fileName);
  const localUrl = `/images/${type}s/${fileName}`;

  // If already downloaded, return local path
  if (fs.existsSync(filePath)) {
    return localUrl;
  }

  try {
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      timeout: 10000,
    });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(localUrl));
      writer.on('error', (err) => {
        console.error(`Error saving image ${imdbId}:`, err);
        reject('');
      });
    });
  } catch (err) {
    console.error(`Failed to download image ${url}:`, err.message);
    return '';
  }
}

module.exports = { downloadImage };
