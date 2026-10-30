FROM debian:bookworm-slim AS build
ARG TELEGRAM_BOT_API_COMMIT=e3e9dd8e5b3d7ab8537cd5a10dc31d5ffa8f82d1
ARG BUILD_JOBS=2
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git g++ make cmake gperf libssl-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init . && git remote add origin https://github.com/tdlib/telegram-bot-api.git \
    && git fetch --depth 1 origin "$TELEGRAM_BOT_API_COMMIT" && git checkout FETCH_HEAD \
    && git submodule update --init --recursive --depth 1 \
    && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local \
    && cmake --build build --target install --parallel "$BUILD_JOBS"

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3 zlib1g libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home botapi \
    && mkdir -p /var/lib/telegram-bot-api && chown botapi:botapi /var/lib/telegram-bot-api
COPY --from=build /usr/local/bin/telegram-bot-api /usr/local/bin/telegram-bot-api
USER botapi
WORKDIR /var/lib/telegram-bot-api
EXPOSE 8081
ENTRYPOINT ["telegram-bot-api"]
CMD ["--local", "--dir=/var/lib/telegram-bot-api", "--http-ip-address=0.0.0.0", "--http-port=8081"]
