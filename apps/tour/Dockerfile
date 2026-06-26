# syntax=docker/dockerfile:1
#
# Team Tour — portable container image. Host-agnostic (Railway / Fly / any
# container runtime), no Nixpacks/Railpack magic.
#
# IMPORTANT: build CONTEXT must be the REPO ROOT — the app is an npm-workspace
# member (depends on @balatro/* packages), so the install has to run at the root
# to link them. From the repo root:
#   docker build -f apps/tour/Dockerfile -t team-tour .
# (On Railway: Root Directory `/`, and railway.json points dockerfilePath here.)

FROM node:24-bookworm-slim AS base
WORKDIR /app
# Prisma needs openssl present at build + runtime.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# ── build: full workspace install at root → generate client → next build ──
FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN npm ci
# `npm run build` triggers prebuild (`prisma generate`, custom client output) then `next build`.
RUN npm run build -w @balatro/tour

# ── runtime ──
FROM base AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app /app
WORKDIR /app/apps/tour
EXPOSE 3000
# Apply the schema to the target DB on boot, then serve on $PORT (default 3000).
CMD ["sh", "-c", "npx prisma db push --skip-generate && npx next start -p ${PORT:-3000}"]
