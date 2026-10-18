// Shared Prisma client for the Next.js web app.
// Uses the schema at ../prisma/schema.prisma (same DB the Discord bot reads/writes).

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { poolConfigFor } from "./prisma-pool";

// Avoid creating new client instances on every hot-reload in dev
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

// Pool sizing lives in prisma-pool.ts (max 5 per container; bot 5 + pg-boss 3,
// two web containers during a roll -- same budget as before the adapter). The
// adapter owns the pool built from that plain config.

// Slow-query logging is OPT-IN (LOG_SLOW_QUERIES=true) — Prisma's query-event
// emission has per-query overhead, so we DON'T want it on by default for every
// page load. Flip the env var on only when actively investigating DB latency.
const LOG_SLOW_QUERIES = process.env.LOG_SLOW_QUERIES === "true";
const SLOW_QUERY_MS = Number(process.env.SLOW_QUERY_MS ?? 150);
type PrismaQueryEvent = { duration: number; query: string; target: string };

function makePrisma(): PrismaClient {
  const client = new PrismaClient({
    adapter: new PrismaPg(poolConfigFor(process.env.DATABASE_URL), {
      // Idle-pool / connection errors must be logged, never crash the server.
      onPoolError: (err) => console.error("[db] pool error:", err.message),
      onConnectionError: (err) => console.error("[db] connection error:", err.message),
    }),
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
