# Meta Insights background worker for Railway Cron (or any Docker host).
# Short-lived: it runs one signed cycle against the production endpoint and exits.
# It needs no ffmpeg and no Supabase/Meta secrets — only the shared worker HMAC
# secret and the API base URL are provided at runtime.
FROM node:20-slim

WORKDIR /app

COPY package.json tsconfig.json ./
COPY src ./src

# Self-contained build: no workspace/catalog dependencies, plain npm works.
RUN npm install && npm run build && npm prune --omit=dev

ENV NODE_ENV=production

CMD ["npm", "start"]
