# Deployment

The root compose file packages the frontend, Node backend with compiled providers/FFmpeg, internal Python IMDbAPI, and the Telegram Bot API server used for video storage. PostgreSQL is external, using backend/.env DATABASE_URL. For a separate local PostgreSQL container, the existing backend/compose.yaml is available.

## Telegram video storage

`docker compose up -d` starts the Telegram Bot API server (`telegram-bot-api`) together with the backend, and both restart together with the host.

- It is built from the official tdlib/telegram-bot-api source at a pinned commit (`deploy/telegram-bot-api/Dockerfile`). The first build compiles C++ and takes 15-40 minutes; it needs about 1.5 GB of RAM per build job. Set `TELEGRAM_BUILD_JOBS` (default 2) to trade speed for memory.
- It has no published port. Only the backend reaches it, at `http://telegram-bot-api:8081` on the private Compose network. The backend accepts that name or a loopback address, nothing else, because requests to it carry the bot token.
- It reads only `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from `backend/.env` (mounted as a Compose secret). The bot token, database URL and admin token are not passed to it.
- Data lives in two named volumes that survive rebuilds: `telegram-bot-data` (server data and upload temp files) and `backend-data` (the backend's Telegram session, video cache and import files under `/app/backend/.local`). Give the host enough disk for the cache (`VIDEO_CACHE_MAX_BYTES`) plus the largest file being imported.
- The backend logs into Telegram with the bot token on first use and saves its session in `backend-data`; no manual login is needed.
- If the Telegram server is down, the site keeps working and stored titles fall back to the normal sources.
- To import a video on the server, copy it into the backend container (for example `docker compose cp ./movie.mkv backend:/app/backend/.local/import/movie.mkv`) and run `docker compose exec backend npm run video:import -- import --file .local/import/movie.mkv --imdb tt1234567 --quality 1080p --audio hi,en`. Preparing a file needs free space of about twice its size in `backend-data`; delete the copied file after the import finishes.
- Check readiness with `docker compose ps` (both healthy) and the admin page's storage panel. (`npm run telegram:check` is a development script that writes to `reports/`, which is not in the image; inside the container use the admin page instead.)
- The frontend is published on `127.0.0.1:8080`. Set `FRONTEND_PORT` to use another port, for example when Windows reserves 8080.
- To skip the long build on a small server, build the images on a faster machine and move them with a registry or `docker save` / `docker load`.

Local development on Windows is unchanged: `node scripts/telegram-local.cjs` in WSL plus `npm start`, with `TELEGRAM_BOT_API_URL=http://127.0.0.1:8081`.

1. Configure backend/.env with DATABASE_URL, unique ADMIN_TOKEN and persistent MEDIA_TOKEN_SECRET. Set FRONTEND_ORIGINS in the deployment shell (or a root .env) to the actual HTTPS frontend origin, including scheme. Do not use a wildcard for credentialed account requests.
2. Run `docker compose config --quiet` and `docker compose build` at the repository root.
3. Run `docker compose up -d`. Only frontend port 8080 is published, on loopback. Put your HTTPS reverse proxy in front of it. Account cookies are Secure in production and require HTTPS, apart from browser-specific localhost allowances.
4. Check `docker compose ps`, `/api/ready` and protected `/api/admin/health`. Inspect service logs without copying provider URLs or credentials to public tickets.

Migrations run transactionally at backend startup. Keep PostgreSQL durable and back it up before upgrades. `npm run db:backup` in backend uses pg_dump (set PG_DUMP_PATH if necessary); store the resulting custom-format dump in encrypted off-host storage and perform a restore drill with pg_restore into a separate database. The script intentionally never deletes existing backups/databases. Schedule backups and uptime monitoring in your hosting platform after choosing the host; no external job has been scheduled by this change.

Provider health reports aggregate source-resolution attempts observed by this backend process. A resolved source does not guarantee full-duration playback. The administrator catalogue API lists titles and supports PATCH of title, plot and genres; it does not expose media URLs, user passwords or session tokens.

Capacity is bounded by MAX_REMUX_STREAMS (default 2). Source-inspection probes have a separate two-probe limit. Seek/audio changes restart a conversion from the requested source timestamp; upstream range/seek support and correct source timestamps are required. Conversion is not a prebuilt CDN cache and may take seconds. For larger audiences, provision a conversion job queue, durable HLS/object storage and CDN based on measured traffic and authorized source rights.

Session state, profiles and libraries live in PostgreSQL and work across replicas. Sign-in rate limiting and provider observations are process-local; enforce shared rate limits at your production reverse proxy before scaling replicas. Email verification, password recovery, MFA, parental controls, subscription/payment flows and device revocation UI are not included. Registration never grants an admin role. Imported legacy password hashes must be migrated through an explicit recovery process; they are not treated as plaintext passwords.

This configuration does not publish a domain, provision hosting, install TLS certificates or grant streaming rights. Those require the chosen hosting/content configuration. Python dependencies inherit the existing requirements file. Pin and audit container/dependency versions for a release, keep secrets out of images, and rotate the previously exposed historical MongoDB credential if it has not already been revoked.
