# Locked runner for third-party Nuvio providers (see providers/SOURCES.md).
# No secrets, no volumes; Compose runs it read-only, without capabilities.
FROM node:22-alpine
WORKDIR /app
COPY deploy/nuvio-runner/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY deploy/nuvio-runner/runner.js ./
COPY deploy/nuvio-runner/providers/*.js ./providers/
USER node
EXPOSE 7070
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:7070/health >/dev/null || exit 1
CMD ["node", "runner.js"]
