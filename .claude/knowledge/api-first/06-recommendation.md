---
date: 2026-10-18
sources:
  - 01-versions-and-compat.md, 02-benchmarks.md, 03-coexistence-and-migration.md, 04-prisma-hot-paths.md, 05-caching.md (this topic; their sources apply)
  - https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-7
  - https://www.prisma.io/docs/orm/release-status
  - ~/.claude/planning/api-first/EXECUTION_PLAN.md (ws04 shape)
confidence: high that a data-layer swap buys no user-visible gain (own benchmark plus live timings agree); medium on leaf estimates (no Prisma 7 upgrade has been tried on this repo yet, only on a bench copy of the schema)
---

# 06 - Recommendation: data layer for API-first (ws04)

## Decision

**Stay on Prisma. Upgrade 6.19 -> 7.10.x (keep the `prisma-client-js` generator) as a wave-0 prerequisite of ws04,
then spend ws04's performance effort on response shape and caching.** No Drizzle, no Kysely now, no Prisma 8 until it
is GA and has `$extends`.

Why, in three facts:
1. Prisma 6 gets security fixes only until **2026-11-19**. The upgrade is forced on a one-month clock regardless.
2. ORM overhead is ~10 ms of ~75-80 ms server time today, and ~3 ms after Prisma 7. Kysely would save another ~2 ms per
   page. No player could notice it.
3. The slow pages ship ~940 KB of uncached, force-dynamic RSC payload per request. That is where the time goes.

## Decision matrix

Scores 1 (bad) to 5 (good). Effort is in leaves of the fleet's size (one concern, 1-5 files).

| Criterion | (a) Prisma 7 + hot paths + cache | (b) (a) + Kysely for hot reads | (c) migrate to Drizzle | (d) Prisma 8 |
|---|---|---|---|---|
| User-visible speed | 4 (payload + cache is the real win) | 4 (+~2 ms/page) | 4 (same as b) | 4 (unmeasured; RC) |
| Effort | 4-7 leaves | 6-10 leaves | 15-25 leaves | rewrite-sized (~1,200 call sites) |
| Risk to live season | low (query code unchanged) | low-medium | high (migration ownership, release step) | high (RC, missing features) |
| Support horizon | to ~mid 2028 | same | 0.45 now, 1.0 still RC | best long-term, not ready |
| Fit with sync-schema and Tour | unchanged | unchanged (types from same schema) | second schema source | new CLI ignores schema.prisma |
| Type-safe SQL escape hatch | typed `$queryRaw` + zod | yes (Kysely) | yes | yes |
| **Verdict** | **Pick** | Defer: add per service only if a measured query needs it | Reject | Reject now; revisit after GA + `$extends` |

## Proposed leaves

Wave 0 (before ws04, ideally before 2026-11-19):
1. **Bot Prisma 7:** bump `prisma`/`@prisma/client` to `7.10.x` (pin, never `latest`, which is the 8 RC), add
   `@prisma/adapter-pg`, `prisma.config.ts`, explicit `dotenv` load, replace any `$use`/metrics API use in `src/db.ts`,
   set pool `max` and `connectionTimeoutMillis`. Typecheck + unit + integration tests.
2. **Web Prisma 7:** same for `web/`, plus `prisma.config.ts` handling in sync-schema (copy or keep per project).
3. **Release step and deploy check:** confirm the host's `migrate deploy` uses the pinned 7.x CLI and the config file,
   dry-run against a restored backup, then a deploy with the usual health check. Operator-owned facts, see questions.

ws04 performance leaves (inside the services extraction):
4. Standings service returns a response-shaped DTO (narrow `select`, no `player: true`), with a tagged data cache and
   revalidation from the report paths.
5. Profile service, same treatment.
6. `apiJson` ETag/304 plus Cache-Control per DESIGN.
7. Optional, measured: `statementNameGenerator` experiment, and re-time `/` and a profile on the box.

## Trade-offs accepted

- Prisma remains the heaviest client of the four (~0.33 ms/query vs ~0.07 for Kysely). Accepted: not user-visible.
- Prisma 7 changes pooling and TLS to node-pg. Needs a deliberate config check, not a code change.
- Staying on the legacy `prisma-client-js` generator means a second, smaller migration to `prisma-client` later
  (48 import sites change). It is still supported in 7.10.1. Defer it.
- Prisma 8's new API is a future rewrite risk. The ws04 service layer contains it: only services call the ORM.

## Open questions, answered 2026-10-18 (MJ + repo/infra check)

1. Release step: there is no separate host migrate step. The bot image boots with `npm start` =
   `prisma migrate deploy && node dist/index.js` (root package.json, Dockerfile.league-bot), so the CLI is the
   lockfile-pinned devDependency inside the image, never `npx prisma@latest`. Pin `prisma@7` in root package.json
   and the image follows.
2. Database URL: composed in the infra repo `infra/compose/docker-compose.yml` as
   `postgres://league:${LEAGUE_DB_PASSWORD}@postgres:5432/league` and passed as the `DATABASE_URL` env var to
   both league-web and league-bot (Tour's web gets the same URL as `LEAGUE_DATABASE_URL`). `prisma.config.ts`
   must read `process.env.DATABASE_URL`; nothing else changes on the host.
3. No CDN. Traefik on the box serves balatroleague.com directly, so public Cache-Control buys browser caching only;
   server-side caching (tagged `unstable_cache`) is where the win is.
4. The prod URLs carry no `sslmode` or other query options: plain `postgres://` over the internal Docker network.
   Nothing for adapter-pg to reinterpret.
5. UX: MJ is fine with the home page continuing to render every division's full table. Shrink the payload by
   shaping the rows (drop the full Player row), not by collapsing divisions.
6. Does the bot's slow-query `log` event subscription keep firing on Prisma 7 with adapter-pg? Check in leaf 1.
