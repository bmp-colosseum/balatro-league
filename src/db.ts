// Prisma client for the bot. Cached on globalThis so dev hot-reload
// (tsx watch) doesn't leak a new client every time the process
// re-evaluates this file. In production each container starts fresh,
// so the global cache is a no-op there but keeps dev healthy.
//
// Graceful shutdown: $disconnect on SIGTERM/SIGINT so Postgres reaps
// connections immediately on Railway deploys instead of leaving them
// idle until the timeout kicks in.

import { PrismaClient } from "@prisma/client";
import { env } from "./env.js";
import { dbQueriesTotal, dbQueryDurationSeconds } from "./metrics.js";

// $extends changes the client type, so the exported/cached type is derived
// from the factory rather than naming PrismaClient directly.
type BotPrismaClient = ReturnType<typeof makePrisma>;

declare global {
  // eslint-disable-next-line no-var
  var __botPrisma: BotPrismaClient | undefined;
}

// Cap Prisma's pool. Railway's tier shares ~22 Postgres connections between
// the bot (Prisma + pg-boss max:3), the web app, and any seed scripts — and
// Prisma otherwise defaults to cpus*2+1 per process, which exhausts it ("too
// many clients already"). 5 here + 3 for pg-boss keeps the bot well under
// budget. Respects an explicit connection_limit already on the URL.
function pooledDbUrl(limit: number): string {
  const base = env.DATABASE_URL;
  if (base.includes("connection_limit")) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}connection_limit=${limit}&pool_timeout=20`;
}

// Slow-query logging is OPT-IN (LOG_SLOW_QUERIES=true). Prisma's query-event
// emission adds per-query overhead, so it's off by default; flip the env var on
// only while investigating DB latency. Query text only (no params).
const LOG_SLOW_QUERIES = process.env.LOG_SLOW_QUERIES === "true";
const SLOW_QUERY_MS = Number(process.env.SLOW_QUERY_MS ?? 150);
type PrismaQueryEvent = { duration: number; query: string; target: string };

function makePrisma() {
  const client = new PrismaClient({
    datasourceUrl: pooledDbUrl(5),
    log: LOG_SLOW_QUERIES
      ? [{ emit: "event", level: "query" }, { emit: "stdout", level: "error" }]
      : process.env.NODE_ENV === "production"
        ? ["error"]
        : ["error", "warn"],
  });
  if (LOG_SLOW_QUERIES) {
    // $on must attach to the BASE client -- extended clients don't expose it.
    (client as unknown as { $on(e: "query", cb: (ev: PrismaQueryEvent) => void): void }).$on("query", (ev) => {
      if (ev.duration >= SLOW_QUERY_MS) console.warn(`[slow-query] ${ev.duration}ms — ${ev.query.slice(0, 240)}`);
    });
  }
  // Per-query Prometheus timing. Synchronous in-memory observes hung off the
  // promise the query already returns -- no extra awaits on the query path.
  // model is undefined for raw ops ($queryRaw/$executeRaw) -> labeled "raw".
  return client.$extends({
    query: {
      $allOperations({ model, operation, args, query }) {
        const start = Date.now();
        const labels = { model: model ?? "raw", operation };
        // Guarded: a prom-client label mismatch throws, and an instrumentation
        // bug must never fail the query it's measuring.
        const record = () => {
          try {
            dbQueryDurationSeconds.observe(labels, (Date.now() - start) / 1000);
            dbQueriesTotal.inc(labels);
          } catch (err) {
            console.warn("[metrics] db observe failed:", err);
          }
        };
        return query(args).then(
          (result) => {
            record();
            return result;
          },
          (err: unknown) => {
            record();
            throw err;
          },
        );
      },
    },
  });
}

export const prisma = globalThis.__botPrisma ?? makePrisma();

if (process.env.NODE_ENV !== "production") {
  globalThis.__botPrisma = prisma;
}

// Best-effort cleanup so the next deploy doesn't have to wait for
// Postgres's connection timeout to reap our slots. Idempotent — safe
// to call multiple times.
let disconnected = false;
async function shutdown() {
  if (disconnected) return;
  disconnected = true;
  try {
    await prisma.$disconnect();
  } catch {
    // ignore — we're shutting down anyway
  }
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
