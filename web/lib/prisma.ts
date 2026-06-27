// Shared Prisma client for the Next.js web app.
// Uses the schema at ../prisma/schema.prisma (same DB the Discord bot reads/writes).

import { PrismaClient } from "@prisma/client";

// Avoid creating new client instances on every hot-reload in dev
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

// Cap the connection pool. Without this Prisma defaults to cpus*2+1 per
// process, and the web pool + bot pool + any seed script together exhaust
// the test DB's max_connections ("too many clients already"). 5 is plenty
// for the web app; respects an explicit connection_limit if one is already
// on the URL (e.g. set on Railway).
function pooledDbUrl(limit: number): string | undefined {
  const base = process.env.DATABASE_URL;
  if (!base || base.includes("connection_limit")) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}connection_limit=${limit}&pool_timeout=20`;
}

// Slow-query logging is OPT-IN (LOG_SLOW_QUERIES=true) — Prisma's query-event
// emission has per-query overhead, so we DON'T want it on by default for every
// page load. Flip the env var on only when actively investigating DB latency.
const LOG_SLOW_QUERIES = process.env.LOG_SLOW_QUERIES === "true";
const SLOW_QUERY_MS = Number(process.env.SLOW_QUERY_MS ?? 150);
type PrismaQueryEvent = { duration: number; query: string; target: string };

function makePrisma(): PrismaClient {
  const client = new PrismaClient({
    datasourceUrl: pooledDbUrl(5),
    log: LOG_SLOW_QUERIES
      ? [{ emit: "event", level: "query" }, { emit: "stdout", level: "error" }]
      : process.env.NODE_ENV === "production"
        ? ["error"]
        : ["error", "warn"],
  });
  if (LOG_SLOW_QUERIES) {
    (client as unknown as { $on(e: "query", cb: (ev: PrismaQueryEvent) => void): void }).$on("query", (ev) => {
      if (ev.duration >= SLOW_QUERY_MS) console.warn(`[slow-query] ${ev.duration}ms — ${ev.query.slice(0, 240)}`);
    });
  }
  return client;
}

export const prisma = globalThis.__prisma ?? makePrisma();

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = prisma;
}
