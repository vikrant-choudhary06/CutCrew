// /api/anime: the anime section. Catalogue from AniList, playback from the
// anime providers (see services/animeService.js).
const router = require('express').Router();
const anilist = require('../services/anilist');
const anime = require('../services/animeService');
const { presentStreams } = require('../services/mediaService');

const PLAY_MS = 20 * 60000;
const played = new Map(), pending = new Map();
const text = value => (typeof value === 'string' ? value : '');

router.get('/browse', async (req, res, next) => {
  try {
    const kind = text(req.query.kind) || 'trending', genre = text(req.query.genre);
    const page = Number(req.query.page || 1), perPage = Number(req.query.limit || 24);
    if (!Number.isInteger(page) || page < 1 || page > 50 || !Number.isInteger(perPage) || perPage < 1 || perPage > 50) {
      return res.status(400).json({ message: 'Invalid page' });
    }
    const result = await anilist.browse({ kind, genre, page, perPage });
    res.set('Cache-Control', 'public, max-age=300').json({ status: 'success', source: 'anilist', data: result.items, page, hasMore: result.hasMore });
  } catch (error) { next(error); }
});

router.get('/search', async (req, res, next) => {
  try {
    const query = text(req.query.q).trim();
    if (!query || query.length > 100) return res.status(400).json({ message: 'Type a title to search' });
    res.json({ status: 'success', source: 'anilist', data: await anilist.search(query) });
  } catch (error) { next(error); }
});

router.get('/status', (_req, res) => res.json(anime.status()));

router.get('/:id', async (req, res, next) => {
  try {
    const data = await anilist.details(req.params.id);
    res.set('Cache-Control', 'public, max-age=300').json({ status: 'success', data: { ...data, playback: anime.status().playback && anime.providerIds().length > 0 } });
  } catch (error) { next(error); }
});

router.get('/:id/play', async (req, res, next) => {
  try {
    const id = Number(req.params.id), episode = Number(req.query.episode || 1);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: 'Invalid anime' });
    if (!Number.isInteger(episode) || episode < 1 || episode > 10000) return res.status(400).json({ message: 'Choose a valid episode' });
    const exclude = text(req.query.exclude).split(',').filter(Boolean).slice(0, 10);
    // Dubbed streams start in this audio language (default Hindi).
    const language = require('../services/audioTracks').preferredLanguage(text(req.query.lang));
    const key = `${id}:${episode}:${language}:${[...exclude].sort().join(',')}`;
    const hit = played.get(key);
    let result;
    if (req.query.refresh !== '1' && hit && hit.until > Date.now()) result = hit.value;
    else {
      if (!pending.has(key)) {
        pending.set(key, anime.play(id, episode, { exclude, language }).then(value => {
          if (played.size > 500) played.delete(played.keys().next().value);
          played.set(key, { value, until: Date.now() + PLAY_MS });
          return value;
        }).finally(() => pending.delete(key)));
      }
      result = await pending.get(key);
    }
    res.set('Cache-Control', 'no-store').json({ streams: presentStreams(result.streams), provider: result.provider, cached: result === hit?.value });
  } catch (error) {
    if (error.problems) console.warn('Anime playback failed', req.params.id, req.query.episode, error.problems.join('; '));
    next(error);
  }
});

module.exports = router;
