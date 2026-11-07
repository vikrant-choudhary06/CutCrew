# CutCrew admin panel

Served at **https://ccadmin.vikrant.sbs**. Plain HTML, CSS and JavaScript (no build step).

Sign in with an admin email and password. The owner is created on the server with:

```bash
sudo docker compose exec backend npm run admin:owner -- you@example.com
```

(it asks for the password; run it again to set a new owner password). The owner adds and removes other admins in the **Admins** tab. Passwords are saved only as scrypt hashes; a sign-in lasts 7 days (HttpOnly cookie for this site only). After 10 wrong tries an IP or email waits 15 minutes. `ADMIN_TOKEN` still works as a Bearer token for scripts.

## Sections
- **Overview**: people online, streams, bandwidth, server load/memory/disk, app release, downloads, storage.
- **Live**: who is streaming right now (IP, country, app or website, title, speed) and everyone online in the last 2 minutes. Refreshes every 3 seconds.
- **Downloads**: APK and Windows installer downloads (today, week, all time, by version and country, latest with IP), plus GitHub's own counts. Counted when a download link (`/api/app/download/android|windows`) is opened, including in-app updates.
- **Providers**: switch any provider on or off. An off provider is not asked for sources and its saved links are not played.
- **Storage**: stored (Telegram) videos — check, hide, restore, make default, retry — and the auto-archive queue.
- **Catalogue**: rename a title, change its synopsis or genres.
- **Logs**: the server's latest log lines.
- **Admins**: owner only — add an admin (email + password), set a new password, remove. Everyone can change their own password here.

Countries come from a database bundled with the server (`geoip-country`); no IP address is sent anywhere.

## Deploy
On the server (from the repo folder):

```bash
sudo mkdir -p /var/www/cutcrew-admin && sudo cp -r adminpannel/. /var/www/cutcrew-admin/
```

Nginx: the `ccadmin.vikrant.sbs` block is in `deploy/nginx/cutcrew.conf`; then `sudo certbot --nginx -d ccadmin.vikrant.sbs`.
DNS: an `A` record for `ccadmin` pointing at the server.
