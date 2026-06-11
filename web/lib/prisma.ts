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

export const prisma =
  globalThis.__prisma ??
  new PrismaClient({
    datasourceUrl: pooledDbUrl(5),
    log: process.env.NODE_ENV === "production" ? ["error"] : ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = prisma;
}
