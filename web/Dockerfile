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
# Cache web's install: copy its manifests + the repo inputs its postinstall
# (sync-schema, then prisma generate) reads, so a web app-source edit doesn't
# bust `npm ci`. sync-schema falls back to committed copies for anything absent.
COPY web/package.json web/package-lock.json ./web/
COPY web/scripts ./web/scripts
COPY web/prisma ./web/prisma
COPY prisma/schema.prisma ./prisma/schema.prisma
COPY src/data ./src/data
COPY src/assets/balatro ./src/assets/balatro
COPY src/elowen.ts src/schedule.ts src/owen-placement.ts ./src/
RUN --mount=type=cache,target=/root/.npm cd web && npm ci
COPY . .
# COPY . . clobbers the deps-layer's synced web/lib copies, so re-sync from the
# now-complete source (cheap file copies; no second `npm ci`) before building.
RUN cd web && node scripts/sync-schema.mjs
RUN cd web && npm run build

# ---- runtime (standalone) ----
FROM base AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# Next's standalone server binds to $HOSTNAME; Docker sets that to the container
# id (unroutable), so force 0.0.0.0 to listen on all interfaces.
ENV HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app/web
# The self-contained bundle: server.js + traced node_modules. static/ and public/
# are NOT included by standalone, so copy them alongside.
COPY --from=build /app/web/.next/standalone ./
COPY --from=build /app/web/.next/static ./.next/static
COPY --from=build /app/web/public ./public
# Prisma's query engine can miss output tracing; copy it explicitly so runtime
# queries work regardless.
COPY --from=build /app/web/node_modules/.prisma ./node_modules/.prisma
EXPOSE 3000
# No curl in this slim image -- probe with node itself. Polled by Docker directly (feeds
# `docker inspect --format '{{.State.Health.Status}}'`, which the deploy workflow's rolling
# league-web-a/league-web-b sequence waits on -- see .github/workflows/deploy.yml and
# app/api/health/route.ts).
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# The bot owns league migrations (applied on its own boot), so web just serves.
CMD ["node", "server.js"]
