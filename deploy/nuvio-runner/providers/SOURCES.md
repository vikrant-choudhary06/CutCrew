# Nuvio providers used by CutCrew

Copied once (not auto-synced) from the NuvioPlugin/All-in-One-Nuvio mirror on
2026-11-09. They were picked after a test from the CutCrew server: each found
the right title and a playable link for all 10 test titles (einthusan: Indian
films only). Their code is obfuscated, so they run only inside the
`nuvio-runner` container, which holds no secrets.

| File | Upstream version | SHA-256 |
|---|---|---|
| castle.js | 2.0.0 | 1b23fb0b7740e707fb2e3c5f6f69ca51c4bb4fc6afc8f1ae851af22e3f66bb89 |
| moviebox.js | 1.2.3 | 874dc691ce22292ffcbc7ef797000c5c2d7b26a1cc9d674503c4830ca17572d4 |
| playimdb.js | 2.0.0 | e00e7b0d65b15622e0b6bcdce3ccc92d6226853197962348ced4af47343f07ab |
| einthusan.js | 1.0.0 | 34adb013fbac73ba3688f9bcc93e6418e28aeda1433dd04eb50cdec9cb6a82c8 |
| watchanimeworld.js | NAMA 1.2.1 | c81e39ce144c0bae956dd61ec13d9cb103bd5bad45a76d41c6eb067355290b97 |
| multimovies.js | NAMA 1.3.1 | c1dadbd591b8295d8f75c232ab052aa4fc12b8632f6d2b1a0ffbacae1e47b401 |

To update one: copy the new file here, check it the same way, update this
table, and rebuild only this container.

watchanimeworld.js and multimovies.js come from the NAMA pack (readable source in
its src/ folder; the built files were checked to match it line for line). They
answer with HLS playlists packed into data: links, which the backend serves
through the media relay. MultiMovies reaches several personal proxy servers
(workers.dev bridges) for its files; switch it off in the admin panel if they
misbehave.
