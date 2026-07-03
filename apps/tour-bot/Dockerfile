# syntax=docker/dockerfile:1
#
# Team Tour bot — portable container image, same pattern as apps/tour/Dockerfile.
#
# IMPORTANT: build CONTEXT must be the REPO ROOT — the app is an npm-workspace member,
# so the install runs at the root. From the repo root:
#   docker build -f apps/tour-bot/Dockerfile -t team-tour-bot .
# (On Railway: Root Directory `/`, railway.json points dockerfilePath here.)

FROM node:24-bookworm-slim AS base
WORKDIR /app

# ── build: full workspace install at root → tsc ──
FROM base AS build
COPY . .
RUN npm ci
RUN npm run build -w @balatro/tour-bot

# ── runtime ──
FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/tour-bot
# Healthcheck server binds $PORT (default 8080) — the bot itself is a Discord gateway client.
EXPOSE 8080
CMD ["node", "dist/index.js"]
