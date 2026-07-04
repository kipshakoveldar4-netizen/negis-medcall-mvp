# Video optimization worker for Railway (or any Docker host).
# ffmpeg must be present in the image — the worker shells out to it.
FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json tsconfig.json ./
COPY src ./src

# Self-contained build: no workspace/catalog dependencies, plain npm works.
RUN npm install && npm run build && npm prune --omit=dev

ENV NODE_ENV=production

CMD ["npm", "start"]
