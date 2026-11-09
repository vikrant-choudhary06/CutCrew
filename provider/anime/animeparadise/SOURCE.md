# Where this code comes from

- Project: anime-sdk by hexxt-git, MIT licence (see `LICENSE`)
- Repository: https://github.com/hexxt-git/anime-sdk
- Version: 1.1.0
- Copied into CutCrew: 2026-11-06

## Changes made for CutCrew

- Removed the providers and extractors that no longer returned video
  (Gogoanime, Goyabu, AllManga, MegaPlay, Anikoto) and the manga providers
  (MangaDex, WeebCentral, Mangapill). See `tested_providers_failed.md`.
- Removed the tests and examples that used them.
- Added `src/cutcrew.ts`, the small entry file CutCrew's backend loads.
  `provider/build-anime.js` bundles it into `provider/dist-anime/anime.cjs`.

Only `src/`, this file, `LICENSE`, `README.md` and `tested_providers_failed.md`
are kept in CutCrew's git. The rest of the original project (docs website,
tests, examples) is ignored.

## Adding another anime provider

1. Put the provider class in `src/providers/` (it extends `BaseProvider`:
   `search`, `fetchContentUnits`, `resolveStream`).
2. Add it to `PROVIDERS` in `src/cutcrew.ts`.
3. Run `npm run build` in `provider/`, then add its id to `ANIME_PROVIDERS`
   in the backend `.env`.

To pick up fixes from the original project later, compare its `src/` with
this one and copy over the changes.
