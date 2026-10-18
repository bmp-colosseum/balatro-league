---
date: 2026-10-18
sources:
  - https://www.prisma.io/docs/orm/prisma-client/using-raw-sql/typedsql
  - https://www.prisma.io/docs/orm/prisma-client/queries/relation-queries (relationLoadStrategy)
  - https://www.prisma.io/docs/orm/prisma-client/queries/excluding-fields (omit)
  - https://www.prisma.io/docs/orm/overview/databases/postgresql (adapter-pg, pool)
  - Local type reads: @prisma/adapter-pg 7.10.1 dist/index.d.ts (PrismaPgOptions)
  - Repo reads: web/lib/standings-cache.ts, web/lib/bmp-snapshots.ts, web/app/page.tsx, web/app/profile/[id]/page.tsx
  - Live measurement 2026-10-18 of / and /profile/<id> (see 02-benchmarks.md)
confidence: high for API availability (docs plus local type definitions); medium for the payload-size diagnosis (measured sizes, root cause inferred from the code, not profiled)
---

# 04 - Hot paths inside Prisma

Ordered by expected user-visible gain at League scale. The ORM-level items are small. The payload and caching items are
where the time goes (02: server time ~75-80 ms on / and a profile, ORM overhead ~10 ms on Prisma 6, ~3 ms on 7).

## 1. Payload size (biggest lever, not an ORM issue)

- `/` is 935 KB raw (66.6 KB gzip), and a profile is 946 KB raw (51.6 KB gzip). Most of that is React Server Component
  payload: the whole standings table for every division, serialized twice (HTML plus the RSC flight data).
- `standings-cache.ts` loads `members.player: true`, the full Player row, for every member of every division, then
  passes it down. Narrowing to the columns the table renders (`select: { id, displayName, ... }`) cuts both DB bytes and
  serialized props.
- Rule for ws04 services: return DTOs shaped for the response (which the zod OpenAPI layer needs anyway), never raw
  model rows. That gives `select` discipline as a side effect.
- Pages that render every division at once should consider paginating or collapsing divisions client-side. That is a UX
  call for MJ, listed as an open question in 06.

## 2. Data-level caching for force-dynamic pages (see 05)

- Both slow pages are `force-dynamic` and recompute on every request. Standings change only when a match is reported.
- `unstable_cache` is already used in three loaders. Wrapping the standings and profile loaders with a tag
  (`standings:<seasonId>`, `player:<id>`) and invalidating from the report path removes the DB work entirely on a hit.

## 3. select / omit discipline

- `select` returns only the named fields. `omit` (GA since Prisma 6.2) drops named fields, for example
  `omit: { avatarUrl: true }`, and can be set globally on the client constructor.
- Measured effect of trimming columns is small per query at our row counts. The gain is in serialization (item 1).

## 4. Typed raw SQL for aggregate-shaped reads

- **Typed `$queryRaw`:** already used in `web/lib/bmp-snapshots.ts` with an injected `$queryRaw` seam and a row type.
  Good pattern for window functions and `DISTINCT ON`. The row type is asserted, not checked, so pair it with a zod
  parse or a test against embedded Postgres.
- **TypedSQL:** `.sql` files in `prisma/sql/`, `previewFeatures = ["typedSql"]`, `prisma generate --sql`. It produces
  real argument and result types. It is still a preview feature in 7.10 and it needs a **live database at generate
  time**. That breaks our current Docker builds and `postinstall` generate, which run without a DB. Do not adopt for
  ws04. Kysely via prisma-kysely (03) gives typed SQL without a DB at build time.

## 5. relationLoadStrategy (join vs query)

- Needs `previewFeatures = ["relationJoins"]`, still preview in 7.10. `join` uses one LATERAL/JSON query, `query` uses
  one query per relation level.
- Local benchmark: no measurable difference at our size (02). Not worth a preview flag.

## 6. Connection pool and driver (Prisma 7 adapter-pg)

- Prisma 7 hands pooling to `pg.Pool`. `new PrismaPg({ connectionString })` or `new PrismaPg(pool)` with pg defaults:
  `max` 10, no connection timeout, idle timeout 10 s (verified in pg-pool source). Prisma 6's engine pool sized itself from CPU count and had its own connect and pool timeouts (exact values not re-verified here), with a
  default that failed fast. Set `connectionTimeoutMillis` (e.g. 5000) and `max` explicitly on both web and bot, so a DB stall
  fails fast instead of hanging requests.
- `PrismaPgOptions.statementNameGenerator`: per the 7.10.1 type comments, prepared statements are **not cached** unless a
  name generator is passed. Worth a one-line experiment once the upgrade lands. Do not combine with a transaction-mode
  PgBouncer (none in our stack today as far as the repo shows).
- `onPoolError` / `onConnectionError` callbacks give the bot metrics a place to count DB connection failures.
- TLS: `sslmode` in the URL is now handled by `pg`, not the Rust engine. The box connects over the internal Docker
  network today. Confirm the prod URLs carry no `sslmode`/`sslaccept` options that `pg` reads differently.

## 7. Query count per page

- The /standings path is already batched to 2 queries. The home page and profile page query counts were not measured
  here; the bot's opt-in slow-query `log` (src/db.ts) or a Prisma `query` event counter on the box would answer it.
  Every round trip on the box costs well under 1 ms, so even 20 queries is a few ms. Payload dominates.

## Recommendation

Do items 1 and 2 as part of ws04 (they are the user-visible win), set explicit pool options during the Prisma 7 upgrade,
try `statementNameGenerator` as a measured experiment, and skip TypedSQL and relationJoins. Use typed `$queryRaw` with a
zod parse for the rare aggregate query, or Kysely if those multiply.
