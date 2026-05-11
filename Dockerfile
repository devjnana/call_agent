# Node.js LTS (see https://hub.docker.com/_/node)
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends wget \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./

RUN npm install --omit=dev \
  && npm cache clean --force

COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/health/live || exit 1

USER node

CMD ["node", "src/server.js"]
