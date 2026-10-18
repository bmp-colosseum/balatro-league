---
date: 2026-10-18
sources:
  - https://www.prisma.io/blog/prisma-7-performance-benchmarks (2025-12-16)
  - https://benchmarks.prisma.io/ (Prisma 7 vs Prisma Next vs pg, no date shown)
  - https://www.prisma.io/blog/prisma-next-performance-benchmark
  - https://orm.drizzle.team/benchmarks (self-titled "Biased benchmarks")
  - https://github.com/prisma/prisma/issues/28845 (Prisma 7 tight-loop regression)
  - Local benchmark run 2026-10-18 (scripts in the session scratchpad, method below)
  - Live timing of https://balatroleague.com/ with curl, 2026-10-18
confidence: medium -- vendor numbers are vendor-run under saturation load; our local benchmark is honest but single-machine (Windows laptop, embedded Postgres 18.4 on localhost, zero network), so absolute numbers are a floor and only the RATIOS transfer. No independent third-party benchmark covering Prisma 7 + Drizzle + Kysely exists (searched).
---

# 02 - Measured runtime overhead

## What the vendors publish

- **Prisma (benchmarks.prisma.io, fork of drizzle-benchmarks):** at 6,000-7,000 req/s, Prisma 7 p95 41.8 ms vs raw pg
  1.9 ms vs Prisma Next/8 4.4 ms; Prisma 7 peak 8,260 req/s = 58% of raw pg; Prisma 8 reaches 87%. These are numbers
  near Prisma 7's saturation point. They say nothing about a single request at low load.
- **Prisma blog 2025-12-16:** Prisma 7 is up to 3x faster than 6 on large result sets (no Rust-to-JS handoff) but
  slower than 6 on tight loops of tiny queries because of a per-query compile step (issue 28845). The fix landed in 8,
  not 7. No millisecond figures.
- **Drizzle (orm.drizzle.team/benchmarks):** ~4.6k req/s at ~100 ms p95 on an i3 box, versus Prisma 7.1/7.8; the
  dashboard did not render numeric Prisma results when fetched. Self-labelled "biased".
- League traffic is a few requests per second at peak, so saturation-throughput numbers are irrelevant. What matters is
  per-query client overhead at low concurrency, which we measured.

## Local benchmark (2026-10-18)

Method: embedded Postgres 18.4 (the repo's `embedded-postgres` dependency) seeded with 400 players, 1,500 matches,
3,000 games (one season's shape). One "page" = 10 sequential queries shaped like a profile/standings page: player
batch by id list, a division's matches with games, status groupBy, player by id, one player's matches with both players
and games, top-50 by mmr, all 1,500 matches (6 columns), game count, latest match, all 400 players (full rows).
Each library: pool max 10, 30 warm-up pages, 300 measured pages, 3 alternating rounds, median of round medians.
Node 24.16.0 on Windows 11. Same SQL semantics in every library (nested relations as JSON subqueries for
pg/Kysely, relational queries for Drizzle, `include` for Prisma).

| Library | Process start to first page done (ms) | Page p50 (ms) | Page p95 (ms) | Overhead per query vs raw pg (ms) |
|---|---|---|---|---|
| pg 8.23.1 raw SQL | 106 | 5.30 | 6.42 | 0 |
| Kysely 0.29.7 | 258 | 6.03 | 8.70 | ~0.07 |
| Drizzle 0.45.4 (relational queries) | 432 | 7.29 | 8.81 | ~0.20 |
| Prisma 7.10.1 + adapter-pg, `prisma-client` generator | 288 | 8.64 | 12.35 | ~0.33 |
| Prisma 7.10.1 + adapter-pg, legacy `prisma-client-js` | 283 | 12.57 | 16.76 | see note |
| Prisma 6.19.3 (Rust engine), what we run | 140 | 15.61 | 18.88 | ~1.03 |

Relation strategy inside Prisma made no difference at this size: Prisma 6 join 15.98 / query 16.07; Prisma 7 join 8.59 /
query 8.39 ms.

Note on the legacy generator row: it was measured in a separate later batch. A final interleaved round (machine
noisier, all numbers ~1.5x higher) gave Prisma 7 new generator 15.1-15.3, legacy generator 14.0-17.2, Prisma 6
22.3-23.9, Kysely 10.3-11.2 ms. So the two Prisma 7 generators are within noise of each other, and the ordering
Kysely < Prisma 7 < Prisma 6 held in every round.

Memory: heap after the run was pg 9 MB, Drizzle 13, Kysely 30, Prisma 7 25-99 (varied run to run), Prisma 6 81.
Windows working-set (RSS) was 200-270 MB for every library except raw pg (62 MB) and is not a reliable comparator
here; no box measurement was taken. At a few hundred MB per container on the Netcup box this is not decision-relevant.

Cold start (process start to first page) is 100-450 ms for everything. Our bot and web are long-lived containers that
start once per deploy, so cold start does not reach users.

## What it means for a League page

Live measurements, 2026-10-18, curl from MJ-PC, 5 samples each:

| URL | Server time + 1 RTT (median) | Body gzip | Body raw |
|---|---|---|---|
| /api/health (`SELECT 1`) | 37 ms | 55 B | -- |
| / (home = full standings) | 119 ms | 66.6 KB | 935 KB |
| /profile/<id> | ~116 ms | 51.6 KB | 946 KB |

TCP connect is ~40 ms, so the health endpoint is essentially pure round trip, and the home and profile pages spend
roughly **75-80 ms of server time**, all `force-dynamic`, with `Cache-Control: private, no-store`.

Translating the benchmark: a 10-query page carries ~10 ms of Prisma 6 client overhead, ~3 ms on Prisma 7, ~1 ms on
Kysely. On a 75-80 ms server render that is at most ~13% of server time today, ~4% after Prisma 7, and Kysely would save
a further ~2 ms (under 3%). Pages that run more queries scale linearly (20 queries on Prisma 6 = ~20 ms). The standings
loader is already 2 queries (cached payload + player batch) in `web/lib/standings-cache.ts`, so its ORM cost is small;
the rest of the 75-80 ms is rendering and serializing ~940 KB of HTML/RSC payload, plus the phone has to parse it.

Conclusion: query shape, payload size and caching dominate. The ORM choice is worth a few milliseconds per page, and
almost all of that is captured by the Prisma 6 -> 7 upgrade alone.

## Recommendation

Do not choose a data layer on speed. Take the free ~2x per-query improvement by upgrading to Prisma 7, then spend effort
on payload size and caching (04, 05). Trade-off: these are laptop numbers; re-measure one page on the box after the
Prisma 7 upgrade to confirm (open question).
