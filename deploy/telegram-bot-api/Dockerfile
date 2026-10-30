# Official Telegram Bot API server, built from source at a pinned commit.
# Local mode lifts the 50 MB upload limit (to 2 GB per file) that CutCrew's
# video storage needs. It runs on the private Compose network only.
FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates make cmake g++ gperf zlib1g-dev libssl-dev \
  && rm -rf /var/lib/apt/lists/*
# Same commit as the Windows/WSL build used during development.
ARG BOT_API_COMMIT=e3e9dd8e5b3d7ab8537cd5a10dc31d5ffa8f82d1
ARG BUILD_JOBS=2
WORKDIR /src
RUN git clone https://github.com/tdlib/telegram-bot-api.git . \
  && git checkout "$BOT_API_COMMIT" \
  && git submodule update --init --recursive
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DTD_ENABLE_LTO=OFF \
  && cmake --build build --target telegram-bot-api --parallel "$BUILD_JOBS" \
  && strip build/telegram-bot-api

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 zlib1g tini \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --home-dir /var/lib/telegram-bot-api telegram \
  && mkdir -p /var/lib/telegram-bot-api/tmp \
  && chown -R telegram:telegram /var/lib/telegram-bot-api \
  && chmod 700 /var/lib/telegram-bot-api
COPY --from=build /src/build/telegram-bot-api /usr/local/bin/telegram-bot-api
COPY deploy/telegram-bot-api/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh
USER telegram
WORKDIR /var/lib/telegram-bot-api
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8081"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
