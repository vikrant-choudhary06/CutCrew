FROM node:24-bookworm-slim AS providers
WORKDIR /build/provider
COPY provider/package*.json ./
RUN npm ci
COPY provider/ ./
RUN npm run build

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node backend/ ./
COPY --from=providers /build/provider/dist /app/provider/dist
COPY provider/provider-policy.json /app/provider/provider-policy.json
RUN mkdir -p /app/backend/.local && chown -R node:node /app/backend
ENV NODE_ENV=production PORT=5000
USER node
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:5000/api/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
