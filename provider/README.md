# CutCrew providers

Every source CutCrew plays from, grouped by what it is for.

```
provider/
├── movie/                     movies and series
│   ├── 4khdhub/               vega provider (built into dist/)
│   ├── internetArchive/       vega provider (films up to 1980)
│   ├── extractors/            shared link extractors (HubCloud, …)
│   └── nuvio/                 third-party Nuvio files, run by the locked runner
│       ├── castle.js
│       ├── moviebox.js
│       ├── playimdb.js
│       ├── einthusan.js       Indian films only
│       └── multimovies.js     Indian dubs (also used for anime)
├── anime/                     the anime section
│   ├── animeparadise/         anime-sdk source (built into dist-anime/anime.cjs)
│   └── nuvio/
│       └── watchanimeworld.js Hindi, Tamil, Telugu… dubs
├── nuvio-runner/              the locked container for the Nuvio files
│                              (runner.js, Dockerfile, SOURCES.md with hashes)
├── build-bundled.js           builds provider/movie/* into dist/
├── build-anime.js             builds provider/anime/animeparadise into dist-anime/
└── provider-policy.json       the order sources are tried in
```

Not in this folder because they have no code here: the Stremio add-ons
(DesiFlix, HdHub, CENSORED, PenguPlay; addresses in `STREMIO_ADDONS`) and
CutCrew's own Telegram storage (`backend/src/services/storedPlayback.js`).

## Movie providers (vega)
Each lives in `movie/<name>/` (catalog, posts, meta, stream) and is built into
`dist/<name>/*.js`, which the backend loads by name
(`backend/src/utils/providerHelper.js`), passing each module its context
(axios, cheerio, base URLs, headers). The server's `ENABLED_PROVIDERS` lists
which ones run.

## Nuvio providers
Obfuscated or third-party code, so they never run inside the backend: the
`nuvio-runner` container (no secrets, read-only, own network) loads them and
the backend only asks it for links. `nuvio-runner/SOURCES.md` records where
each file came from and its SHA-256. To change one, replace the file, update
the hash, and rebuild only that container.

## Build
`npm run build` builds `dist/` and `dist-anime/anime.cjs`. The Docker image
runs the build itself, so neither is kept in git; run the build once before
starting the backend locally.

`manifest.json` lists the vega providers, `provider-policy.json` the default
order and the playback sources tried together (see
`backend/src/services/streamSources.js`). Live checks:
`cd ../backend && npm run providers:check` and `npm run sources:check`.

Based on vega-providers (Zenda-Cross).
