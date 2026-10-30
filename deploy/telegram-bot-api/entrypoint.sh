#!/bin/sh
# Starts the Bot API server with only the two values it needs.
# backend/.env is mounted as a Compose secret; nothing else from it
# (bot token, database URL, admin token) is put into this process.
set -eu
secret=/run/secrets/backend_env
read_value() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$secret" | tail -n 1 | tr -d '\r' | sed "s/^[\"']//; s/[\"'][[:space:]]*\$//"
}
if [ ! -r "$secret" ]; then
  echo '{"status":"failed","code":"BACKEND_ENV_SECRET_MISSING"}'; exit 2
fi
TELEGRAM_API_ID=$(read_value TELEGRAM_API_ID)
TELEGRAM_API_HASH=$(read_value TELEGRAM_API_HASH)
if [ -z "$TELEGRAM_API_ID" ] || [ -z "$TELEGRAM_API_HASH" ]; then
  echo '{"status":"failed","code":"TELEGRAM_API_ID_OR_HASH_MISSING"}'; exit 2
fi
export TELEGRAM_API_ID TELEGRAM_API_HASH
mkdir -p /var/lib/telegram-bot-api/tmp
# Data volume belongs to the service user; the server itself never runs as root.
if [ "$(id -u)" = 0 ]; then
  chown -R telegram:telegram /var/lib/telegram-bot-api
  set -- setpriv --reuid=telegram --regid=telegram --init-groups --inh-caps=-all --bounding-set=-all
else
  set --
fi
exec "$@" /usr/local/bin/telegram-bot-api --local \
  --dir=/var/lib/telegram-bot-api \
  --temp-dir=/var/lib/telegram-bot-api/tmp \
  --http-ip-address=0.0.0.0 --http-port=8081 \
  --verbosity=0
