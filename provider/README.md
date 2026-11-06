# CutCrew providers

The vega-style provider modules the backend plays from. Each provider lives in
`providers/<name>/` (catalog, posts, meta, stream) and is built into
`dist/<name>/*.js`, which the backend loads by name
(`backend/src/utils/providerHelper.js`). The backend passes each module its
context (axios, cheerio, base URLs, headers).

| Provider | What it is |
|---|---|
| `4khdhub` | 4kHDHub, links through the HubCloud extractor (`providers/extractors/hubcloud.ts`) |
| `internetArchive` | Internet Archive films (public domain and Creative Commons); only tried for films up to 1980 |

`npm run build` builds `dist/` and the anime providers (`dist-anime/anime.cjs`,
from `../provider_anime`). The Docker image runs the build itself, so `dist/`
is not kept in git; run the build once before starting the backend locally.

`manifest.json` lists the providers, `provider-policy.json` the default order
and the playback sources tried together (see `backend/src/services/streamSources.js`).
Live checks: `cd ../backend && npm run providers:check` and `npm run sources:check`.

Based on vega-providers (Zenda-Cross).
