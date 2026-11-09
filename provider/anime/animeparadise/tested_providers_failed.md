The following providers were implemented but failed to work reliably in standard server/browser environments due to aggressive Cloudflare and DDoS-Guard protection (even with FlareSolverr integration for some). They have been removed from the SDK to maintain stability:

- AnimePahe (animepahe.com)
- AnimeFire (animefire.plus)
- KickAssAnime (kaa.lt)

Reason for failure: 403 Forbidden on initial search/request.
Tested date: June 2026.

## Removed on 2026-11-06 (CutCrew)

Tested from a home PC and an AWS server with Frieren, Jujutsu Kaisen and One Piece, episode 1:

- Gogoanime (anineko.to): site down, HTTP 522.
- Goyabu (goyabu.io): Cloudflare 403.
- AllManga (allmanga.to): search and episodes work, but no video source URLs come back.
- MegaPlay (megaplay.buzz): episodes work, "No video sources found".
- Anikoto (anikototv.to): uses MegaPlay for video, so it fails the same way.
- MangaDex, WeebCentral, Mangapill: manga only; CutCrew plays video.

Only AnimeParadise returned real video (8 of 10 anime on the AWS server).
