# CutCrew admin panel

Served at **https://ccadmin.vikrant.sbs**. Plain HTML, CSS and JavaScript (no build step).

Sign in with the server's `ADMIN_TOKEN`. The token stays in this browser tab only.

## Sections
- **Overview**: people online, streams, bandwidth, server load/memory/disk, app release, downloads, storage.
- **Live**: who is streaming right now (IP, country, app or website, title, speed) and everyone online in the last 2 minutes. Refreshes every 3 seconds.
- **Downloads**: APK and Windows installer downloads (today, week, all time, by version and country, latest with IP), plus GitHub's own counts. Counted when a download link (`/api/app/download/android|windows`) is opened, including in-app updates.
- **Providers**: switch any provider on or off. An off provider is not asked for sources and its saved links are not played.
- **Storage**: stored (Telegram) videos — check, hide, restore, make default, retry — and the auto-archive queue.
- **Catalogue**: rename a title, change its synopsis or genres.
- **Logs**: the server's latest log lines.

Countries come from a database bundled with the server (`geoip-country`); no IP address is sent anywhere.

## Deploy
On the server (from the repo folder):

```bash
sudo mkdir -p /var/www/cutcrew-admin && sudo cp -r adminpannel/. /var/www/cutcrew-admin/
```

Nginx: the `ccadmin.vikrant.sbs` block is in `deploy/nginx/cutcrew.conf`; then `sudo certbot --nginx -d ccadmin.vikrant.sbs`.
DNS: an `A` record for `ccadmin` pointing at the server.
