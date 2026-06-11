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

declare global {
  // eslint-disable-next-line no-var
  var __botPrisma: PrismaClient | undefined;
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

export const prisma = globalThis.__botPrisma ??
  new PrismaClient({
    datasourceUrl: pooledDbUrl(5),
    log: process.env.NODE_ENV === "production" ? ["error"] : ["error", "warn"],
  });

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
