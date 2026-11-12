# Standalone build; application sources and dev dependencies stay in this stage.
FROM node:20-slim AS build

WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install && npm run build && npm prune --omit=dev

FROM node:20-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN chmod -R a-w /app

ENV NODE_ENV=production HOME=/tmp TMPDIR=/tmp
USER node

# cgroup/CPU/PID/disk/network/seccomp limits must be supplied and verified by
# the host. USER and read-only app files alone are not a decoder sandbox.
CMD ["node", "dist/index.js"]
