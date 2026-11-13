# Clean! Cut! Action! leaderboard. No npm dependencies, so there is no install step.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATA_FILE=/app/data/leaderboard.json

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public

# The data folder belongs to the unprivileged "node" user so a fresh named volume inherits that ownership.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

VOLUME ["/app/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
