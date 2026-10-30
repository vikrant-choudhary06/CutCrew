const router = require('express').Router();
const { ensureMovie } = require('../services/movieService');
router.post('/', async (req, res, next) => {
  try {
    res.json({ status: 'success', data: await ensureMovie(req.body.imdb_id) });
  } catch (error) { next(error); }
});
module.exports = router;
