#!/bin/sh
# Run inside Ubuntu WSL after installing the documented build dependencies.
set -eu
backend=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
native="$backend/.local/telegram/native"
source="$native/source"
test -f "$source/td/CMakeLists.txt"
jobs=${BUILD_JOBS:-2}
case "$jobs" in 1|2|3|4) ;; *) printf 'BUILD_JOBS must be 1-4.\n' >&2; exit 2;; esac
if [ "${1:-}" = '--resume' ]; then
  dest=$(cat "$native/build-location.txt")
  case "$dest" in /tmp/cutcrew-telegram-build.*) ;; *) exit 2;; esac
  test -f "$dest/build/CMakeCache.txt"
else
  dest=$(mktemp -d /tmp/cutcrew-telegram-build.XXXXXX)
  printf '%s\n' "$dest" > "$native/build-location.txt"
  # Linux filesystem avoids costly C++ builds on a Windows/OneDrive mount.
  tar -C "$source" --exclude=.git --exclude=build -cf - . | tar -C "$dest" -xf -
  cmake -S "$dest" -B "$dest/build" -DCMAKE_BUILD_TYPE=Release -DTD_ENABLE_LTO=OFF
fi
cmake --build "$dest/build" --target telegram-bot-api --parallel "$jobs"
mkdir -p "$source/build"
cp "$dest/build/telegram-bot-api" "$source/build/telegram-bot-api"
printf 'Local Telegram Bot API binary built successfully.\n'
