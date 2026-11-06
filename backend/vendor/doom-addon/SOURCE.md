# Doom-addon MovieBox provider (vendored)

- Project: Doom-addon (Stremio stream add-on), https://github.com/ummarm/Doom-addon
- Licence: GPL-3.0 (see `LICENSE`, copyright 2024 JK). `moviebox.js` stays under
  GPL-3.0: keep this folder's `LICENSE` with it and share changes to it under
  the same licence.
- Copied from: the local `movie_provider_2` folder (add-on version 3.0.17)
- Copied into CutCrew: 2026-11-06
- File: `moviebox.js` only. Its only dependency is `crypto-js` (in
  backend/package.json); it does not use `cheerio-without-node-native`.

## Changes made for CutCrew

- Request-signing keys are not kept in git. Copy `KEY_B64_DEFAULT` and
  `KEY_B64_ALT` from the Doom-addon `moviebox.js` into `.env` as
  `MOVIEBOX_KEY_B64` and `MOVIEBOX_KEY_B64_ALT`; without them MovieBox is off.
- The built-in TMDB API key was removed (`TMDB_API_KEY` from `.env` if wanted).
  `getStreams` takes two optional extra arguments, `imdbId` and
  `{ title, year, originalTitle }`. CutCrew passes the title it already knows
  and gets the TMDB id from Cinemeta, so no TMDB key is needed.

Pengu and Flix-Streams were copied earlier and removed again: Pengu now runs as
a Stremio add-on (STREMIO_ADDONS) and Flix-Streams used another person's link.

CutCrew loads this file from `backend/src/services/streamSources.js`
(the "doom" source kind).
