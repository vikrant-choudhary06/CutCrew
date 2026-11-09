# Locked runner for third-party Nuvio providers (see provider/nuvio-runner/SOURCES.md).
# No secrets, no volumes; Compose runs it read-only, without capabilities.
FROM node:22-alpine
WORKDIR /app
COPY provider/nuvio-runner/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY provider/nuvio-runner/runner.js ./
# Movie ones from provider/movie/nuvio, anime ones from provider/anime/nuvio.
COPY provider/movie/nuvio/*.js ./providers/
COPY provider/anime/nuvio/*.js ./providers/
USER node
EXPOSE 7070
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:7070/health >/dev/null || exit 1
CMD ["node", "runner.js"]
