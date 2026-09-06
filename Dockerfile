FROM node:24-bookworm-slim AS verification
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json eslint.config.js config.example.yaml ./
COPY src ./src
COPY test ./test
RUN npm run check && npm run build

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOME=/home/signalbot
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY --from=verification /app/dist ./dist
COPY src/storage/migrations ./dist/storage/migrations
RUN groupadd --system signalbot && useradd --system --gid signalbot --home-dir /home/signalbot --create-home --shell /usr/sbin/nologin signalbot \
  && mkdir -p /var/lib/gmgn-signal-bot /home/signalbot/.config/gmgn-signal-bot \
  && chmod 700 /home/signalbot/.config/gmgn-signal-bot \
  && chown -R signalbot:signalbot /app /var/lib/gmgn-signal-bot /home/signalbot
USER signalbot
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "const s=JSON.parse(require('node:fs').readFileSync('/tmp/gmgn-runtime-health.json','utf8')); if(Date.now()-s.atMs>20000) process.exit(1)"
ENTRYPOINT ["node", "dist/index.js"]
