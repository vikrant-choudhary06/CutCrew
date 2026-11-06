# CutCrew website

React + Vite. Pages are in `src/pages`, shared parts in `src/components`,
API helpers in `src/lib`. Styles are plain CSS in `src/index.css` (with a small
browser reset at the top).

- `npm ci`, then `npm run dev`: the `/api` proxy points to `localhost:5000`;
  `VITE_BACKEND_URL` can point it at another backend.
- `npm run lint`, `npm test` and `npm run build` before shipping.
- `public/artwork` holds the hero's offline fallback artwork.

The player (`components/PlaybackPanel.jsx`, `VideoPlayer.jsx`) plays MP4/HLS
directly and converted MKV through the backend, with source fallback, resume,
audio language choice (remembered on this device) and subtitles.
