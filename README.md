# CutCrew

React/Vite frontend, Express/PostgreSQL catalogue API, Python IMDb scraper, and TypeScript provider adapters.

## Run locally

Use Node.js 22.12+ (tested with Node 24). Install each package:

```powershell
cd backend
npm ci
cd ../provider
npm ci
npm run build
cd ../frontend
npm ci
```

Copy backend/.env.example to backend/.env and configure DATABASE_URL, ADMIN_TOKEN, and MEDIA_TOKEN_SECRET. Start PostgreSQL, then run npm start in backend and npm run dev in frontend in separate terminals. The backend defaults to port 5000; Vite proxies /api to that port. VITE_BACKEND_URL can point to a separate backend; restart/rebuild Vite after changing it.

The backend applies versioned SQL migrations at startup. Run npm run db:check to verify connectivity and initialize the schema separately. Production uses the pg connection pool and a normal PostgreSQL server; TLS options can be provided in DATABASE_URL according to your database host's requirements. Certificate verification is not disabled by the application.

For a local Docker database, set POSTGRES_PASSWORD in backend/.env and run docker compose up -d in backend. Set the matching password in DATABASE_URL (URL-encode special characters). This compose file runs only PostgreSQL, binds it to loopback, and keeps data in a named volume. It does not deploy the app or other services.

## MongoDB to PostgreSQL

MongoDB is no longer used at runtime. Movies use an IMDb primary key, JSONB catalogue aggregates, SQL timestamps, generated filter/sort columns and indexes. Nested seasons, episode caches, cast, provider payloads and legacy IDs retain their API shape. Users have a separate SQL table with unique email and a constrained role. Metadata updates merge only their fields; episode updates lock the movie row inside a transaction to preserve concurrent caches.

Accounts now support hashed passwords, revocable cookie sessions, up to five profiles, profile watchlists and playback progress. Guest libraries remain on the device and can be explicitly imported after sign-in.

To transfer existing data, first back up MongoDB and pause writes during the final cutover. Set SOURCE_MONGO_URI to the source database using a read-only account, and DATABASE_URL to the target. If the source URI does not select a database, set SOURCE_MONGO_DATABASE explicitly. Then, in backend:

```powershell
npm ci
npm run db:import -- --dry-run
npm run db:import -- --apply
npm run db:check
```

The default dry-run executes validation against PostgreSQL and rolls back all data changes; schema initialization may still create tables. Apply imports movies and users in one transaction, retaining IDs, timestamps, provider links, episode caches and existing password hashes. Existing target identities/emails are counted as skipped and never overwritten. Any error rolls back the entire import. Reruns are safe, but do not synchronize later MongoDB edits into existing PostgreSQL records; perform the final import into a fresh target while source writes are paused. Keep MongoDB/backups until record counts, skipped rows and representative metadata/playback are verified. The importer never writes to MongoDB or prints source documents/credentials. The MongoDB driver is a development dependency used only by this one-off script; install development dependencies on the migration machine.

The Python API is optional when the configured remote scraper works. To run it locally, install IMDBAPI/requirements.txt, run python main.py in IMDBAPI, and set SCRAPER_URL=http://localhost:8000. Scraper failures automatically use Cinemeta for search, title details, and genre discovery. Fallback metadata may have fewer cast images and ratings fields.

## Playback

Search suggestions are returned without writing incomplete catalogue records. Opening a title hydrates its metadata and saves it under its IMDb ID. Series can discover seasons before Play; providers may return either directLinks or episodesLink.

Play discovers missing provider links and tries subsequent providers when search, resolution, or usable-source validation fails. Every provider has a deadline and cancellation signal; a playback resolution request has a 60-second budget. A successful movie or individual episode caches its sources for three hours. Empty/failed resolutions never overwrite a good cache.

MKV sources require FFmpeg and ffprobe on the backend PATH (or FFMPEG_PATH/FFPROBE_PATH). Compatible H.264 is remuxed; unsupported video is converted to 8-bit H.264 up to 720p, with AAC audio. MAX_REMUX_STREAMS limits concurrent conversions (default two). Converted fragmented MP4 supports playback and buffering. The full-film seek control starts a new conversion at the chosen offset; this depends on upstream range/seek support. Available embedded audio tracks can be selected; embedded MKV subtitles are not extracted.

The player supports MP4 and HLS, source selection, HLS quality selection when available, VTT and converted SRT subtitles, and episode navigation. When sources fail, it tries the next source, refreshes expired links once, then requests another provider. The user can also switch providers or retry manually.

