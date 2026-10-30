# Telegram Phase 0 — operator guide

Current scope: prove private-channel upload and partial-file retrieval. This does not create production storage tables, add playback endpoints or enable Telegram for viewers.

**30 October 2026 scope update:** the owner explicitly chose the existing private supergroup as the storage destination. The access checker now accepts private channels or private supergroups, rejects public usernames (including active usernames), and requires the bot to be an administrator/owner. Channel administrators additionally need `can_post_messages`; that field does not apply to supergroups. References below to the storage channel also apply to this approved private supergroup. The environment variable name remains `TELEGRAM_STORAGE_CHANNEL_ID` and its numeric `-100…` ID format is unchanged.

The scripts use **synthetic binary fixtures, not movies**: 8 MiB for the small check and exactly 1,500,000,000 bytes for the large check. File integrity/network access are the gate here; movie decoding, cross-part streaming and player integration belong to later phases.

## 1. Configure the test bot and channel

Use a dedicated private test channel and a bot allowed to post there. Add the following to `backend/.env` yourself; never paste secret values into chat, screenshots or reports:

```dotenv
TELEGRAM_STORAGE_ENABLED=false
TELEGRAM_BOT_TOKEN=<bot token>
TELEGRAM_API_ID=<Telegram application ID>
TELEGRAM_API_HASH=<Telegram application hash>
TELEGRAM_STORAGE_CHANNEL_ID=-100<channel ID digits>
TELEGRAM_BOT_API_URL=http://127.0.0.1:8081
TELEGRAM_SESSION_PATH=.local/telegram/bot.session
TELEGRAM_REQUEST_TIMEOUT_MS=30000
TELEGRAM_UPLOAD_TIMEOUT_MS=1800000
```

Get application credentials through the owner's account at https://my.telegram.org/apps. The owner handles account sign-in and any verification. This implementation only authenticates **the configured bot** over MTProto; it does not prompt for a phone number, log in as a human or silently fall back to a user session.

Use the exact private channel ID, including `-100`. For a private post link `https://t.me/c/1234567890/42`, the corresponding Bot API channel ID is `-1001234567890`; `42` is the message ID. The access check validates channel identity, private-channel type and bot posting permission.

`TELEGRAM_STORAGE_ENABLED` remains false: the operator CLI is explicit and independent of any future production switch. No database configuration changes are needed for Phase 0.

## 2. Prepare the local Bot API

Start Docker Desktop with its Linux engine. The supplied Dockerfile compiles the official `tdlib/telegram-bot-api` source, pinned to commit `e3e9dd8e5b3d7ab8537cd5a10dc31d5ffa8f82d1`. It does not use an unofficial prebuilt Bot API image.

From `backend/`:

```powershell
docker compose --env-file .env -f compose.telegram.yaml build
```

If the bot is still using Telegram's hosted Bot API, Telegram requires `logOut` before switching it to a local server. This is a separate explicit command, not an automatic side effect of check/run:

```powershell
npm run telegram:poc -- logout-cloud
```

It logs that bot out of the cloud Bot API; cloud login is unavailable for ten minutes afterward. Use the dedicated test bot, and coordinate any existing poller/webhook using it. Then start the local server:

```powershell
docker compose --env-file .env -f compose.telegram.yaml up -d
```

The host port binds to `127.0.0.1:8081` only. Credentials are passed as environment variables to the official binary, not included in the image. A named Docker volume retains the Bot API's sensitive working data. Do not publish its port, share the volume, or print `docker compose config` with real credentials; use `config --quiet` for validation.

The source build can take time and requires RAM/network access. If compilation fails, record the build diagnostics and fix that before claiming the local server is set up. The current development run did **not** build/start this container because the Docker engine was unavailable.

### Docker-free local alternative (Windows + Ubuntu WSL)

The official server can also run directly in Ubuntu WSL. This uses the same pinned source and the same existing `.env`; Docker is optional. Install the compiler dependencies inside Ubuntu:

```powershell
wsl -d Ubuntu -u root -- sh -lc 'apt-get update && apt-get install -y --no-install-recommends ca-certificates git g++ make cmake gperf libssl-dev zlib1g-dev'
```

From `backend/`, fetch the official repository into the ignored `.local/telegram/native/source` directory, check out commit `e3e9dd8e5b3d7ab8537cd5a10dc31d5ffa8f82d1`, and initialize its submodules. Inside Ubuntu, build from that source directory:

```sh
sh /mnt/c/Users/hp/OneDrive/Desktop/CutCrew/backend/scripts/telegram-local-build.sh
```

After the binary exists, start it from `backend/` on Windows:

```powershell
node scripts/telegram-local.cjs
```

Adjust the `/mnt/c/...` path if the checkout moves. The build script compiles in a unique Ubuntu `/tmp/cutcrew-telegram-build.*` directory for filesystem performance and copies the finished binary into the ignored workspace directory. The temporary build location is recorded in `.local/telegram/native/build-location.txt` for inspection; it is not automatically deleted.

