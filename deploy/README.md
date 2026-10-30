# Deployment

The root compose file packages the frontend, Node backend with compiled providers/FFmpeg, and internal Python IMDbAPI. PostgreSQL is external, using backend/.env DATABASE_URL. For a separate local PostgreSQL container, the existing backend/compose.yaml is available.

1. Configure backend/.env with DATABASE_URL, unique ADMIN_TOKEN and persistent MEDIA_TOKEN_SECRET. Set FRONTEND_ORIGINS in the deployment shell (or a root .env) to the actual HTTPS frontend origin, including scheme. Do not use a wildcard for credentialed account requests.
2. Run `docker compose config --quiet` and `docker compose build` at the repository root.
3. Run `docker compose up -d`. Only frontend port 8080 is published, on loopback. Put your HTTPS reverse proxy in front of it. Account cookies are Secure in production and require HTTPS, apart from browser-specific localhost allowances.
4. Check `docker compose ps`, `/api/ready` and protected `/api/admin/health`. Inspect service logs without copying provider URLs or credentials to public tickets.

Migrations run transactionally at backend startup. Keep PostgreSQL durable and back it up before upgrades. `npm run db:backup` in backend uses pg_dump (set PG_DUMP_PATH if necessary); store the resulting custom-format dump in encrypted off-host storage and perform a restore drill with pg_restore into a separate database. The script intentionally never deletes existing backups/databases. Schedule backups and uptime monitoring in your hosting platform after choosing the host; no external job has been scheduled by this change.

Provider health reports aggregate source-resolution attempts observed by this backend process. A resolved source does not guarantee full-duration playback. The administrator catalogue API lists titles and supports PATCH of title, plot and genres; it does not expose media URLs, user passwords or session tokens.

Capacity is bounded by MAX_REMUX_STREAMS (default 2). Source-inspection probes have a separate two-probe limit. Seek/audio changes restart a conversion from the requested source timestamp; upstream range/seek support and correct source timestamps are required. Conversion is not a prebuilt CDN cache and may take seconds. For larger audiences, provision a conversion job queue, durable HLS/object storage and CDN based on measured traffic and authorized source rights.

Session state, profiles and libraries live in PostgreSQL and work across replicas. Sign-in rate limiting and provider observations are process-local; enforce shared rate limits at your production reverse proxy before scaling replicas. Email verification, password recovery, MFA, parental controls, subscription/payment flows and device revocation UI are not included. Registration never grants an admin role. Imported legacy password hashes must be migrated through an explicit recovery process; they are not treated as plaintext passwords.

This configuration does not publish a domain, provision hosting, install TLS certificates or grant streaming rights. Those require the chosen hosting/content configuration. Python dependencies inherit the existing requirements file. Pin and audit container/dependency versions for a release, keep secrets out of images, and rotate the previously exposed historical MongoDB credential if it has not already been revoked.