Media is relayed through /api/media using short-lived authenticated tickets, including rewritten HLS variants, segments, and key URIs. The relay forwards permitted provider headers and byte ranges. DNS lookup pins requests to public addresses; private, loopback, link-local, and unsupported destinations are blocked, including redirects. The backend therefore carries playback bandwidth. Configure deployment request timeouts and capacity accordingly. Use a persistent MEDIA_TOKEN_SECRET across replicas; otherwise tickets are valid only on the process that issued them.

## Provider configuration

Run npm run build in provider after changing an adapter. The backend loads provider/dist directly; the provider development server is not required.

Defaults are limited to the live-verified 4khdhub/Vega shortlist in provider/provider-policy.json. ENABLED_PROVIDERS is an optional comma-separated override. PROVIDER_REGISTRY_URL overrides the registry URL. PROVIDER_BASE_URLS supplies per-provider URL overrides as JSON, for example {"providerName":"https://your-working-source.example"}. Only configure sources you trust. Browser-challenge-dependent adapters cannot solve interactive challenges in the backend and fall through to another provider.

Live checks during implementation found:
- The default Render scraper returned HTTP 500 for a title lookup; Cinemeta successfully supplied that title.
- The historical provider registry returned HTTP 404. Both the backend and provider utilities now use the replacement urls.json registry published by Zenda-Cross/vega-providers.
- The autoEmbed upstream returned no playable sources for the checked title.

Some legacy adapters (including Rive and Consumet integrations) have no endpoint in the replacement registry and require explicit working URL overrides. Individual source hosts can also be unavailable. The sample preview verifies the app and player, not the availability of third-party movies.

## Admin and credentials

/admin, /api/admin/stats, and /api/logs require ADMIN_TOKEN. Open /admin and use any username with ADMIN_TOKEN as the HTTP Basic password, or send Authorization: Bearer <ADMIN_TOKEN> to API requests. Without ADMIN_TOKEN, admin access is disabled. Visitor heartbeat remains public.

The previously hardcoded MongoDB credential was removed. Its owner must rotate/revoke that credential in MongoDB Atlas; removing it from source does not invalidate copies or Git history. The legacy test-mongo.js command now delegates to the PostgreSQL connection check.

## Verification

```powershell
cd backend
npm test
cd ../frontend
npm run lint
npm run build
cd ../provider
npm run build
```

Backend tests use disposable embedded PostgreSQL (PGlite), without downloading a MongoDB binary. Tests cover SQL filters and constraints, import dry-run/rollback/idempotency, preservation of legacy IDs/timestamps/caches/password hashes, metadata hydration, search typing, provider/episode normalization, fallback, deadlines, media tickets, HLS rewriting, admin access, concurrent episode writes and real FFmpeg conversion. To run against a native PostgreSQL server, create a separate empty database named cutcrew_test_<suffix>, set TEST_DATABASE_URL to it, and run npm test. These tests insert fixtures and must not target a shared or production database; use a fresh test database for each native run.

For a disposable browser preview, run npm run preview from backend and npm run dev from frontend. This creates temporary embedded PostgreSQL with a sample movie and a two-season series, using public MDN MP4 and Mux HLS test media. Open /movie/tt0000001 or /movie/tt0000002. This test server is local-only, uses a sample adapter, and must not be deployed as the production server. Stop it with Ctrl+C; its database is disposable.

See reports/FULL-FEATURE-PASS.md for the account, library, player and operations feature pass. External provider uptime remains outside the application's control.

## Latest live provider verification

See reports/PROVIDER-REPORT.md for the earlier 41-provider sweep and real browser playback results. Inception and Game of Thrones S1E1 played through 4khdhub; switching the episode to Vega also played real video. Run npm run providers:check in backend to repeat credential-free diagnostics, or node scripts/live-preview.cjs for an isolated real-provider preview on port 5001. The latter now uses disposable embedded PostgreSQL and does not affect production data. See reports/POSTGRESQL-MIGRATION.md for database migration verification and remaining cutover steps.

## Deployment and operations

The root compose.yaml runs frontend, backend (including built providers and FFmpeg), and an internal IMDb API against your configured PostgreSQL database. See deploy/README.md. Health endpoints, protected admin catalogue tools and npm run db:backup are available. Image builds, public HTTPS deployment, offsite backup scheduling and restore drills must be verified on the hosting environment.


## Account recovery

Recovery and verification use hashed single-use links. Resetting a password revokes existing sessions. Configure APP_URL, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and MAIL_FROM in backend/.env for real delivery. MAIL_TRANSPORT=file is available only outside production and writes private development emails under ignored backend/.local/mail. See reports/PLAYBACK-ACCOUNT-POLISH.md.

Playback now validates real media bytes (and HLS segments) before accepting freshly resolved or cached sources. Bad sources trigger rediscovery/fallback; verified checks are briefly cached. Run npm run providers:matrix in backend for a database-free live sample. See reports/REAL-CONTENT-RELIABILITY.md.
