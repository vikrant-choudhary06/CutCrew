# CutCrew frontend

React/Vite/Tailwind implementation of the new console-inspired cinematic home screen.

- Five curated spotlight films with bundled poster/backdrop artwork, animated selection, keyboard arrows and mobile horizontal scrolling.
- Search calls the existing backend API. The hero heading follows the selected movie; Play film resolves and plays sources through the backend.
- Guest watchlists use localStorage; signed-in users have PostgreSQL-backed profile watchlists and progress. Any catalogue title can be saved.
- Bottom navigation stays fixed across the site and opens Browse, Search, Watchlist and About panels with keyboard focus handling.
- The player supports MP4/HLS, available HLS qualities, external subtitles, source switching, one automatic link refresh and provider fallback. Closing the panel aborts pending requests and releases video/HLS resources.
- Below the hero, Trending Movies and Popular Series load from the backend, with horizontal rails, View all collection panels, and loading/empty/error states. Genre cards load filtered catalogue collections.
- Empty/small databases are supplemented by cached live metadata suggestions through the backend. These suggestions are not stored as complete movie records; details/playback hydrate titles normally. The genre scraper also falls back when the primary service returns a successful but empty response.
- Catalogue cards open live title details. Movies can play directly; series include season/episode selection before using the same playback engine.
- Search results are clickable and open live details/playback. Browse uses the backend /api/discover endpoint, with Movies/Series and genre filters, 18-title pages, Load more, request cancellation, retry states and duplicate protection. Returning from a title restores the loaded collection and scroll position.
- Panel/card entrance transitions, hover feedback and loading skeletons respect prefers-reduced-motion. The playback bundle is deferred until Play is opened, reducing the initial JavaScript bundle from about 799 kB to about 234 kB before gzip.
- Continue Watching restores film/episode progress. Accounts support up to five profiles, explicit device-library import, and queued progress sync after reconnect. Series support next-episode playback and optional autoplay. Related titles use genre metadata. Year/language filters apply to loaded browse results; unavailable language metadata disables that filter.

Run npm ci, then npm run dev. Use npm run lint and npm run build for verification. The /api development proxy points to localhost:5000. VITE_BACKEND_URL can override this for another backend deployment.

Artwork was obtained from the existing Cinemeta metadata service and bundled in public/artwork for predictable loading. Google Fonts supplies DM Sans and Manrope, with system fallbacks.

The earlier frontend is archived at ../reports/frontend-before-reset.zip.


Account recovery and verification now use hashed, expiring single-use links. Password reset revokes existing sessions. Configure APP_URL, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and MAIL_FROM in backend/.env for real email delivery. Explicit MAIL_TRANSPORT=file is available only outside production and writes private development emails under ignored backend/.local/mail. See reports/PLAYBACK-ACCOUNT-POLISH.md for the latest verification.

The player now uses one integrated full-film timeline (including fullscreen), replacing the separate Jump to form. See ../reports/INTEGRATED-PLAYER-TIMELINE.md for browser verification.

Play now opens a dedicated full-viewport watch screen. Provider/source/quality/speed, audio/subtitle and episode controls are in player menus; controls auto-hide during playback. See ../reports/DEDICATED-WATCH-VIEW.md.
