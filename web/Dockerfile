# syntax=docker/dockerfile:1
#
# League website (Next.js). web/ is a STANDALONE npm project (not a workspace
# member), but its postinstall runs scripts/sync-schema.mjs which reads the
# repo-root prisma schema + src/ files + assets - so the build context must be
# the repo root. From the repo root:
#   docker build -f web/Dockerfile -t balatro-league-web .

FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# ---- build ----
FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
# postinstall: sync-schema (needs /app/prisma + /app/src) then prisma generate.
RUN cd web && npm ci
RUN cd web && npm run build

# ---- runtime ----
FROM base AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app /app
WORKDIR /app/web
EXPOSE 3000
# npm start = `prisma migrate deploy --schema=./prisma/schema.prisma && next start`
# (the migrate is a no-op here - the bot owns migrations; prisma takes an
# advisory lock so it is safe regardless).
CMD ["sh", "-c", "npm run start -- -p ${PORT:-3000}"]
