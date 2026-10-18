---
date: 2026-10-18
sources:
  - https://registry.npmjs.org/prisma (dist-tags + time, queried 2026-10-18)
  - https://registry.npmjs.org/@prisma/client
  - https://registry.npmjs.org/drizzle-orm
  - https://registry.npmjs.org/drizzle-kit
  - https://registry.npmjs.org/kysely
  - https://registry.npmjs.org/prisma-kysely
  - https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-7
  - https://www.prisma.io/docs/orm/release-status
  - https://www.prisma.io/changelog/2026-10-02
  - https://github.com/kysely-org/kysely/releases/tag/v0.29.0
confidence: high for versions/dates/engines (read straight from the npm registry and Prisma's own release-status page); high for the Prisma 7 legacy-generator finding (reproduced locally); medium for Prisma 8 details (RC, API may still change)
---

# 01 - Versions and compatibility (as of 2026-10-18)

## Current versions

| Package | Stable | Published | Notes |
|---|---|---|---|
| prisma (CLI) | 7.10.1 (`prev` tag) | 2026-10-15 | npm `latest` = **8.0.0-rc.23** (2026-10-15). An RC sits on `latest`. |
| @prisma/client | 7.10.1 (`latest`) | 2026-10-15 | not part of v8; stays on 7.x |
| @prisma/adapter-pg | 7.10.1 | 2026-10-15 | required driver adapter for Postgres in v7 |
| prisma 6.19.3 (what we run) | -- | 2026-04-01 | last 6.x |
| prisma 7.0.0 | -- | 2025-11-19 | Rust-free client GA |
| drizzle-orm | 0.45.4 (`latest`) | 2026-10-08 | 1.0.0-rc.4 is the newest RC, published **2026-06-27**; no RC since (~4 months) |
| drizzle-kit | 0.31.11 | 2026-09-21 | |
| kysely | 0.29.7 | 2026-10-17 | 0.28.18 also published 2026-10-17 (old line still patched) |
| prisma-kysely | 3.2.1 | 2026-08-16 | peer `prisma >=7.0.0`; 2.3.0 is the Prisma 6 line (peer `>=6.2.0 <7`) |
| prisma-extension-kysely | 4.0.0 | 2026-02-25 | peer `kysely ^0.27 || ^0.28` (not 0.29 yet), `@prisma/client ^7` |
| pg | 8.23.1 | 2026-09-30 | |

Repo today: root bot `prisma`/`@prisma/client` `^6.0.0` (installed 6.19.3), web `^6.19.3`, Tour app `^6.19.3`.
`^6` ranges will never pull 7 or 8, so nothing upgrades by accident through npm install.

## Support clock (this is the forcing function)

From Prisma's release-status page:
- **Prisma 6: security patches only, until 2026-11-19** (12 months after Prisma 7). One month from today.
- Prisma 7: bug fixes and security for 18 months after Prisma 8 GA (GA "expected October 2026"), so roughly to mid 2028.
- Prisma 8: release candidate. "Some details of the API may still change."

## Engine requirements

| Package | Node engines |
|---|---|
| prisma / @prisma/client 7.10.1 | `^20.19 || ^22.12 || >=24.0` |
| prisma 8.0.0-rc.23 | `^22.18.0 || ^24.11.0 || >=26.0.0` (24.0-24.10 do NOT work), TypeScript 5.9+ |
| kysely 0.29.7 | `>=22.0.0` |
| drizzle-orm 0.45.4 | no engines field; peer `pg >=8` |

Local Node is 24.16.0; both Dockerfiles use `node:24-bookworm-slim`. All candidates are fine on Node 24.
None of them touches React; Next 16.3.8 constraints are only about bundling (server-only, Node runtime). Prisma 7's
generated client and adapter-pg run in the Node runtime that our routes already use.

## Prisma engine story

- **Prisma 6.19 (today):** `prisma-client-js` generator, Rust query engine loaded as a Node-API library; driver adapters and
  the TS "queryCompiler" were preview options.
- **Prisma 7 (stable):** Rust-free client by default. **A driver adapter is mandatory** for every database
  (`new PrismaClient({ adapter: new PrismaPg(...) })`). Other breaking changes from the official upgrade guide:
  ESM-only; `prisma.config.ts` holds datasource URL, schema path, migrations path, seed; `url`/`directUrl` in the schema
  datasource are deprecated; env vars are not auto-loaded; client middleware `$use` removed (use `$extends`); Metrics
  preview removed; `migrate dev`/`db push` no longer run generate; `db execute --url` and several `migrate diff` flags
  removed; pool defaults come from `pg` (no connection timeout by default); TLS now validated by node-pg.
- **New `prisma-client` generator** (required `output` path, import from the generated folder) is the recommended
  generator, but **`prisma-client-js` still works in 7.10.1**: verified locally on 2026-10-18 -- it generates into
  `node_modules/@prisma/client`, imports stay `from "@prisma/client"`, and the only code change is passing an adapter
  (constructing without one throws "A driver adapter is required"). The docs say prisma-client-js "will be removed in
  future releases".
- **Prisma 8 (RC):** a different product shape. CLI "does not read schema.prisma" (it can import a Prisma 7 schema via
  `prisma orm init --from-prisma7-schema`), per-database library `@prisma/orm-postgres`, and a new query API
  (`prisma.user.findMany({ where })` becomes `db.orm.public.User.where(...).all()`). Not yet available in v8:
  `$extends`, JSON-path filters, atomic `increment`, most nested writes, transaction isolation levels, P2002-style error
  codes. Moving to 8 is a query rewrite comparable to moving to another ORM.

## What upgrade cost means here

Repo surface (counted 2026-10-18): about 446 Prisma model calls in 68 bot/scripts files and about 771 in 122 web files;
48 files import from `@prisma/client`; 2 client constructors (`src/db.ts`, `web/lib/prisma.ts`); the bot already uses
`$extends` (metrics), not `$use`; 1 file uses `Prisma.sql` helpers; 12 files use `$transaction`.

- **6 -> 7 with `prisma-client-js` kept:** constructors get an adapter, add `prisma.config.ts` to root and web, load env
  explicitly, check slow-query `log` events still fire, check the host release step's `migrate deploy` reads the config
  (see open questions). Query code is unchanged. Roughly 2-3 leaves.
- **6 -> 7 with the new `prisma-client` generator:** the above plus a codemod of 48 imports and the `output` path in the
  synced schema (both copies resolve `../generated/prisma` relative to their own schema file, so sync-schema keeps working).
  Optional follow-up; it buys a smaller bundle, not a measurable latency change (see 02).
- **6/7 -> 8:** rewrite of ~1,200 call sites plus `$extends` metrics replacement; blocked by missing features. Not now.

## Risks to flag

- `prisma@latest` is an RC. Any `npx prisma ...` that does not resolve the locally installed CLI (for example in a
  release step or a new CI job) now fetches Prisma 8, whose CLI has different commands. Pin `prisma@7` explicitly.
- Kysely 0.29 requires Node 22+ (fine) and is not yet accepted by prisma-extension-kysely's peer range.

## Maintenance signals (GitHub API, 2026-10-18)

| Repo | Last push | Open issues | Stars |
|---|---|---|---|
| prisma/prisma | 2026-10-16 | 2,773 | 47.7k |
| drizzle-team/drizzle-orm | 2026-10-18 | 2,160 | 36.1k |
| kysely-org/kysely | 2026-10-18 | 172 | 14.3k |
| valtyr/prisma-kysely | 2026-10-01 | 3 | 1.2k |

## Recommendation

Upgrade to Prisma 7.10.x keeping `prisma-client-js` first, because Prisma 6 leaves security support on 2026-11-19 and the
upgrade does not touch query code. Treat Prisma 8 and Drizzle 1.0 as not-yet-stable; revisit Prisma 8 after GA plus a
few months. Trade-off: Prisma 7 changes connection-pool and TLS behaviour (now node-pg), which needs a check on the box.
