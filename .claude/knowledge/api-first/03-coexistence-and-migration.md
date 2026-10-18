---
date: 2026-10-18
sources:
  - https://github.com/valtyr/prisma-kysely
  - https://registry.npmjs.org/prisma-kysely (3.2.1 peer prisma >=7; 2.3.0 peer prisma >=6.2 <7)
  - https://registry.npmjs.org/prisma-extension-kysely (4.0.0 peer kysely ^0.27||^0.28, @prisma/client ^7)
  - https://registry.npmjs.org/drizzle-prisma-generator (0.1.7, last publish 2024-08-13)
  - https://orm.drizzle.team/docs/drizzle-kit-pull
  - Repo reads: web/scripts/sync-schema.mjs, prisma/schema.prisma, src/db.ts, web/lib/prisma.ts, D:/balatro-team-tour/apps/tour/lib/league-db.ts
confidence: high for the Kysely path and the repo facts; medium for the Drizzle path (introspection docs are thin on Prisma-managed schemas; Drizzle's Prisma-extension doc page returned 404 so it is unverified)
---

# 03 - Coexistence and migration cost

## Facts about our schema that matter for any second client

- 36 models, 8 enums, 7 Json columns, 117 migrations in `prisma/migrations`, applied by the host release step.
- 30 fields use `@default(cuid())` and 12 use `@updatedAt`. Both are generated in the Prisma client, **not in the
  database**. Any non-Prisma INSERT/UPDATE must supply ids and `updatedAt` itself. Reads are unaffected.
- Physical names are Prisma's defaults (PascalCase tables, camelCase quoted columns). The Tour reads League tables with
  raw SQL through a `pg` pool and a `tour_ro` SELECT-only role (`apps/tour/lib/league-db.ts`). **The Tour depends on
  table and column names, not on the League ORM.** Any data-layer choice is invisible to the Tour as long as no
  migration renames things.

## Kysely beside Prisma (works today, low risk)

- **Types:** add a `prisma-kysely` generator block to `prisma/schema.prisma`. It emits a Kysely `DB` type from the same
  schema on every `prisma generate`, so the two can never drift. Version must follow Prisma: 2.3.0 for Prisma 6,
  3.x for Prisma 7. Enums become string unions; Json columns become a JSON type you narrow with zod at the edge.
- **Migrations:** stay 100% Prisma. Kysely has its own migrator; we would not use it.
- **Connection:** either a separate `new Kysely({ dialect: new PostgresDialect({ pool }) })` with its own small pg pool,
  or `prisma-extension-kysely` (runs Kysely queries through Prisma's connection, so they join `$transaction`). The
  extension's 4.0.0 peer range is `kysely ^0.27 || ^0.28`, so it would mean pinning Kysely 0.28.18 (patched 2026-10-17)
  until it accepts 0.29.
- **sync-schema:** the web copy is a byte copy of the root schema, so a generator block added at the root appears in web
  too, and web's postinstall generate writes web's own Kysely types relative to `web/prisma/`. No new sync entry needed.
- **Moving one hot service:** yes. ws04 puts every read behind a service function, so a service can switch its internals
  from `prisma.x.findMany` to a Kysely query without any caller changing. That is the main architectural enabler, and it
  exists whichever library is chosen.
- Kysely 0.29 also ships `ReadonlyKysely<DB>`, a compile-time read-only instance. Good fit for a read-only public API
  surface.

## Drizzle beside Prisma (possible, but two schema sources of truth)

- **Schema:** `drizzle-kit pull` introspects the live DB into a `schema.ts` (filters: `tablesFilter`, `schemaFilter`).
  Our app-side defaults (`cuid()`, `@updatedAt`) are invisible to introspection, so they must be hand-added as
  `$defaultFn` or every insert breaks. Relations have to be declared again for relational queries.
- `drizzle-prisma-generator` (generate Drizzle schema from schema.prisma) last published 2024-08-13: stale, do not use.
- **Migrations:** either keep Prisma migrations and re-run `pull` after each one (drift risk every migration), or cut over
  to drizzle-kit with a baseline (`pull --init`) and stop using Prisma migrate. The second is a one-way door touching the
  host release step.
- **sync-schema:** a Drizzle `schema.ts` would need to be added to the SYNC list (bot source of truth, as with the
  engine cores), or live in one place both import.
- **Moving one hot service:** possible, same service-layer argument as Kysely, but you pay the schema duplication for
  every table that service touches.

## Full migration to Drizzle (or Prisma 8)

- ~446 model calls in 68 bot/scripts files plus ~771 in 122 web files, 12 files with `$transaction`, the bot's metrics
  `$extends`, slow-query log events, 117 migrations' ownership, the release step, and every test that seeds via Prisma.
- Estimate: 15-25 leaves over 3-4 waves, mostly mechanical but every one touches live-season code paths.
- Drizzle 1.0 is still RC (last RC 2026-06-27); migrating now means either 0.45 (then a second migration to 1.0's
  relational-query v2 API) or an RC.
- Prisma 8 has the same rewrite cost (new query API) plus missing features today (`$extends`, nested writes, isolation
  levels, P2002 codes).
- User-visible gain over Prisma 7: ~2-4 ms per page (see 02).

## What breaks the sync-schema copy pattern

- Nothing in the Kysely path.
- Prisma 7: `prisma.config.ts` is per project (root and web each need one; it is small and not part of the schema, so
  either duplicate it or add it to SYNC). If the new `prisma-client` generator is adopted, `output = "../generated/prisma"`
  resolves relative to each schema copy, so both projects get their own client; imports change in 48 files.
- Drizzle: a new synced `schema.ts`, plus whatever `pull` regenerates after each migration.

## Recommendation

Keep Prisma as the single schema and migration owner. If a service ever needs SQL Prisma cannot express well, add Kysely
through `prisma-kysely` for that service only (after the Prisma 7 upgrade, so prisma-kysely 3.x applies). Do not run
Drizzle beside Prisma: it doubles the schema and adds drift on every migration for no measured gain.
