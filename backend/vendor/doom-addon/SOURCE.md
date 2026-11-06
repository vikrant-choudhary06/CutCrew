# Doom-addon providers (vendored)

- Project: Doom-addon (Stremio stream add-on), GPL-3.0 (see `LICENSE`, copyright 2024 JK)
- Copied from: the `movie_provider_2` folder, add-on version 3.0.17. Its README says the
  provider files sync from upstream Nuvio provider repositories
  (D3adlyRocket/All-in-One-Nuvio, yoruix/nuvio-providers).
- Copied into CutCrew: 2026-11-06
- Files: `moviebox.js`, `pengu.js`, `flix_streams_emby.js`, `flix_streams_other.js`
- Licence: these four files stay under GPL-3.0. Keep this folder's `LICENSE`
  with them, and share changes to them under the same licence.

## Changes made for CutCrew

- `pengu.js`: the built-in Pengu link carried another person's `auth_token`. It
  was removed. Pengu runs only when `PENGU_MANIFEST_URL` (or `PENGU_AUTH_TOKEN`)
  is set in `.env` with your own Pengu configuration.
- `flix_streams_emby.js`, `flix_streams_other.js`: the built-in link was another
  person's personal Flix-Streams page (`flixnest.app/.../u/<id>`). It was
  removed. They run only when `FLIX_STREAMS_MANIFEST_URL` is set to your own
  Flix-Streams link.
- `moviebox.js`: its request-signing keys are not kept in git. Copy the two
  values (`KEY_B64_DEFAULT`, `KEY_B64_ALT`) from the Doom-addon `moviebox.js` into
  `.env` as `MOVIEBOX_KEY_B64` and `MOVIEBOX_KEY_B64_ALT`; without them MovieBox is off.
- `moviebox.js`: the built-in TMDB API key was removed (`TMDB_API_KEY` from
  `.env` if you want it). `getStreams` takes two optional extra arguments,
  `imdbId` and `{ title, year, originalTitle }`; CutCrew passes the title it
  already knows, so no TMDB call is needed.

Everything else is unchanged. CutCrew loads these files from
`backend/src/services/streamSources.js` (the "doom" source kind).