Keep the launcher process running and use the check/test commands below in another terminal. The launcher passes application credentials through stdin, binds the server to `127.0.0.1:8081`, and keeps working data and private logs under the ignored `.local/telegram/native/` directory. It does not log out a cloud bot automatically. The same explicit cloud-migration considerations above apply. Do not run the Docker and WSL instances on the same port at once.

## 3. Read-only access check

```powershell
npm run telegram:check
```

With missing/invalid configuration, this prints only variable names and exits with code 2. It does not call Telegram. Once configuration is valid, it checks:

- Local Bot API authentication (`getMe`).
- Exact private channel identity (`getChat`).
- Posting permission (`getChatMember`).
- MTProto bot authentication and channel resolution.
- Bot identity matches between the two clients.

MTProto authorization is stored in the ignored session file under `backend/.local/telegram/`; no session strings or raw errors are printed. Unix permissions are restricted by the scripts; on Windows, keep this folder protected by your account's filesystem permissions. A session belonging to another bot is rejected.

The Docker availability result is informative: a native local Bot API server can also work without Docker. Reachability and MTProto access still have to pass.

## 4. Small upload and range test

```powershell
npm run telegram:poc -- run small
```

This performs the access check, creates an 8 MiB synthetic fixture, posts it to the configured private channel as a document with a generated caption/Upload ID, then retrieves that exact message through MTProto.

Checks include unaligned offsets, 512 KiB boundaries, the middle of the file and near EOF. Expected bytes are read from the local reference file and compared exactly. The small benchmark reads the entire 8 MiB back in bounded pieces and compares the whole-file SHA-256.

The POC also explicitly re-fetches message references, injects an empty cached reference and attempts a bounded recovery/read. This simulates a stale reference; it is not evidence that a genuinely expired server-side reference was observed. Bot authentication and private-channel access must succeed in practice; mock tests do not prove that Telegram permits the intended operations.

## 5. Large-part test

Only after the small test passes:

```powershell
npm run telegram:poc -- run large
```

This creates and uploads a **1500 decimal MB** synthetic part. Allow at least that much free disk space plus reserve and the Bot API's own working-space needs. The configured upload deadline defaults to 30 minutes and can be adjusted up to one hour.

The large test verifies random-access samples and a sequential **32 MiB** byte-checked download benchmark, reporting observed upload/download throughput and safe failure/rate-limit categories. It does not download/hash all 1500 MB remotely or prove full-film playback. Preparation and upload stream from disk; they do not read the whole fixture into memory.

Fixtures can be generated separately without credentials or any network calls:

```powershell
npm run telegram:poc -- fixture small
npm run telegram:poc -- fixture large
```

Only the small fixture was generated during the current development pass. Existing completed fixtures are checked and reused; changed or incomplete files are not silently overwritten. If fixture creation was interrupted, inspect/archive the incomplete local artifact before regenerating it.

## 6. Resume/re-run without duplicate uploads

```powershell
npm run telegram:poc -- verify small
npm run telegram:poc -- verify large
```

The scripts save a private manifest **before** upload, then persist returned message/file IDs and the private post link. Re-running `run` reuses a previously recorded completed upload for the same bot/channel. `verify` only re-reads that saved upload.

An upload timeout/crash can leave delivery uncertain: Telegram may have accepted it before a response was saved. The script refuses an automatic re-upload in that state. Inspect the caption's Upload ID in the private channel. If you explicitly want a new test post:

```powershell
npm run telegram:poc -- run small --new-upload
```

No CLI command deletes Telegram messages, channels or volumes. Test-post cleanup is an owner operation. A different configured bot/channel cannot reuse another target's manifest.

## 7. Outputs and completion gate

- Private manifests, synthetic fixtures and upload references: `backend/.local/telegram/phase0/`.
- Sensitive MTProto authorization: configured session path under `backend/.local/telegram/`.
- Sanitized latest result: `reports/TELEGRAM-PHASE0.json`.
- Development/verification notes: `reports/TELEGRAM-PHASE0.md`.

The public result excludes bot tokens, application hashes, sessions, Telegram channel/message IDs and internal URLs. It contains configuration field names, boolean checks, sample offsets, timings and sanitized error categories. Files under `.local/` are ignored by Git.

`phase0-live-passed` requires verified small and large manifests for the currently configured bot/channel. `access-verified` alone is not Phase 0 completion. Neither is a successful mocked test suite.

If MTProto bot access is rejected (`BOT_METHOD_INVALID`, inaccessible channel/message, etc.), retain the failure evidence and stop at this gate. Discuss an explicitly approved alternative before introducing user-account authentication or changing access. Respect Telegram wait responses; do not repeatedly retry in a tight loop.

## References

- Local Bot API and `logOut`: https://core.telegram.org/bots/api#using-a-local-bot-api-server
- Partial download rules: https://core.telegram.org/api/files
- Official bot MTProto authentication: https://core.telegram.org/method/auth.importBotAuthorization
- Client documentation: https://docs.teleproto.dev/migrating-from-gramjs
- Official server source: https://github.com/tdlib/telegram-bot-api
