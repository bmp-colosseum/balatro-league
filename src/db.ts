// Prisma client for the bot. Cached on globalThis so dev hot-reload
// (tsx watch) doesn't leak a new client every time the process
// re-evaluates this file. In production each container starts fresh,
// so the global cache is a no-op there but keeps dev healthy.
//
// Graceful shutdown: $disconnect on SIGTERM/SIGINT so Postgres reaps
// connections immediately on Railway deploys instead of leaving them
// idle until the timeout kicks in.

import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __botPrisma: PrismaClient | undefined;
}

export const prisma = globalThis.__botPrisma ??
  new PrismaClient({
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
